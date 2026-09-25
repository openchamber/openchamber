import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { getProviderSources, getStoredProviderConfig, upsertProviderConfig } from './opencodeConfig';
import { getProviderAuth } from './opencodeAuth';
import { OpenCode } from '@opencode/client';
import { asSessionId, asSessionIdList, asSessionMetadata, asTimestamp, parseJson, type JsonValue, type SessionMetadataOnOpenCode, type SessionStateStore } from './openchamberSessionState';
import type { OpenCodeManager } from './opencode';
import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './quotaProviders';
import { credentialStatus, deleteCredential, importCursorCredential, normalizeCredential, readCredential, validateCredential, writeCredential, type ManagedProvider } from './quotaCredentials';
import { getSessionActivitySnapshot } from './sessionActivityWatcher';
import { getOpenCodeUpgradeStatus, upgradeManagedOpenCode } from './opencode-upgrade-runtime';
import { normalizeWindowsDriveLetter, pathsEqualWithNormalizedDriveLetter } from './pathUtils';
import { resolveWorkspaceFolders } from './workspaceResolver';
import { reconstructOriginalContentFromPatch } from './patchReconstruction';
import type { BridgeContext, BridgeResponse } from './bridge';

const isSessionNotFound = (error: Error): boolean => error.name === 'SessionNotFoundError';

/** Session metadata on the OpenCode instance this window manages. */
const sessionMetadataOnOpenCode = (manager: OpenCodeManager | undefined): SessionMetadataOnOpenCode => {
  const apiUrl = manager?.getApiUrl();
  if (!manager || !apiUrl) throw new Error('OpenCode is not available');
  const client = OpenCode.make({ baseUrl: apiUrl.replace(/\/+$/, ''), headers: manager.getOpenCodeAuthHeaders() });
  return {
    read: async (sessionID) => {
      try {
        const session = await client.session.get({ sessionID });
        // Round-trip through JSON: the wire type is opaque JSON, the store's is `JsonValue`.
        return asSessionMetadata(parseJson(JSON.stringify(session.metadata ?? {})) ?? undefined) ?? {};
      } catch (error) {
        if (error instanceof Error && isSessionNotFound(error)) return null;
        throw error;
      }
    },
    write: (sessionID, metadata) => client.session.update({ sessionID, metadata }),
  };
};

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type SystemRuntimeDeps = {
  resolveUserPath: (value: string, baseDirectory: string) => string;
  sessionState: SessionStateStore;
  fetchModelsMetadata: () => Promise<unknown>;
  updateCheckUrl: string;
  clientReloadDelayMs: number;
};

const NOTIFICATION_CLAIM_TTL_MS = 10_000;
const notificationClaims = new Map<string, number>();

const claimNotification = (key: string): boolean => {
  const now = Date.now();
  for (const [claimKey, claimedAt] of notificationClaims) {
    if (now - claimedAt > NOTIFICATION_CLAIM_TTL_MS) {
      notificationClaims.delete(claimKey);
    }
  }

  const existing = notificationClaims.get(key);
  if (existing && now - existing <= NOTIFICATION_CLAIM_TTL_MS) {
    return false;
  }

  notificationClaims.set(key, now);
  return true;
};


const getOpenChamberConfigDir = (): string => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }
  return path.join(os.homedir(), '.config', 'openchamber');
};

const sanitizeInstallScope = (scope: string): 'vscode' | 'web' => {
  if (scope === 'vscode' || scope === 'web') return scope;
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

const mapNodePlatformToApiPlatform = (value: string): 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'web' => {
  // The webview already sends API-shaped values; Node's os.platform() is the fallback source.
  if (value === 'macos' || value === 'windows' || value === 'linux' || value === 'android' || value === 'ios' || value === 'web') {
    return value;
  }
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  return 'web';
};

const mapNodeArchToApiArch = (value: string): 'arm64' | 'x64' | 'unknown' => {
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x64' || value === 'amd64') return 'x64';
  return 'unknown';
};

const VIRTUAL_DIFF_SCHEME = 'openchamber-diff';
const virtualDiffContents = new Map<string, string>();
let virtualDiffCounter = 0;
let virtualDiffProviderDisposable: vscode.Disposable | null = null;

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

const fetchFreeZenModels = async (): Promise<Array<{ id: string; owned_by?: string }>> => [];

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
        ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
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

    case 'api:opencode/version': {
      try {
        const apiUrl = ctx?.manager?.getApiUrl();
        if (!apiUrl) {
          return { id, type, success: true, data: { version: null, error: 'OpenCode manager unavailable' } };
        }
        const base = `${apiUrl.replace(/\/+$/, '')}/`;
        // OpenCode 2.0.8 replaced `/api/health` with `/api/info`.
        const response = await fetch(new URL('api/info', base).toString(), {
          method: 'GET',
          headers: { Accept: 'application/json', ...ctx?.manager?.getOpenCodeAuthHeaders() },
        });
        const health = await response.json().catch(() => null) as { version?: unknown; error?: unknown } | null;
        if (!response.ok) {
          const message = typeof health?.error === 'string' ? health.error : response.statusText || 'Failed to read OpenCode version';
          return { id, type, success: true, data: { version: null, error: message } };
        }
        const version = typeof health?.version === 'string' && health.version.trim().length > 0
          ? health.version.trim().replace(/^v/, '')
          : null;
        return { id, type, success: true, data: { version } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: true, data: { version: null, error: errorMessage } };
      }
    }

    case 'api:opencode/compatibility': {
      return { id, type, success: true, data: await ctx?.manager?.getCompatibility() };
    }

    case 'api:opencode/install-v2': {
      if (!ctx?.manager) return { id, type, success: false, error: 'OpenCode manager is unavailable.' };
      await ctx.manager.installV2();
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:opencode/upgrade-status': {
      return { id, type, success: true, data: await getOpenCodeUpgradeStatus(ctx?.manager) };
    }

    case 'api:opencode/upgrade': {
      return { id, type, success: true, data: await upgradeManagedOpenCode(ctx?.manager) };
    }

    case 'api:session-activity:get': {
      return { id, type, success: true, data: getSessionActivitySnapshot() };
    }

    case 'api:notifications:claim': {
      const key = typeof (payload as { key?: unknown } | undefined)?.key === 'string'
        ? (payload as { key: string }).key.trim()
        : '';
      return { id, type, success: true, data: { claimed: key ? claimNotification(key) : false } };
    }

    case 'api:zen:models': {
      const models = await fetchFreeZenModels();
      return { id, type, success: true, data: { models } };
    }

    case 'api:openchamber:update-check': {
      try {
        const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
        const currentVersion = typeof body.currentVersion === 'string' && body.currentVersion.trim().length > 0
          ? body.currentVersion.trim()
          : String(ctx?.context?.extension?.packageJSON?.version || 'unknown');
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

        const requestBody = {
          appType: 'vscode',
          deviceClass,
          platform: mapNodePlatformToApiPlatform(platformRaw),
          arch: mapNodeArchToApiArch(archRaw),
          channel: 'stable',
          currentVersion,
          ...(reportUsage ? { installId: getOrCreateInstallId('vscode') } : {}),
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
        const options: vscode.TextDocumentShowOptions = {};
        if (typeof line === 'number') {
          const pos = new vscode.Position(Math.max(0, line - 1), column || 0);
          options.selection = new vscode.Range(pos, pos);
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), options);
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

    // OpenChamber-owned session state. OpenCode 2.x has no route that sets
    // `time.archived` or rewrites metadata after creation; the web server keeps
    // both in files, and the extension host keeps the same files (see
    // openchamberSessionState.ts). The proxy runtime folds them back onto
    // session reads.
    case 'api:sessions/archive': {
      const { ids, archivedAt } = (payload || {}) as { ids?: JsonValue; archivedAt?: JsonValue };
      const targets = asSessionIdList(ids);
      if (targets.length === 0) return { id, type, success: false, error: 'ids must be a non-empty array of session ids' };
      return { id, type, success: true, data: await deps.sessionState.archive(targets, asTimestamp(archivedAt)) };
    }

    case 'api:sessions/unarchive': {
      const { ids } = (payload || {}) as { ids?: JsonValue };
      const targets = asSessionIdList(ids);
      if (targets.length === 0) return { id, type, success: false, error: 'ids must be a non-empty array of session ids' };
      return { id, type, success: true, data: await deps.sessionState.unarchive(targets) };
    }

    case 'api:sessions/metadata:get': {
      const sessionId = asSessionId(((payload || {}) as { sessionId?: JsonValue }).sessionId);
      if (!sessionId) return { id, type, success: false, error: 'a session id is required' };
      try {
        return { id, type, success: true, data: { metadata: await deps.sessionState.getMetadata(sessionId, sessionMetadataOnOpenCode(ctx?.manager)) } };
      } catch (error) {
        return { id, type, success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    case 'api:sessions/metadata:set': {
      const body = (payload || {}) as { sessionId?: JsonValue; patch?: JsonValue };
      const sessionId = asSessionId(body.sessionId);
      if (!sessionId) return { id, type, success: false, error: 'a session id is required' };
      const patch = asSessionMetadata(body.patch);
      if (!patch) return { id, type, success: false, error: 'patch must be an object' };
      try {
        return { id, type, success: true, data: { metadata: await deps.sessionState.setMetadata(sessionId, patch, sessionMetadataOnOpenCode(ctx?.manager)) } };
      } catch (error) {
        return { id, type, success: false, error: error instanceof Error ? error.message : String(error) };
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
        const config = getStoredProviderConfig(providerId, workingDirectory);
        return { id, type, success: true, data: { providerId, sources, config } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'api:provider:upsert': {
      const {
        providerID,
        providerId: providerIdAlias,
        config,
        scope,
        directory,
      } = (payload || {}) as {
        providerID?: string;
        providerId?: string;
        config?: unknown;
        scope?: string;
        directory?: string;
      };
      const providerId = (typeof providerID === 'string' && providerID.trim())
        || (typeof providerIdAlias === 'string' && providerIdAlias.trim())
        || '';
      if (!providerId) {
        return { id, type, success: false, error: 'Provider ID is required' };
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { id, type, success: false, error: 'Provider config is required' };
      }
      const normalizedScope = typeof scope === 'string' ? scope : 'user';
      if (normalizedScope !== 'user' && normalizedScope !== 'project' && normalizedScope !== 'custom') {
        return { id, type, success: false, error: 'Invalid scope' };
      }
      try {
        const workingDirectory = typeof directory === 'string' && directory.trim().length > 0
          ? directory.trim()
          : ctx?.manager?.getWorkingDirectory();
        const result = upsertProviderConfig(
          providerId,
          config,
          workingDirectory,
          normalizedScope,
          { hasStoredAuth: Boolean(getProviderAuth(providerId)) },
        );
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            providerId: result.providerId,
            path: result.path,
            config: result.config,
            requiresReload: true,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
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

    case 'api:quota:credentials': {
      const { providerId, method, credential: input } = (payload || {}) as { providerId?: ManagedProvider; method?: string; credential?: unknown };
      try {
        if (!providerId || !['exe-dev', 'ollama-cloud', 'cursor'].includes(providerId)) return { id, type, success: false, error: 'Unsupported credential provider' };
        if (method === 'GET') return { id, type, success: true, data: credentialStatus(providerId) };
        if (method === 'DELETE') { deleteCredential(providerId); return { id, type, success: true, data: { configured: false } }; }
        if (method === 'IMPORT') {
          if (providerId !== 'cursor') return { id, type, success: false, error: 'Import unavailable' };
          const credential = importCursorCredential();
          await validateCredential(providerId, credential);
          return { id, type, success: true, data: writeCredential(providerId, credential) };
        }
        if (method === 'PUT') {
          const credential = normalizeCredential(providerId, input);
          if (!credential) return { id, type, success: false, error: 'Invalid credential' };
          await validateCredential(providerId, credential);
          return { id, type, success: true, data: writeCredential(providerId, credential) };
        }
        if (method === 'VALIDATE') {
          const credential = readCredential(providerId);
          if (!credential) return { id, type, success: false, error: 'Not configured' };
          await validateCredential(providerId, credential);
          return { id, type, success: true, data: { valid: true } };
        }
        return { id, type, success: false, error: 'Unsupported method' };
      } catch (error) {
        return { id, type, success: false, error: error instanceof Error ? error.message : String(error) };
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

    case 'api:workspace:addFolder': {
      try {
        // SAFETY: bridge payloads are untrusted JSON from the webview; the
        // cast only reads the optional path field, and non-string values fail
        // the emptiness check below (or throw inside the try, which the catch
        // converts into a clean failure response).
        const { path: targetPath } = (payload || {}) as { path?: string };
        if (!targetPath || targetPath.trim().length === 0) {
          return { id, type, success: false, error: 'Directory path is required' };
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        const uri = vscode.Uri.file(normalizeWindowsDriveLetter(targetPath.trim()));
        // `Uri.fsPath` lowercases the Windows drive letter again, so both sides
        // have to go through the shared comparison (see pathUtils).
        const alreadyAdded = folders.some(
          (folder) => pathsEqualWithNormalizedDriveLetter(folder.uri.fsPath, uri.fsPath),
        );
        if (!alreadyAdded) {
          const updated = await vscode.workspace.updateWorkspaceFolders(folders.length, null, { uri });
          if (!updated) {
            return { id, type, success: false, error: 'Failed to add workspace folder' };
          }
        }
        return {
          id,
          type,
          success: true,
          data: { workspaceFolders: resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []) },
        };
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

    default:
      return null;
  }
}
