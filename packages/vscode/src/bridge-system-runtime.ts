import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { removeProviderConfig, getProviderSources } from './opencodeConfig';
import { getProviderAuth, removeProviderAuth } from './opencodeAuth';
import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './quotaProviders';
import { getSessionActivitySnapshot } from './sessionActivityWatcher';
import type { BridgeContext, BridgeResponse } from './bridge';
import { getActiveWorkspaceFolderPath } from './workspaceRoots';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type SystemRuntimeDeps = {
  resolveUserPath: (value: string, baseDirectory: string) => string;
  fetchModelsMetadata: () => Promise<unknown>;
  updateCheckUrl: string;
  clientReloadDelayMs: number;
};

type NotificationBridgePayload = {
  title?: string;
  body?: string;
  tag?: string;
};

type NotificationsNotifyRequestPayload = {
  payload?: NotificationBridgePayload;
};

const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const ZEN_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedZenModels: { models: Array<{ id: string; owned_by?: string }>; at: number } | null = null;

const getOpenChamberConfigDir = (): string => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }
  return path.join(os.homedir(), '.config', 'openchamber');
};

const sanitizeInstallScope = (scope: string): 'desktop-tauri' | 'vscode' | 'web' => {
  if (scope === 'desktop-tauri' || scope === 'vscode' || scope === 'web') return scope;
  return 'web';
};

const getOrCreateInstallId = (scope: string): string => {
  const configDir = getOpenChamberConfigDir();
  const normalizedScope = sanitizeInstallScope(scope);
  const idPath = path.join(configDir, `install-id-${normalizedScope}`);

  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Generate new id.
  }

  const installId = randomUUID();
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(idPath, `${installId}\n`, { encoding: 'utf8', mode: 0o600 });
  return installId;
};

const mapNodePlatformToApiPlatform = (value: string): 'macos' | 'windows' | 'linux' | 'web' => {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return 'web';
};

const mapNodeArchToApiArch = (value: string): 'arm64' | 'x64' | 'unknown' => {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
};

type ParsedDiffHunk = {
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

const VIRTUAL_DIFF_SCHEME = 'openchamber-diff';
const virtualDiffContents = new Map<string, string>();
let virtualDiffCounter = 0;
let virtualDiffProviderDisposable: vscode.Disposable | null = null;

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const ensureVirtualDiffProviderRegistered = (ctx?: BridgeContext): void => {
  if (virtualDiffProviderDisposable) {
    return;
  }

  virtualDiffProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
    VIRTUAL_DIFF_SCHEME,
    {
      provideTextDocumentContent: (uri: vscode.Uri) => {
        const key = new URLSearchParams(uri.query).get('key') || '';
        return virtualDiffContents.get(key) ?? '';
      },
    },
  );

  if (ctx?.context) {
    ctx.context.subscriptions.push(virtualDiffProviderDisposable);
  }
};

const createVirtualOriginalDiffUri = (modifiedPath: string, content: string): vscode.Uri => {
  const key = `${Date.now()}-${++virtualDiffCounter}`;
  virtualDiffContents.set(key, content);

  if (virtualDiffContents.size > 100) {
    const firstKey = virtualDiffContents.keys().next().value;
    if (firstKey) {
      virtualDiffContents.delete(firstKey);
    }
  }

  return vscode.Uri.from({
    scheme: VIRTUAL_DIFF_SCHEME,
    path: `/${path.basename(modifiedPath) || 'original'}`,
    query: `key=${encodeURIComponent(key)}`,
  });
};

const parseUnifiedDiffHunks = (patch: string): ParsedDiffHunk[] => {
  const lines = patch.split(/\r?\n/);
  const hunks: ParsedDiffHunk[] = [];

  let current: ParsedDiffHunk | null = null;

  for (const line of lines) {
    const headerMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (headerMatch) {
      if (current) {
        hunks.push(current);
      }
      current = {
        newStart: Number(headerMatch[1] || 1),
        oldLines: [],
        newLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\ No newline')) {
      continue;
    }

    if (line.startsWith('-')) {
      current.oldLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith('+')) {
      current.newLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith(' ')) {
      const content = line.slice(1);
      current.oldLines.push(content);
      current.newLines.push(content);
    }
  }

  if (current) {
    hunks.push(current);
  }

  return hunks;
};

const reconstructOriginalContentFromPatch = (modifiedContent: string, patch: string): string | null => {
  const hunks = parseUnifiedDiffHunks(patch);
  if (hunks.length === 0) {
    return null;
  }

  const lines = modifiedContent.split('\n');
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    const hunk = hunks[index];
    if (!hunk) {
      continue;
    }
    const startIndex = Math.max(0, hunk.newStart - 1);
    const replaceCount = hunk.newLines.length;
    lines.splice(startIndex, replaceCount, ...hunk.oldLines);
  }

  return lines.join('\n');
};

const fetchFreeZenModels = async (): Promise<Array<{ id: string; owned_by?: string }>> => {
  const now = Date.now();
  if (cachedZenModels && now - cachedZenModels.at < ZEN_MODELS_CACHE_TTL_MS) {
    return cachedZenModels.models;
  }

  const response = await fetch(ZEN_MODELS_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error(`zen models request failed (${response.status})`);
  }

  const rawPayload = await response.json().catch(() => null);
  const payload = asObject(rawPayload);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const models = rows
    .map((entry) => {
      const id = typeof (entry as { id?: unknown })?.id === 'string'
        ? (entry as { id: string }).id.trim()
        : '';
      const ownedBy = typeof (entry as { owned_by?: unknown })?.owned_by === 'string'
        ? (entry as { owned_by: string }).owned_by
        : undefined;
      if (!id || !id.endsWith('-free')) return null;
      return ownedBy ? { id, owned_by: ownedBy } : { id };
    })
    .filter((entry): entry is { id: string; owned_by?: string } => entry !== null);

  cachedZenModels = { models, at: Date.now() };
  return models;
};

export async function handleSystemBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: SystemRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:opencode/directory': {
      const target = (payload as { path?: string })?.path;
      if (!target) {
        return { id, type, success: false, error: 'Path is required' };
      }
      const baseDirectory =
        ctx?.manager?.getWorkingDirectory() || getActiveWorkspaceFolderPath() || os.homedir();
      const resolvedPath = deps.resolveUserPath(target, baseDirectory);
      const result = await ctx?.manager?.setWorkingDirectory(resolvedPath);
      if (!result) {
        return { id, type, success: false, error: 'OpenCode manager unavailable' };
      }
      return { id, type, success: true, data: result };
    }

    case 'api:models/metadata': {
      try {
        const data = await deps.fetchModelsMetadata();
        return { id, type, success: true, data };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:session-activity:get': {
      return { id, type, success: true, data: getSessionActivitySnapshot() };
    }

    case 'api:zen:models': {
      try {
        const models = await fetchFreeZenModels();
        return { id, type, success: true, data: { models } };
      } catch (error) {
        if (cachedZenModels) {
          return { id, type, success: true, data: { models: cachedZenModels.models } };
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:openchamber:update-check': {
      try {
        const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
        const currentVersion = typeof body.currentVersion === 'string' && body.currentVersion.trim().length > 0
          ? body.currentVersion.trim()
          : 'unknown';
        const instanceMode = typeof body.instanceMode === 'string' && body.instanceMode.trim().length > 0
          ? body.instanceMode.trim()
          : 'local';
        const deviceClass = typeof body.deviceClass === 'string' && body.deviceClass.trim().length > 0
          ? body.deviceClass.trim()
          : 'desktop';
        const platformRaw = typeof body.platform === 'string' && body.platform.trim().length > 0
          ? body.platform.trim()
          : os.platform();
        const archRaw = typeof body.arch === 'string' && body.arch.trim().length > 0
          ? body.arch.trim()
          : os.arch();
        const reportUsage = body.reportUsage !== false;

        const installId = getOrCreateInstallId('vscode');
        const requestBody = {
          appType: 'vscode',
          deviceClass,
          platform: mapNodePlatformToApiPlatform(platformRaw),
          arch: mapNodeArchToApiArch(archRaw),
          channel: 'stable',
          currentVersion,
          installId,
          instanceMode,
          reportUsage,
        };

        const response = await fetch(deps.updateCheckUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => 'update check failed');
          return { id, type, success: false, error: text || `Update check failed with ${response.status}` };
        }

        const data = await response.json();
        return { id, type, success: true, data };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'editor:openFile': {
      const { path: filePath, line, column } = payload as { path: string; line?: number; column?: number };
      try {
        const doc = await vscode.workspace.openTextDocument(filePath);
        const options: vscode.TextDocumentShowOptions = {};
        if (typeof line === 'number') {
          const pos = new vscode.Position(Math.max(0, line - 1), column || 0);
          options.selection = new vscode.Range(pos, pos);
        }
        await vscode.window.showTextDocument(doc, options);
        return { id, type, success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'editor:openDiff': {
      const { original, modified, label, line, patch } = payload as {
        original: string;
        modified: string;
        label?: string;
        line?: number;
        patch?: string;
      };
      try {
        const modifiedUri = vscode.Uri.file(modified);
        const modifiedDoc = await vscode.workspace.openTextDocument(modifiedUri);
        let originalUri = original ? vscode.Uri.file(original) : modifiedUri;

        if (typeof patch === 'string' && patch.trim().length > 0) {
          const originalContent = reconstructOriginalContentFromPatch(modifiedDoc.getText(), patch);
          if (typeof originalContent === 'string') {
            ensureVirtualDiffProviderRegistered(ctx);
            originalUri = createVirtualOriginalDiffUri(modified, originalContent);
          }
        }

        const leftLabel = original ? path.basename(original) : `${path.basename(modified)} (before)`;
        const title = label || `${leftLabel} ↔ ${path.basename(modified)}`;

        await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);

        if (typeof line === 'number' && Number.isFinite(line)) {
          const targetLine = Math.max(0, Math.trunc(line) - 1);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const targetEditor = vscode.window.visibleTextEditors.find(
            (editor) => editor.document.uri.toString() === modifiedUri.toString(),
          );
          if (targetEditor) {
            const target = new vscode.Position(targetLine, 0);
            targetEditor.selection = new vscode.Selection(target, target);
            targetEditor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
          }
        }

        return { id, type, success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/auth:delete': {
      const { providerId, scope, directory } = (payload || {}) as { providerId?: string; scope?: string; directory?: string };
      if (!providerId) {
        return { id, type, success: false, error: 'Provider ID is required' };
      }
      const normalizedScope = typeof scope === 'string' ? scope : 'auth';
      const workingDirectory = typeof directory === 'string' && directory.trim().length > 0
        ? directory.trim()
        : ctx?.manager?.getWorkingDirectory();
      try {
        let removed = false;
        if (normalizedScope === 'auth') {
          removed = removeProviderAuth(providerId);
        } else if (normalizedScope === 'user' || normalizedScope === 'project' || normalizedScope === 'custom') {
          removed = removeProviderConfig(providerId, workingDirectory, normalizedScope);
        } else if (normalizedScope === 'all') {
          const authRemoved = removeProviderAuth(providerId);
          const userRemoved = removeProviderConfig(providerId, workingDirectory, 'user');
          const projectRemoved = workingDirectory
            ? removeProviderConfig(providerId, workingDirectory, 'project')
            : false;
          const customRemoved = removeProviderConfig(providerId, workingDirectory, 'custom');
          removed = authRemoved || userRemoved || projectRemoved || customRemoved;
        } else {
          return { id, type, success: false, error: 'Invalid scope' };
        }

        if (removed) {
          await ctx?.manager?.restart();
        }
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            removed,
            requiresReload: removed,
            message: removed
              ? `Provider ${providerId} disconnected successfully. Reloading interface…`
              : `Provider ${providerId} was not configured.`,
            reloadDelayMs: removed ? deps.clientReloadDelayMs : undefined,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider/source:get': {
      const { providerId, directory } = (payload || {}) as { providerId?: string; directory?: string };
      if (!providerId) {
        return { id, type, success: false, error: 'Provider ID is required' };
      }
      try {
        const workingDirectory = typeof directory === 'string' && directory.trim().length > 0
          ? directory.trim()
          : ctx?.manager?.getWorkingDirectory();
        const sources = getProviderSources(providerId, workingDirectory);
        const auth = getProviderAuth(providerId);
        sources.auth.exists = Boolean(auth);
        return { id, type, success: true, data: { providerId, sources } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:quota:providers': {
      try {
        const providers = listConfiguredQuotaProviders();
        return { id, type, success: true, data: { providers } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:quota:get': {
      const { providerId } = (payload || {}) as { providerId?: string };
      if (!providerId) {
        return { id, type, success: false, error: 'Provider ID is required' };
      }
      try {
        const result = await fetchQuotaForProvider(providerId);
        return { id, type, success: true, data: result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'vscode:command': {
      const { command, args } = (payload || {}) as { command?: string; args?: unknown[] };
      if (!command) {
        return { id, type, success: false, error: 'Command is required' };
      }
      try {
        const result = await vscode.commands.executeCommand(command, ...(args || []));
        return { id, type, success: true, data: { result } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'vscode:openExternalUrl': {
      const { url } = (payload || {}) as { url?: string };
      const target = typeof url === 'string' ? url.trim() : '';
      if (!target) {
        return { id, type, success: false, error: 'URL is required' };
      }
      try {
        await vscode.env.openExternal(vscode.Uri.parse(target));
        return { id, type, success: true, data: { opened: true } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'notifications:can-notify': {
      return { id, type, success: true, data: true };
    }

    case 'notifications:notify': {
      const request = (payload || {}) as NotificationsNotifyRequestPayload;
      const notification = request.payload || {};
      const title = typeof notification.title === 'string' ? notification.title.trim() : '';
      const body = typeof notification.body === 'string' ? notification.body.trim() : '';

      const message = title && body
        ? `${title}: ${body}`
        : title || body;

      if (!message) {
        return { id, type, success: true, data: { shown: false } };
      }

      void vscode.window.showInformationMessage(message);
      return { id, type, success: true, data: { shown: true } };
    }

    default:
      return null;
  }
}
