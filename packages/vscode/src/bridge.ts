import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { type OpenCodeManager } from './opencode';
import { createAgent, createCommand, deleteAgent, deleteCommand, getAgentSources, getCommandSources, updateAgent, updateCommand, type AgentScope, type CommandScope, AGENT_SCOPE, COMMAND_SCOPE, discoverSkills, getSkillSources, createSkill, updateSkill, deleteSkill, readSkillSupportingFile, writeSkillSupportingFile, deleteSkillSupportingFile, type SkillScope, type SkillSource, type DiscoveredSkill, SKILL_SCOPE, getProviderSources, removeProviderConfig, listMcpConfigs, getMcpConfig, createMcpConfig, updateMcpConfig, deleteMcpConfig } from './opencodeConfig';
import { getProviderAuth, removeProviderAuth } from './opencodeAuth';
import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './quotaProviders';
import * as gitService from './gitService';
import {
  getSkillsCatalog,
  scanSkillsRepository as scanSkillsRepositoryFromGit,
  installSkillsFromRepository as installSkillsFromGit,
  type SkillsCatalogSourceConfig,
} from './skillsCatalog';
import {
  DEFAULT_GITHUB_CLIENT_ID,
  DEFAULT_GITHUB_SCOPES,
  activateGitHubAuth,
  clearGitHubAuth,
  exchangeDeviceCode,
  fetchMe,
  readGitHubAuth,
  readGitHubAuthList,
  startDeviceFlow,
  writeGitHubAuth,
} from './githubAuth';
import {
  createPullRequest,
  getPullRequestStatus,
  markPullRequestReady,
  mergePullRequest,
  updatePullRequest,
} from './githubPr';

import {
  getIssue,
  listIssueComments,
  listIssues,
} from './githubIssues';

import {
  getPullRequestContext,
  listPullRequests,
} from './githubPulls';

export interface BridgeRequest {
  id: string;
  type: string;
  payload?: unknown;
}

export interface BridgeResponse {
  id: string;
  type: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

type ApiProxyRequestPayload = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

type ApiSessionMessageRequestPayload = {
  path?: string;
  headers?: Record<string, string>;
  bodyText?: string;
};

type ApiProxyResponsePayload = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

type NotificationBridgePayload = {
  title?: string;
  body?: string;
  tag?: string;
};

type NotificationsNotifyRequestPayload = {
  payload?: NotificationBridgePayload;
};

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FileSearchResult {
  path: string;
  score?: number;
}

export interface BridgeContext {
  manager?: OpenCodeManager;
  context?: vscode.ExtensionContext;
}

const SETTINGS_KEY = 'openchamber.settings';
const CLIENT_RELOAD_DELAY_MS = 800;
const MAX_FILE_ATTACH_SIZE_BYTES = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];

const OPENCHAMBER_SHARED_SETTINGS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');

const guessMimeTypeFromExtension = (ext: string) => {
  switch (ext) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.bmp':
    case '.webp':
      return `image/${ext.replace('.', '')}`;
    case '.pdf':
      return 'application/pdf';
    case '.txt':
    case '.log':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    default:
      return 'application/octet-stream';
  }
};

const readUriAsAttachment = async (
  uri: vscode.Uri,
  fallbackName?: string,
): Promise<
  | { file: { name: string; mimeType: string; size: number; dataUrl: string } }
  | { skipped: { name: string; reason: string } }
> => {
  const name = path.basename(uri.fsPath || uri.path || fallbackName || 'file');

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      return { skipped: { name, reason: 'Folders are not supported' } };
    }

    const size = stat.size ?? 0;
    if (size > MAX_FILE_ATTACH_SIZE_BYTES) {
      return { skipped: { name, reason: 'File exceeds 10MB limit' } };
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const ext = path.extname(name).toLowerCase();
    const mimeType = guessMimeTypeFromExtension(ext);
    const base64 = Buffer.from(bytes).toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return { file: { name, mimeType, size, dataUrl } };
  } catch (error) {
    return { skipped: { name, reason: error instanceof Error ? error.message : 'Failed to read file' } };
  }
};

const isPathInside = (candidatePath: string, parentPath: string): boolean => {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedParent = path.resolve(parentPath);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
};

const findWorktreeRootForSkills = (workingDirectory?: string): string | null => {
  if (!workingDirectory) return null;
  let current = path.resolve(workingDirectory);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const getProjectAncestors = (workingDirectory?: string): string[] => {
  if (!workingDirectory) return [];
  const result: string[] = [];
  let current = path.resolve(workingDirectory);
  const stop = findWorktreeRootForSkills(workingDirectory) || current;
  while (true) {
    result.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
};

const inferSkillScopeAndSourceFromLocation = (location: string, workingDirectory?: string): { scope: SkillScope; source: SkillSource } => {
  const resolvedPath = path.resolve(location);
  const source: SkillSource = resolvedPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
    ? 'agents'
    : resolvedPath.includes(`${path.sep}.claude${path.sep}skills${path.sep}`)
      ? 'claude'
      : 'opencode';

  const projectAncestors = getProjectAncestors(workingDirectory);
  const isProjectScoped = projectAncestors.some((ancestor) => {
    const candidates = [
      path.join(ancestor, '.opencode'),
      path.join(ancestor, '.claude', 'skills'),
      path.join(ancestor, '.agents', 'skills'),
    ];
    return candidates.some((candidate) => isPathInside(resolvedPath, candidate));
  });

  if (isProjectScoped) {
    return { scope: 'project', source };
  }

  const home = os.homedir();
  const userRoots = [
    path.join(home, '.config', 'opencode'),
    path.join(home, '.opencode'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.agents', 'skills'),
    process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null,
  ].filter((value): value is string => Boolean(value));

  if (userRoots.some((root) => isPathInside(resolvedPath, root))) {
    return { scope: 'user', source };
  }

  return { scope: 'user', source };
};

const fetchOpenCodeSkillsFromApi = async (ctx: BridgeContext | undefined, workingDirectory?: string): Promise<DiscoveredSkill[] | null> => {
  const apiUrl = ctx?.manager?.getApiUrl();
  if (!apiUrl) {
    return null;
  }

  try {
    const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
    const url = new URL('skill', base);
    if (workingDirectory) {
      url.searchParams.set('directory', workingDirectory);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(ctx?.manager?.getOpenCodeAuthHeaders() || {}),
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      return null;
    }

    return payload
      .map((item) => {
        const name = typeof item?.name === 'string' ? item.name.trim() : '';
        const location = typeof item?.location === 'string' ? item.location : '';
        const description = typeof item?.description === 'string' ? item.description : '';
        if (!name || !location) {
          return null;
        }
        const inferred = inferSkillScopeAndSourceFromLocation(location, workingDirectory);
        return {
          name,
          path: location,
          scope: inferred.scope,
          source: inferred.source,
          description,
        } as DiscoveredSkill;
      })
      .filter((item): item is DiscoveredSkill => item !== null);
  } catch {
    return null;
  }
};

const readSharedSettingsFromDisk = (): Record<string, unknown> => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SHARED_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

const writeSharedSettingsToDisk = async (changes: Record<string, unknown>): Promise<void> => {
  try {
    await fs.promises.mkdir(path.dirname(OPENCHAMBER_SHARED_SETTINGS_PATH), { recursive: true });
    const current = readSharedSettingsFromDisk();
    const next: Record<string, unknown> = { ...current, ...changes };
    // Keep empty-string sentinel (""), so other runtimes can detect explicit clears.
    await fs.promises.writeFile(OPENCHAMBER_SHARED_SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // ignore
  }
};

const readSettings = (ctx?: BridgeContext) => {
  const stored = ctx?.context?.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {};
  const restStored = { ...stored };
  delete (restStored as Record<string, unknown>).lastDirectory;
  const shared = readSharedSettingsFromDisk();
  const sharedOpencodeBinary = typeof shared.opencodeBinary === 'string' ? shared.opencodeBinary.trim() : '';
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const themeVariant =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light'
      : 'dark';

  return {
    themeVariant,
    lastDirectory: workspaceFolder,
    ...restStored,
    opencodeBinary:
      typeof restStored.opencodeBinary === 'string'
        ? String(restStored.opencodeBinary).trim()
        : (sharedOpencodeBinary || undefined),
  };
};

const readStringField = (value: unknown, key: string): string => {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  return typeof candidate === 'string' ? candidate.trim() : '';
};

const readBooleanField = (value: unknown, key: string): boolean | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  return typeof candidate === 'boolean' ? candidate : undefined;
};

const readNumberField = (value: unknown, key: string): number | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
};

const normalizeMergeMethod = (value: string): 'merge' | 'squash' | 'rebase' => {
  const trimmed = value.trim();
  if (trimmed === 'merge' || trimmed === 'squash' || trimmed === 'rebase') return trimmed;
  return 'merge';
};

const BRIDGE_ZEN_DEFAULT_MODEL = 'gpt-5-nano';
const BRIDGE_GIT_GENERATION_TIMEOUT_MS = 2 * 60 * 1000;
const BRIDGE_GIT_GENERATION_POLL_INTERVAL_MS = 500;
let bridgeGitModelCatalogCache: Set<string> | null = null;
let bridgeGitModelCatalogCacheAt = 0;
const BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS = 30 * 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const fetchBridgeGitModelCatalog = async (
  apiUrl: string,
  authHeaders?: Record<string, string>
): Promise<Set<string>> => {
  const now = Date.now();
  if (bridgeGitModelCatalogCache && now - bridgeGitModelCatalogCacheAt < BRIDGE_GIT_MODEL_CATALOG_CACHE_TTL_MS) {
    return bridgeGitModelCatalogCache;
  }

  const headers = authHeaders || {};
  const modelsUrl = new URL(`${apiUrl.replace(/\/+$/, '')}/model`);
  const response = await fetch(modelsUrl.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error('Failed to fetch model catalog');
  }

  const payload = await response.json().catch(() => null) as unknown;
  const refs = new Set<string>();
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const record = item as Record<string, unknown>;
      const providerID = typeof record.providerID === 'string' ? record.providerID.trim() : '';
      const modelID = typeof record.modelID === 'string' ? record.modelID.trim() : '';
      if (providerID && modelID) {
        refs.add(`${providerID}/${modelID}`);
      }
    }
  }

  bridgeGitModelCatalogCache = refs;
  bridgeGitModelCatalogCacheAt = now;
  return refs;
};

const resolveBridgeGitGenerationModel = async (
  payloadModel: { providerId?: string; modelId?: string; zenModel?: string },
  settings: Record<string, unknown>,
  apiUrl: string,
  authHeaders?: Record<string, string>
): Promise<{ providerID: string; modelID: string }> => {
  let catalog: Set<string> | null = null;
  try {
    catalog = await fetchBridgeGitModelCatalog(apiUrl, authHeaders);
  } catch {
    catalog = null;
  }

  const hasModel = (providerID: string, modelID: string): boolean => {
    if (!catalog) {
      return false;
    }
    return catalog.has(`${providerID}/${modelID}`);
  };

  const requestProviderId = typeof payloadModel.providerId === 'string' ? payloadModel.providerId.trim() : '';
  const requestModelId = typeof payloadModel.modelId === 'string' ? payloadModel.modelId.trim() : '';
  if (requestProviderId && requestModelId && hasModel(requestProviderId, requestModelId)) {
    return { providerID: requestProviderId, modelID: requestModelId };
  }

  const settingsProviderId = readStringField(settings, 'gitProviderId');
  const settingsModelId = readStringField(settings, 'gitModelId');
  if (settingsProviderId && settingsModelId && hasModel(settingsProviderId, settingsModelId)) {
    return { providerID: settingsProviderId, modelID: settingsModelId };
  }

  const payloadZenModel = typeof payloadModel.zenModel === 'string' ? payloadModel.zenModel.trim() : '';
  const settingsZenModel = readStringField(settings, 'zenModel');
  return {
    providerID: 'zen',
    modelID: payloadZenModel || settingsZenModel || BRIDGE_ZEN_DEFAULT_MODEL,
  };
};

const extractTextFromMessageParts = (parts: unknown): string => {
  if (!Array.isArray(parts)) {
    return '';
  }

  const textParts = parts
    .filter((part) => {
      if (!part || typeof part !== 'object') return false;
      const record = part as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string';
    })
    .map((part) => (part as Record<string, unknown>).text as string)
    .map((text) => text.trim())
    .filter((text) => text.length > 0);

  return textParts.join('\n').trim();
};

const generateBridgeTextWithSessionFlow = async ({
  apiUrl,
  directory,
  prompt,
  providerID,
  modelID,
  authHeaders,
}: {
  apiUrl: string;
  directory: string;
  prompt: string;
  providerID: string;
  modelID: string;
  authHeaders?: Record<string, string>;
}): Promise<string> => {
  const headers = authHeaders || {};
  const apiBase = apiUrl.replace(/\/+$/, '');
  const deadlineAt = Date.now() + BRIDGE_GIT_GENERATION_TIMEOUT_MS;
  const remainingMs = () => Math.max(1_000, deadlineAt - Date.now());
  let sessionId: string | null = null;

  try {
    const sessionUrl = new URL(`${apiBase}/session`);
    if (directory) {
      sessionUrl.searchParams.set('directory', directory);
    }

    const createResponse = await fetch(sessionUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ title: 'Git Generation' }),
      signal: AbortSignal.timeout(remainingMs()),
    });

    if (!createResponse.ok) {
      throw new Error('Failed to create OpenCode session');
    }

    const session = await createResponse.json().catch(() => null) as unknown;
    const sessionObj = session && typeof session === 'object' ? session as Record<string, unknown> : null;
    const createdSessionId = sessionObj && typeof sessionObj.id === 'string' ? sessionObj.id : '';
    if (!createdSessionId) {
      throw new Error('Invalid session response');
    }
    sessionId = createdSessionId;

    const promptUrl = new URL(`${apiBase}/session/${encodeURIComponent(sessionId)}/prompt_async`);
    if (directory) {
      promptUrl.searchParams.set('directory', directory);
    }

    const promptResponse = await fetch(promptUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        model: {
          providerID,
          modelID,
        },
        parts: [{ type: 'text', text: prompt }],
      }),
      signal: AbortSignal.timeout(remainingMs()),
    });

    if (!promptResponse.ok) {
      throw new Error('Failed to send prompt');
    }

    const messagesUrl = new URL(`${apiBase}/session/${encodeURIComponent(sessionId)}/message`);
    if (directory) {
      messagesUrl.searchParams.set('directory', directory);
    }
    messagesUrl.searchParams.set('limit', '10');

    while (Date.now() < deadlineAt) {
      await sleep(BRIDGE_GIT_GENERATION_POLL_INTERVAL_MS);

      const messagesResponse = await fetch(messagesUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...headers,
        },
        signal: AbortSignal.timeout(remainingMs()),
      });

      if (!messagesResponse.ok) {
        continue;
      }

      const messages = await messagesResponse.json().catch(() => null) as unknown;
      if (!Array.isArray(messages)) {
        continue;
      }

      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as Record<string, unknown> | null;
        if (!message || typeof message !== 'object') {
          continue;
        }
        const info = message.info as Record<string, unknown> | undefined;
        if (info?.role !== 'assistant' || info?.finish !== 'stop') {
          continue;
        }

        const text = extractTextFromMessageParts(message.parts);
        if (text) {
          return text;
        }
      }
    }

    throw new Error('Timeout waiting for generation to complete');
  } finally {
    if (sessionId) {
      const deleteUrl = new URL(`${apiBase}/session/${encodeURIComponent(sessionId)}`);
      try {
        await fetch(deleteUrl.toString(), {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // ignore cleanup failures
      }
    }
  }
};

const parseJsonObjectSafe = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const persistSettings = async (changes: Record<string, unknown>, ctx?: BridgeContext) => {
  const current = readSettings(ctx);
  const restChanges = { ...(changes || {}) };
  delete restChanges.lastDirectory;

  const keysToClear = new Set<string>();

  // Normalize empty-string clears to key removal (match web/desktop behavior)
  for (const key of ['defaultModel', 'defaultVariant', 'defaultAgent', 'defaultGitIdentityId', 'opencodeBinary']) {
    const value = restChanges[key];
    if (typeof value === 'string' && value.trim().length === 0) {
      keysToClear.add(key);
      delete restChanges[key];
    }
  }

  if (typeof restChanges.usageAutoRefresh !== 'boolean') {
    delete restChanges.usageAutoRefresh;
  }

  if (typeof restChanges.usageRefreshIntervalMs === 'number' && Number.isFinite(restChanges.usageRefreshIntervalMs)) {
    restChanges.usageRefreshIntervalMs = Math.max(30000, Math.min(300000, Math.round(restChanges.usageRefreshIntervalMs)));
  } else {
    delete restChanges.usageRefreshIntervalMs;
  }

  const merged = { ...current, ...restChanges, lastDirectory: current.lastDirectory } as Record<string, unknown>;
  for (const key of keysToClear) {
    delete merged[key];
  }
  await ctx?.context?.globalState.update(SETTINGS_KEY, merged);

  if (keysToClear.has('opencodeBinary')) {
    await writeSharedSettingsToDisk({ opencodeBinary: '' });
  } else if (typeof restChanges.opencodeBinary === 'string') {
    await writeSharedSettingsToDisk({ opencodeBinary: restChanges.opencodeBinary.trim() });
  }

  return merged;
};

const normalizeFsPath = (value: string) => value.replace(/\\/g, '/');

const isSocketPath = async (candidate: string): Promise<boolean> => {
  if (!candidate) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(candidate);
    return typeof stat.isSocket === 'function' && stat.isSocket();
  } catch {
    return false;
  }
};

const resolveSshAuthSock = async (): Promise<string | undefined> => {
  const existing = (process.env.SSH_AUTH_SOCK || '').trim();
  if (existing) {
    return existing;
  }

  if (process.platform === 'win32') {
    return undefined;
  }

  const gpgSock = path.join(os.homedir(), '.gnupg', 'S.gpg-agent.ssh');
  if (await isSocketPath(gpgSock)) {
    return gpgSock;
  }

  const runGpgconf = async (args: string[]): Promise<string> => {
    for (const candidate of gpgconfCandidates) {
      try {
        const { stdout } = await execFileAsync(candidate, args);
        return String(stdout || '');
      } catch {
        continue;
      }
    }
    return '';
  };

  const candidate = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (candidate && await isSocketPath(candidate)) {
    return candidate;
  }

  if (candidate) {
    await runGpgconf(['--launch', 'gpg-agent']);
    const retried = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
    if (retried && await isSocketPath(retried)) {
      return retried;
    }
  }

  return undefined;
};

const buildGitEnv = async (): Promise<NodeJS.ProcessEnv> => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.SSH_AUTH_SOCK || !env.SSH_AUTH_SOCK.trim()) {
    const resolved = await resolveSshAuthSock();
    if (resolved) {
      env.SSH_AUTH_SOCK = resolved;
    }
  }
  return env;
};

const execGit = async (args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const env = await buildGitEnv();
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    proc.on('error', (error) => {
      resolve({ stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
    });
  });
};

const gitCheckIgnoreNames = async (cwd: string, names: string[]): Promise<Set<string>> => {
  if (names.length === 0) {
    return new Set();
  }

  const result = await execGit(['check-ignore', '--', ...names], cwd);
  if (result.exitCode !== 0 || !result.stdout) {
    return new Set();
  }

  return new Set(
    result.stdout
      .split('\n')
      .map((name: string) => name.trim())
      .filter(Boolean)
  );
};

const gitCheckIgnorePaths = async (cwd: string, paths: string[]): Promise<Set<string>> => {
  if (paths.length === 0) {
    return new Set();
  }

  const result = await execGit(['check-ignore', '--', ...paths], cwd);
  if (result.exitCode !== 0 || !result.stdout) {
    return new Set();
  }

  return new Set(
    result.stdout
      .split('\n')
      .map((name: string) => name.trim())
      .filter(Boolean)
  );
};

const expandTildePath = (value: string) => {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return os.homedir();
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
};

const resolveUserPath = (value: string, baseDirectory: string) => {
  const expanded = expandTildePath(value);
  if (!expanded) {
    return expanded;
  }
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(baseDirectory, expanded);
};

const listDirectoryEntries = async (dirPath: string) => {
  const uri = vscode.Uri.file(dirPath);
  const entries = await vscode.workspace.fs.readDirectory(uri);
  return entries.map(([name, fileType]) => ({
    name,
    path: normalizeFsPath(vscode.Uri.joinPath(uri, name).fsPath),
    isDirectory: fileType === vscode.FileType.Directory,
  }));
};

const FILE_SEARCH_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'tmp',
  'logs',
]);

const shouldSkipSearchDirectory = (name: string, includeHidden: boolean) => {
  if (!name) {
    return false;
  }
  if (!includeHidden && name.startsWith('.')) {
    return true;
  }
  return FILE_SEARCH_EXCLUDED_DIRS.has(name.toLowerCase());
};

/**
 * Fuzzy match scoring function.
 * Returns a score > 0 if the query fuzzy-matches the candidate, null otherwise.
 * Higher scores indicate better matches.
 */
const fuzzyMatchScore = (query: string, candidate: string): number | null => {
  if (!query) return 0;

  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  // Fast path: exact substring match gets high score
  if (c.includes(q)) {
    const idx = c.indexOf(q);
    let bonus = 0;
    if (idx === 0) {
      bonus = 20;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        bonus = 15;
      }
    }
    return 100 + bonus - Math.min(idx, 20) - Math.floor(c.length / 5);
  }

  // Fuzzy match: all query chars must appear in order
  let score = 0;
  let lastIndex = -1;
  let consecutive = 0;

  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (!ch || ch === ' ') continue;

    const idx = c.indexOf(ch, lastIndex + 1);
    if (idx === -1) {
      return null; // No match
    }

    const gap = idx - lastIndex - 1;
    if (gap === 0) {
      consecutive++;
    } else {
      consecutive = 0;
    }

    score += 10;
    score += Math.max(0, 18 - idx); // Prefer matches near start
    score -= Math.min(gap, 10); // Penalize gaps

    // Bonus for word boundary matches
    if (idx === 0) {
      score += 12;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        score += 10;
      }
    }

    score += consecutive > 0 ? 12 : 0; // Bonus for consecutive matches
    lastIndex = idx;
  }

  // Prefer shorter paths
  score += Math.max(0, 24 - Math.floor(c.length / 3));

  return score;
};

const searchFilesystemFiles = async (
  rootPath: string,
  query: string,
  limit: number,
  includeHidden: boolean,
  respectGitignore: boolean,
  timeBudgetMs?: number
) => {
  const normalizedQuery = (query || '').trim().toLowerCase();
  const matchAll = normalizedQuery.length === 0;
  const deadline = typeof timeBudgetMs === 'number' && timeBudgetMs > 0 ? Date.now() + timeBudgetMs : null;

  const rootUri = vscode.Uri.file(rootPath);
  const queue: vscode.Uri[] = [rootUri];
  const visited = new Set<string>([normalizeFsPath(rootUri.fsPath)]);
  // Collect more candidates for fuzzy matching, then sort and trim
  const collectLimit = matchAll ? limit : Math.max(limit * 3, 200);
  const candidates: Array<{ name: string; path: string; relativePath: string; extension?: string; score: number }> = [];
  const MAX_CONCURRENCY = 10;

  while (queue.length > 0 && candidates.length < collectLimit) {
    if (deadline && Date.now() > deadline) {
      break;
    }
    const batch = queue.splice(0, MAX_CONCURRENCY);
    const dirLists = await Promise.all(
      batch.map((dir) => Promise.resolve(vscode.workspace.fs.readDirectory(dir)).catch(() => [] as [string, vscode.FileType][]))
    );

    for (let index = 0; index < batch.length; index += 1) {
      if (deadline && Date.now() > deadline) {
        break;
      }
      const currentDir = batch[index];
      const dirents = dirLists[index];

      const ignoredNames = respectGitignore
        ? await gitCheckIgnoreNames(normalizeFsPath(currentDir.fsPath), dirents.map(([name]) => name))
        : new Set<string>();

      for (const [entryName, entryType] of dirents) {
        if (!entryName || (!includeHidden && entryName.startsWith('.'))) {
          continue;
        }

        if (respectGitignore && ignoredNames.has(entryName)) {
          continue;
        }

        const entryUri = vscode.Uri.joinPath(currentDir, entryName);
        const absolute = normalizeFsPath(entryUri.fsPath);

        if (entryType === vscode.FileType.Directory) {
          if (shouldSkipSearchDirectory(entryName, includeHidden)) {
            continue;
          }
          if (!visited.has(absolute)) {
            visited.add(absolute);
            queue.push(entryUri);
          }
          continue;
        }

        if (entryType !== vscode.FileType.File) {
          continue;
        }

        const relativePath = normalizeFsPath(path.relative(rootPath, absolute) || path.basename(absolute));
        const extension = entryName.includes('.') ? entryName.split('.').pop()?.toLowerCase() : undefined;

        if (matchAll) {
          candidates.push({
            name: entryName,
            path: absolute,
            relativePath,
            extension,
            score: 0,
          });
        } else {
          // Try fuzzy match against relative path (includes filename)
          const score = fuzzyMatchScore(normalizedQuery, relativePath);
          if (score !== null) {
            candidates.push({
              name: entryName,
              path: absolute,
              relativePath,
              extension,
              score,
            });
          }
        }

        if (candidates.length >= collectLimit) {
          queue.length = 0;
          break;
        }
      }

      if (candidates.length >= collectLimit) {
        break;
      }
    }
  }

  // Sort by score descending, then by path length, then alphabetically
  if (!matchAll) {
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.relativePath.length !== b.relativePath.length) {
        return a.relativePath.length - b.relativePath.length;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });
  }

  // Return top results without the score field
  return candidates.slice(0, limit).map(({ name, path: filePath, relativePath, extension }) => ({
    name,
    path: filePath,
    relativePath,
    extension,
  }));
};

const searchDirectory = async (
  directory: string,
  query: string,
  limit = 60,
  includeHidden = false,
  respectGitignore = true
) => {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const rootPath = directory
    ? resolveUserPath(directory, workspaceRoot)
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (!rootPath) return [];

  const sanitizedQuery = query?.trim() || '';
  if (!sanitizedQuery) {
    return searchFilesystemFiles(rootPath, '', limit, includeHidden, respectGitignore);
  }

  const escapeGlob = (value: string) => value
    .replace(/[\\{}()?*]/g, '\\$&')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
  const exclude = '**/{node_modules,.git,dist,build,.next,.turbo,.cache,coverage,tmp,logs}/**';
  const mapResults = (results: vscode.Uri[]) => results.map((file) => {
    const absolute = normalizeFsPath(file.fsPath);
    const relative = normalizeFsPath(path.relative(rootPath, absolute));
    const name = path.basename(absolute);
    return {
      name,
      path: absolute,
      relativePath: relative || name,
      extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
    };
  });
  const filterGitIgnored = async (results: vscode.Uri[]) => {
    if (!respectGitignore || results.length === 0) {
      return results;
    }

    const relativePaths = results.map((file) => {
      const relative = normalizeFsPath(path.relative(rootPath, file.fsPath));
      return relative || path.basename(file.fsPath);
    });

    const ignored = await gitCheckIgnorePaths(rootPath, relativePaths);
    if (ignored.size === 0) {
      return results;
    }

    return results.filter((_, index) => !ignored.has(relativePaths[index]));
  };

  // Fast-path via VS Code's file index (may be case-sensitive depending on platform/workspace).
  try {
    const escapedQuery = escapeGlob(sanitizedQuery);
    const pattern = `**/*${escapedQuery}*`;
    const results = await vscode.workspace.findFiles(
      new vscode.RelativePattern(vscode.Uri.file(rootPath), pattern),
      exclude,
      limit,
    );

    if (Array.isArray(results) && results.length > 0) {
      const visible = includeHidden ? results : results.filter((file) => !path.basename(file.fsPath).startsWith('.'));
      const filtered = await filterGitIgnored(visible);
      if (filtered.length > 0) {
        return mapResults(filtered);
      }
    }

    if (sanitizedQuery.length >= 2 && sanitizedQuery.length <= 32) {
      const fuzzyPattern = `**/*${escapedQuery.split('').join('*')}*`;
      const fuzzyResults = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(rootPath), fuzzyPattern),
        exclude,
        limit,
      );

      if (Array.isArray(fuzzyResults) && fuzzyResults.length > 0) {
        const visible = includeHidden ? fuzzyResults : fuzzyResults.filter((file) => !path.basename(file.fsPath).startsWith('.'));
        const filtered = await filterGitIgnored(visible);
        if (filtered.length > 0) {
          return mapResults(filtered);
        }
      }
    }
  } catch {
    // Fall through to filesystem traversal.
  }

  // Fallback: deterministic, case-insensitive traversal with early-exit at limit.
  return searchFilesystemFiles(rootPath, sanitizedQuery, limit, includeHidden, respectGitignore, 1500);
};

const fetchModelsMetadata = async () => {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), 8000) : undefined;
  try {
    const response = await fetch('https://models.dev/api.json', {
      signal: controller?.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`models.dev responded with ${response.status}`);
    }
    return await response.json();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const base64EncodeUtf8 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const collectHeaders = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const buildUnavailableApiResponse = (): ApiProxyResponsePayload => {
  const body = JSON.stringify({ error: 'OpenCode API unavailable' });
  return {
    status: 503,
    headers: { 'content-type': 'application/json' },
    bodyBase64: base64EncodeUtf8(body),
  };
};

const sanitizeForwardHeaders = (input: Record<string, string> | undefined): Record<string, string> => {
  const headers: Record<string, string> = { ...(input || {}) };
  delete headers['content-length'];
  delete headers['host'];
  delete headers['connection'];
  return headers;
};

const getFsAccessRoot = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();

const getFsMimeType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.markdown': 'text/markdown; charset=utf-8',
    '.mmd': 'text/plain; charset=utf-8',
    '.mermaid': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.pdf': 'application/pdf',
  };
  return mimeMap[ext] || 'application/octet-stream';
};

type FsReadPathResolution =
  | { ok: true; resolvedPath: string }
  | { ok: false; status: number; error: string };

const resolveFileReadPath = async (targetPath: string): Promise<FsReadPathResolution> => {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: 'Path is required' };
  }

  const baseRoot = getFsAccessRoot();
  const resolved = resolveUserPath(trimmed, baseRoot);
  if (!resolved) {
    return { ok: false, status: 400, error: 'Path is required' };
  }

  try {
    const [canonicalPath, canonicalBase] = await Promise.all([
      fs.promises.realpath(resolved),
      fs.promises.realpath(baseRoot).catch(() => path.resolve(baseRoot)),
    ]);

    if (!isPathInside(canonicalPath, canonicalBase)) {
      return { ok: false, status: 403, error: 'Access to file denied' };
    }

    return { ok: true, resolvedPath: canonicalPath };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return { ok: false, status: 404, error: 'File not found' };
    }
    return { ok: false, status: 500, error: 'Failed to resolve file path' };
  }
};

const buildProxyJsonError = (status: number, error: string): ApiProxyResponsePayload => ({
  status,
  headers: { 'content-type': 'application/json' },
  bodyBase64: base64EncodeUtf8(JSON.stringify({ error })),
});

const tryHandleLocalFsProxy = async (method: string, requestPath: string): Promise<ApiProxyResponsePayload | null> => {
  let parsed: URL;
  try {
    parsed = new URL(requestPath, 'https://openchamber.local');
  } catch {
    return buildProxyJsonError(400, 'Invalid request path');
  }

  if (parsed.pathname !== '/api/fs/read' && parsed.pathname !== '/api/fs/raw') {
    return null;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return buildProxyJsonError(405, 'Method not allowed');
  }

  const targetPath = parsed.searchParams.get('path') || '';
  const resolution = await resolveFileReadPath(targetPath);
  if (!resolution.ok) {
    return buildProxyJsonError(resolution.status, resolution.error);
  }

  try {
    const stats = await fs.promises.stat(resolution.resolvedPath);
    if (!stats.isFile()) {
      return buildProxyJsonError(400, 'Specified path is not a file');
    }

    if (parsed.pathname === '/api/fs/read') {
      const content = await fs.promises.readFile(resolution.resolvedPath, 'utf8');
      return {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
        bodyBase64: base64EncodeUtf8(content),
      };
    }

    const raw = await fs.promises.readFile(resolution.resolvedPath);
    return {
      status: 200,
      headers: {
        'content-type': getFsMimeType(resolution.resolvedPath),
        'cache-control': 'no-store',
      },
      bodyBase64: Buffer.from(raw).toString('base64'),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      return buildProxyJsonError(404, 'File not found');
    }
    return buildProxyJsonError(500, 'Unable to read file');
  }
};

export async function handleBridgeMessage(message: BridgeRequest, ctx?: BridgeContext): Promise<BridgeResponse> {
  const { id, type, payload } = message;

  try {
    switch (type) {
      case 'api:proxy': {
        const { method, path: requestPath, headers, bodyBase64 } = (payload || {}) as ApiProxyRequestPayload;
        const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
        const normalizedPath =
          typeof requestPath === 'string' && requestPath.trim().length > 0
            ? requestPath.trim().startsWith('/')
              ? requestPath.trim()
              : `/${requestPath.trim()}`
            : '/';

        const localFsResponse = await tryHandleLocalFsProxy(normalizedMethod, normalizedPath);
        if (localFsResponse) {
          return { id, type, success: true, data: localFsResponse };
        }

        const apiUrl = ctx?.manager?.getApiUrl();
        if (!apiUrl) {
          const data = buildUnavailableApiResponse();
          return { id, type, success: true, data };
        }

        const base = `${apiUrl.replace(/\/+$/, '')}/`;
        const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
        const requestHeaders: Record<string, string> = {
          ...sanitizeForwardHeaders(headers),
          ...ctx?.manager?.getOpenCodeAuthHeaders(),
        };

        // Ensure SSE requests are negotiated correctly.
        if (normalizedPath === '/event' || normalizedPath === '/global/event') {
          if (!requestHeaders.Accept) {
            requestHeaders.Accept = 'text/event-stream';
          }
          requestHeaders['Cache-Control'] = requestHeaders['Cache-Control'] || 'no-cache';
          requestHeaders.Connection = requestHeaders.Connection || 'keep-alive';
        }

        try {
          const response = await fetch(targetUrl, {
            method: normalizedMethod,
            headers: requestHeaders,
            body:
              typeof bodyBase64 === 'string' && bodyBase64.length > 0 && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD'
                ? Buffer.from(bodyBase64, 'base64')
                : undefined,
          });

          const arrayBuffer = await response.arrayBuffer();
          const data: ApiProxyResponsePayload = {
            status: response.status,
            headers: collectHeaders(response.headers),
            bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
          };

          return { id, type, success: true, data };
        } catch (error) {
          const body = JSON.stringify({
            error: error instanceof Error ? error.message : 'Failed to reach OpenCode API',
          });
          const data: ApiProxyResponsePayload = {
            status: 502,
            headers: { 'content-type': 'application/json' },
            bodyBase64: base64EncodeUtf8(body),
          };
          return { id, type, success: true, data };
        }
      }

      case 'api:session:message': {
        const apiUrl = ctx?.manager?.getApiUrl();
        if (!apiUrl) {
          const data = buildUnavailableApiResponse();
          return { id, type, success: true, data };
        }

        const { path: requestPath, headers, bodyText } = (payload || {}) as ApiSessionMessageRequestPayload;
        const normalizedPath =
          typeof requestPath === 'string' && requestPath.trim().length > 0
            ? requestPath.trim().startsWith('/')
              ? requestPath.trim()
              : `/${requestPath.trim()}`
            : '/';

        if (!/^\/session\/[^/]+\/message(?:\?.*)?$/.test(normalizedPath)) {
          const body = JSON.stringify({ error: 'Invalid session message proxy path' });
          const data: ApiProxyResponsePayload = {
            status: 400,
            headers: { 'content-type': 'application/json' },
            bodyBase64: base64EncodeUtf8(body),
          };
          return { id, type, success: true, data };
        }

        const base = `${apiUrl.replace(/\/+$/, '')}/`;
        const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
        const requestHeaders: Record<string, string> = {
          ...sanitizeForwardHeaders(headers),
          ...ctx?.manager?.getOpenCodeAuthHeaders(),
        };

        try {
          const response = await fetch(targetUrl, {
            method: 'POST',
            headers: requestHeaders,
            body: typeof bodyText === 'string' ? bodyText : '',
            signal: AbortSignal.timeout(45000),
          });

          const arrayBuffer = await response.arrayBuffer();
          const data: ApiProxyResponsePayload = {
            status: response.status,
            headers: collectHeaders(response.headers),
            bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
          };

          return { id, type, success: true, data };
        } catch (error) {
          const isTimeout =
            error instanceof Error &&
            ((error as Error & { name?: string }).name === 'TimeoutError' ||
              (error as Error & { name?: string }).name === 'AbortError');
          const body = JSON.stringify({
            error: isTimeout ? 'OpenCode message forward timed out' : error instanceof Error ? error.message : 'OpenCode message forward failed',
          });
          const data: ApiProxyResponsePayload = {
            status: isTimeout ? 504 : 503,
            headers: { 'content-type': 'application/json' },
            bodyBase64: base64EncodeUtf8(body),
          };
          return { id, type, success: true, data };
        }
      }

      case 'files:list': {
        const { path: dirPath } = payload as { path: string };
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const resolvedPath = resolveUserPath(dirPath, workspaceRoot);
        const uri = vscode.Uri.file(resolvedPath);
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const result: FileEntry[] = entries.map(([name, fileType]) => ({
          name,
          path: vscode.Uri.joinPath(uri, name).fsPath,
          isDirectory: fileType === vscode.FileType.Directory,
        }));
        return { id, type, success: true, data: { directory: normalizeFsPath(resolvedPath), entries: result } };
      }

      case 'files:search': {
        const { query, maxResults = 50 } = payload as { query: string; maxResults?: number };
        const pattern = `**/*${query}*`;
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);
        const results: FileSearchResult[] = files.map((file) => ({
          path: file.fsPath,
        }));
        return { id, type, success: true, data: results };
      }

      case 'workspace:folder': {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        return { id, type, success: true, data: { folder } };
      }

      case 'config:get': {
        const { key } = payload as { key: string };
        const config = vscode.workspace.getConfiguration('openchamber');
        const value = config.get(key);
        return { id, type, success: true, data: { value } };
      }

      case 'api:fs:list': {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const { path: targetPath, respectGitignore } = (payload || {}) as { path?: string; respectGitignore?: boolean };
        const target = targetPath || workspaceRoot;
        const resolvedPath = resolveUserPath(target, workspaceRoot) || workspaceRoot;

        const entries = await listDirectoryEntries(resolvedPath);
        const normalized = normalizeFsPath(resolvedPath);

        if (!respectGitignore) {
          return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
        }

        const pathsToCheck = entries.map((entry) => entry.name).filter(Boolean);
        if (pathsToCheck.length === 0) {
          return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
        }

        try {
          const result = await execGit(['check-ignore', '--', ...pathsToCheck], normalized);
          const ignoredNames = new Set(
            result.stdout
              .split('\n')
              .map((name) => name.trim())
              .filter(Boolean)
          );

          const filteredEntries = entries.filter((entry) => !ignoredNames.has(entry.name));
          return { id, type, success: true, data: { entries: filteredEntries, directory: normalized, path: normalized } };
        } catch {
          return { id, type, success: true, data: { entries, directory: normalized, path: normalized } };
        }
      }

       case 'api:fs:search': {
         const { directory = '', query = '', limit, includeHidden, respectGitignore } = (payload || {}) as {
           directory?: string;
           query?: string;
           limit?: number;
           includeHidden?: boolean;
           respectGitignore?: boolean;
         };
         const files = await searchDirectory(directory, query, limit, Boolean(includeHidden), respectGitignore !== false);
         return { id, type, success: true, data: { files } };
       }

      case 'api:fs:mkdir': {
        const target = (payload as { path: string })?.path;
        if (!target) {
          return { id, type, success: false, error: 'Path is required' };
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const resolvedPath = resolveUserPath(target, workspaceRoot);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(resolvedPath));
        return { id, type, success: true, data: { success: true, path: normalizeFsPath(resolvedPath) } };
      }

      case 'api:fs/home': {
        // Match web/desktop semantics: OS home directory.
        return { id, type, success: true, data: { home: normalizeFsPath(os.homedir()) } };
      }

      case 'api:fs:read': {
        const target = (payload as { path: string })?.path;
        if (!target) {
          return { id, type, success: false, error: 'Path is required' };
        }

        const resolution = await resolveFileReadPath(target);
        if (!resolution.ok) {
          return { id, type, success: false, error: resolution.error };
        }

        try {
          const content = await fs.promises.readFile(resolution.resolvedPath, 'utf8');
          return { id, type, success: true, data: { content, path: normalizeFsPath(resolution.resolvedPath) } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to read file';
          return { id, type, success: false, error: message };
        }
      }

      case 'api:fs:write': {
        const { path: targetPath, content } = (payload as { path: string; content: string }) || {};
        if (!targetPath) {
          return { id, type, success: false, error: 'Path is required' };
        }
        if (typeof content !== 'string') {
          return { id, type, success: false, error: 'Content is required' };
        }
        try {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
          const resolvedPath = resolveUserPath(targetPath, workspaceRoot);
          const uri = vscode.Uri.file(resolvedPath);
          // Ensure parent directory exists
          const parentUri = vscode.Uri.file(path.dirname(resolvedPath));
          try {
            await vscode.workspace.fs.createDirectory(parentUri);
          } catch {
            // Directory may already exist
          }
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
          return { id, type, success: true, data: { success: true, path: normalizeFsPath(resolvedPath) } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to write file';
          return { id, type, success: false, error: message };
        }
      }

      case 'api:fs:delete': {
        const targetPath = (payload as { path: string })?.path;
        if (!targetPath) {
          return { id, type, success: false, error: 'Path is required' };
        }
        try {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
          const resolvedPath = resolveUserPath(targetPath, workspaceRoot);
          const uri = vscode.Uri.file(resolvedPath);
          await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
          return { id, type, success: true, data: { success: true } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to delete file';
          return { id, type, success: false, error: message };
        }
      }

      case 'api:fs:rename': {
        const { oldPath, newPath } = (payload as { oldPath: string; newPath: string }) || {};
        if (!oldPath) {
          return { id, type, success: false, error: 'oldPath is required' };
        }
        if (!newPath) {
          return { id, type, success: false, error: 'newPath is required' };
        }
        try {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
          const resolvedOld = resolveUserPath(oldPath, workspaceRoot);
          const resolvedNew = resolveUserPath(newPath, workspaceRoot);
          const oldUri = vscode.Uri.file(resolvedOld);
          const newUri = vscode.Uri.file(resolvedNew);
          await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
          return { id, type, success: true, data: { success: true, path: normalizeFsPath(resolvedNew) } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to rename file';
          return { id, type, success: false, error: message };
        }
      }

      case 'api:fs:exec': {
        const { commands, cwd } = (payload as { commands: string[]; cwd: string }) || {};
        if (!Array.isArray(commands) || commands.length === 0) {
          return { id, type, success: false, error: 'Commands array is required' };
        }
        if (!cwd) {
          return { id, type, success: false, error: 'Working directory (cwd) is required' };
        }
        try {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
          const resolvedCwd = resolveUserPath(cwd, workspaceRoot);
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);
          const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
          const shellFlag = process.platform === 'win32' ? '/c' : '-c';

          const augmentedEnv = {
            ...process.env,
            PATH: process.env.PATH,
          };

          const results: Array<{
            command: string;
            success: boolean;
            exitCode?: number;
            stdout?: string;
            stderr?: string;
            error?: string;
          }> = [];

          for (const cmd of commands) {
            if (typeof cmd !== 'string' || !cmd.trim()) {
              results.push({ command: cmd, success: false, error: 'Invalid command' });
              continue;
            }
            try {
              // Use async exec to not block the extension host event loop
              const { stdout, stderr } = await execAsync(`${shell} ${shellFlag} "${cmd.replace(/"/g, '\\"')}"`, {
                cwd: resolvedCwd,
                env: augmentedEnv,
                timeout: 300000, // 5 minutes per command
              });
              results.push({
                command: cmd,
                success: true,
                exitCode: 0,
                stdout: (stdout || '').trim(),
                stderr: (stderr || '').trim(),
              });
            } catch (execError) {
              const err = execError as { code?: number; stdout?: string; stderr?: string; message?: string };
              results.push({
                command: cmd,
                success: false,
                exitCode: typeof err.code === 'number' ? err.code : 1,
                stdout: (err.stdout || '').trim(),
                stderr: (err.stderr || '').trim(),
                error: err.message,
              });
            }
          }

          const allSucceeded = results.every((r) => r.success);
          return { id, type, success: true, data: { success: allSucceeded, results } };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to execute commands';
          return { id, type, success: false, error: message };
        }
      }

      case 'api:files/pick': {
        const allowMany = (payload as { allowMany?: boolean })?.allowMany !== false;
        const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;

        const picks = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: allowMany,
          defaultUri,
          openLabel: 'Attach',
        });

        if (!picks || picks.length === 0) {
          return { id, type, success: true, data: { files: [], skipped: [] } };
        }

        const files: Array<{ name: string; mimeType: string; size: number; dataUrl: string }> = [];
        const skipped: Array<{ name: string; reason: string }> = [];

        for (const uri of picks) {
          const result = await readUriAsAttachment(uri);
          if ('file' in result) {
            files.push(result.file);
          } else {
            skipped.push(result.skipped);
          }
        }

        return { id, type, success: true, data: { files, skipped } };
      }

      case 'api:files/drop': {
        const uris = Array.isArray((payload as { uris?: unknown[] })?.uris)
          ? (payload as { uris: unknown[] }).uris.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [];

        if (uris.length === 0) {
          return { id, type, success: true, data: { files: [], skipped: [] } };
        }

        const files: Array<{ name: string; mimeType: string; size: number; dataUrl: string }> = [];
        const skipped: Array<{ name: string; reason: string }> = [];

        const dedupedUris = Array.from(new Set(uris.map((value) => value.trim())));

        for (const rawUri of dedupedUris) {
          let uri: vscode.Uri;
          try {
            uri = vscode.Uri.parse(rawUri, true);
          } catch (error) {
            skipped.push({
              name: rawUri,
              reason: error instanceof Error ? error.message : 'Invalid URI',
            });
            continue;
          }

          if (uri.scheme !== 'file') {
            skipped.push({
              name: rawUri,
              reason: `Unsupported URI scheme: ${uri.scheme}`,
            });
            continue;
          }

          const name = path.basename(uri.fsPath || uri.path || rawUri);

          const result = await readUriAsAttachment(uri, name);
          if ('file' in result) {
            files.push(result.file);
          } else {
            skipped.push(result.skipped);
          }
        }

        return { id, type, success: true, data: { files, skipped } };
      }

      case 'api:config/settings:get': {
        const settings = readSettings(ctx);
        return { id, type, success: true, data: settings };
      }

      case 'api:config/settings:save': {
        const changes = (payload as Record<string, unknown>) || {};
        const updated = await persistSettings(changes, ctx);
        return { id, type, success: true, data: updated };
      }

      case 'api:github/auth:status': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const list = await readGitHubAuthList(context);
        const accounts = list
          .filter((entry) => entry.user && entry.accountId)
          .map((entry) => ({
            id: entry.accountId as string,
            user: entry.user,
            scope: entry.scope,
            current: Boolean(entry.current),
          }));

        const stored = list.find((entry) => entry.current) || list[0];
        if (!stored?.accessToken) {
          return { id, type, success: true, data: { connected: false, accounts } };
        }

        try {
          const user = await fetchMe(stored.accessToken);
          return { id, type, success: true, data: { connected: true, user, scope: stored.scope, accounts } };
        } catch (error: unknown) {
          const status = (error && typeof error === 'object' && 'status' in error) ? (error as { status?: number }).status : undefined;
          const message = error instanceof Error ? error.message : String(error);
          if (status === 401 || message === 'unauthorized') {
            await clearGitHubAuth(context);
            const updatedAccounts = (await readGitHubAuthList(context))
              .filter((entry) => entry.user && entry.accountId)
              .map((entry) => ({
                id: entry.accountId as string,
                user: entry.user,
                scope: entry.scope,
                current: Boolean(entry.current),
              }));
            return { id, type, success: true, data: { connected: false, accounts: updatedAccounts } };
          }
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/auth:start': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const settings = readSettings(ctx);
        const clientId = readStringField(settings, 'githubClientId') || DEFAULT_GITHUB_CLIENT_ID;
        const scopes = readStringField(settings, 'githubScopes') || DEFAULT_GITHUB_SCOPES;
        const flow = await startDeviceFlow(clientId, scopes);
        return { id, type, success: true, data: flow };
      }

      case 'api:github/auth:complete': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const deviceCode = readStringField(payload, 'deviceCode');
        if (!deviceCode) return { id, type, success: false, error: 'deviceCode is required' };

        const settings = readSettings(ctx);
        const clientId = readStringField(settings, 'githubClientId') || DEFAULT_GITHUB_CLIENT_ID;

        const token = await exchangeDeviceCode(clientId, deviceCode);
        const tokenRecord = token && typeof token === 'object' ? (token as Record<string, unknown>) : null;
        const tokenError = typeof tokenRecord?.error === 'string' ? tokenRecord.error : '';
        const tokenErrorDescription = typeof tokenRecord?.error_description === 'string' ? tokenRecord.error_description : '';
        if (tokenError) {
          return {
            id,
            type,
            success: true,
            data: {
              connected: false,
              status: tokenError,
              error: tokenErrorDescription || tokenError,
            },
          };
        }
        const accessToken = typeof tokenRecord?.access_token === 'string' ? tokenRecord.access_token : '';
        if (!accessToken) {
          return { id, type, success: false, error: 'Missing access_token from GitHub' };
        }

        const user = await fetchMe(accessToken);
        await writeGitHubAuth(context, {
          accessToken,
          scope: typeof tokenRecord?.scope === 'string' ? tokenRecord.scope : undefined,
          tokenType: typeof tokenRecord?.token_type === 'string' ? tokenRecord.token_type : undefined,
          createdAt: Date.now(),
          user,
        });

        return {
          id,
          type,
          success: true,
          data: {
            connected: true,
            user,
            scope: typeof tokenRecord?.scope === 'string' ? tokenRecord.scope : undefined,
          },
        };
      }

      case 'api:github/auth:disconnect': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const removed = await clearGitHubAuth(context);
        return { id, type, success: true, data: { removed } };
      }

      case 'api:github/auth:activate': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const accountId = readStringField(payload, 'accountId');
        if (!accountId) return { id, type, success: false, error: 'accountId is required' };
        const activated = await activateGitHubAuth(context, accountId);
        if (!activated) return { id, type, success: false, error: 'GitHub account not found' };
        const list = await readGitHubAuthList(context);
        const accounts = list
          .filter((entry) => entry.user && entry.accountId)
          .map((entry) => ({
            id: entry.accountId as string,
            user: entry.user,
            scope: entry.scope,
            current: Boolean(entry.current),
          }));
        const stored = list.find((entry) => entry.current) || list[0];
        if (!stored?.accessToken) {
          return { id, type, success: true, data: { connected: false, accounts } };
        }
        try {
          const user = await fetchMe(stored.accessToken);
          return { id, type, success: true, data: { connected: true, user, scope: stored.scope, accounts } };
        } catch (error: unknown) {
          const status = (error && typeof error === 'object' && 'status' in error) ? (error as { status?: number }).status : undefined;
          const message = error instanceof Error ? error.message : String(error);
          if (status === 401 || message === 'unauthorized') {
            await clearGitHubAuth(context);
            const updatedAccounts = (await readGitHubAuthList(context))
              .filter((entry) => entry.user && entry.accountId)
              .map((entry) => ({
                id: entry.accountId as string,
                user: entry.user,
                scope: entry.scope,
                current: Boolean(entry.current),
              }));
            return { id, type, success: true, data: { connected: false, accounts: updatedAccounts } };
          }
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/me': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) return { id, type, success: false, error: 'GitHub not connected' };
        try {
          const user = await fetchMe(stored.accessToken);
          return { id, type, success: true, data: user };
        } catch (error: unknown) {
          const status = (error && typeof error === 'object' && 'status' in error) ? (error as { status?: number }).status : undefined;
          const message = error instanceof Error ? error.message : String(error);
          if (status === 401 || message === 'unauthorized') {
            await clearGitHubAuth(context);
            return { id, type, success: false, error: 'GitHub token expired or revoked' };
          }
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/pr:status': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const directory = readStringField(payload, 'directory');
        const branch = readStringField(payload, 'branch');
        if (!directory || !branch) {
          return { id, type, success: false, error: 'directory and branch are required' };
        }

        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) {
          return { id, type, success: true, data: { connected: false } };
        }

        try {
          const result = await getPullRequestStatus(
            stored.accessToken,
            stored.user?.login || null,
            directory,
            branch,
          );
          if (result.connected === false) {
            await clearGitHubAuth(context);
          }
          return { id, type, success: true, data: result };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/pr:create': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) return { id, type, success: false, error: 'GitHub not connected' };
        const directory = readStringField(payload, 'directory');
        const title = readStringField(payload, 'title');
        const head = readStringField(payload, 'head');
        const base = readStringField(payload, 'base');
        const body = readStringField(payload, 'body');
        const draft = readBooleanField(payload, 'draft');
        if (!directory || !title || !head || !base) {
          return { id, type, success: false, error: 'directory, title, head, base are required' };
        }
        try {
          const pr = await createPullRequest(stored.accessToken, directory, {
            directory,
            title,
            head,
            base,
            ...(body ? { body } : {}),
            ...(typeof draft === 'boolean' ? { draft } : {}),
          });
          return { id, type, success: true, data: pr };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/pr:update': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) return { id, type, success: false, error: 'GitHub not connected' };
        const directory = readStringField(payload, 'directory');
        const number = readNumberField(payload, 'number') ?? 0;
        const title = readStringField(payload, 'title');
        const body = readStringField(payload, 'body');
        if (!directory || !number || !title) {
          return { id, type, success: false, error: 'directory, number, title are required' };
        }
        try {
          const pr = await updatePullRequest(stored.accessToken, directory, {
            directory,
            number,
            title,
            ...(typeof body === 'string' ? { body } : {}),
          });
          return { id, type, success: true, data: pr };
        } catch (error: unknown) {
          const status = (error && typeof error === 'object' && 'status' in error) ? (error as { status?: number }).status : undefined;
          const message = error instanceof Error ? error.message : String(error);
          if (status === 401 || message === 'unauthorized') {
            await clearGitHubAuth(context);
          }
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/pr:merge': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) return { id, type, success: false, error: 'GitHub not connected' };
        const directory = readStringField(payload, 'directory');
        const method = normalizeMergeMethod(readStringField(payload, 'method') || 'merge');
        const number = readNumberField(payload, 'number') ?? 0;
        if (!directory || !number) {
          return { id, type, success: false, error: 'directory and number are required' };
        }
        try {
          const result = await mergePullRequest(stored.accessToken, directory, {
            directory,
            number,
            method,
          });
          return { id, type, success: true, data: result };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/pr:ready': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) return { id, type, success: false, error: 'GitHub not connected' };
        const directory = readStringField(payload, 'directory');
        const number = readNumberField(payload, 'number') ?? 0;
        if (!directory || !number) {
          return { id, type, success: false, error: 'directory and number are required' };
        }
        try {
          const result = await markPullRequestReady(stored.accessToken, directory, number);
          return { id, type, success: true, data: result };
        } catch (error: unknown) {
          const status = (error && typeof error === 'object' && 'status' in error) ? (error as { status?: number }).status : undefined;
          const message = error instanceof Error ? error.message : String(error);
          if (status === 401 || message === 'unauthorized') {
            await clearGitHubAuth(context);
          }
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/issues:list': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) {
          return { id, type, success: true, data: { connected: false } };
        }
        const directory = readStringField(payload, 'directory');
        const page = readNumberField(payload, 'page') ?? 1;
        if (!directory) {
          return { id, type, success: false, error: 'directory is required' };
        }
        try {
          const result = await listIssues(stored.accessToken, directory, page);
          if (result.connected === false) {
            await clearGitHubAuth(context);
          }
          return { id, type, success: true, data: result };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/issues:get': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) {
          return { id, type, success: true, data: { connected: false } };
        }
        const directory = readStringField(payload, 'directory');
        const number = readNumberField(payload, 'number') ?? 0;
        if (!directory || !number) {
          return { id, type, success: false, error: 'directory and number are required' };
        }
        try {
          const result = await getIssue(stored.accessToken, directory, number);
          if (result.connected === false) {
            await clearGitHubAuth(context);
          }
          return { id, type, success: true, data: result };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/issues:comments': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) {
          return { id, type, success: true, data: { connected: false } };
        }
        const directory = readStringField(payload, 'directory');
        const number = readNumberField(payload, 'number') ?? 0;
        if (!directory || !number) {
          return { id, type, success: false, error: 'directory and number are required' };
        }
        try {
          const result = await listIssueComments(stored.accessToken, directory, number);
          if (result.connected === false) {
            await clearGitHubAuth(context);
          }
          return { id, type, success: true, data: result };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/pulls:list': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) {
          return { id, type, success: true, data: { connected: false } };
        }
        const directory = readStringField(payload, 'directory');
        const page = readNumberField(payload, 'page') ?? 1;
        if (!directory) {
          return { id, type, success: false, error: 'directory is required' };
        }
        try {
          const result = await listPullRequests(stored.accessToken, directory, page);
          if (result.connected === false) {
            await clearGitHubAuth(context);
          }
          return { id, type, success: true, data: result };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      case 'api:github/pulls:context': {
        const context = ctx?.context;
        if (!context) return { id, type, success: false, error: 'Missing VS Code context' };
        const stored = await readGitHubAuth(context);
        if (!stored?.accessToken) {
          return { id, type, success: true, data: { connected: false } };
        }
        const directory = readStringField(payload, 'directory');
        const number = readNumberField(payload, 'number') ?? 0;
        const includeDiff = readBooleanField(payload, 'includeDiff') ?? false;
        const includeCheckDetails = readBooleanField(payload, 'includeCheckDetails') ?? false;
        if (!directory || !number) {
          return { id, type, success: false, error: 'directory and number are required' };
        }
        try {
          const result = await getPullRequestContext(stored.accessToken, directory, number, includeDiff, includeCheckDetails);
          if (result.connected === false) {
            await clearGitHubAuth(context);
          }
          return { id, type, success: true, data: result };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      case 'api:config/reload': {
        await ctx?.manager?.restart();
        return { id, type, success: true, data: { restarted: true } };
      }

      case 'api:config/agents': {
        const { method, name, body, directory } = (payload || {}) as { method?: string; name?: string; body?: Record<string, unknown>; directory?: string };
        const agentName = typeof name === 'string' ? name.trim() : '';
        if (!agentName) {
          return { id, type, success: false, error: 'Agent name is required' };
        }

        // Use directory from request if provided, otherwise fall back to workspace
        const workingDirectory = (typeof directory === 'string' && directory.trim())
          ? directory.trim()
          : (ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

        const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
        if (normalizedMethod === 'GET') {
          const sources = getAgentSources(agentName, workingDirectory);
          const scope = sources.md.exists
            ? sources.md.scope
            : (sources.json.exists ? sources.json.scope : null);
          return {
            id,
            type,
            success: true,
            data: { name: agentName, sources, scope, isBuiltIn: !sources.md.exists && !sources.json.exists },
          };
        }

        if (normalizedMethod === 'POST') {
          // Extract scope from body if present
          const scopeValue = body?.scope as string | undefined;
          const scope: AgentScope | undefined = scopeValue === 'project' ? AGENT_SCOPE.PROJECT : scopeValue === 'user' ? AGENT_SCOPE.USER : undefined;
          createAgent(agentName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `Agent ${agentName} created successfully. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        if (normalizedMethod === 'PATCH') {
          updateAgent(agentName, (body || {}) as Record<string, unknown>, workingDirectory);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `Agent ${agentName} updated successfully. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        if (normalizedMethod === 'DELETE') {
          deleteAgent(agentName, workingDirectory);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `Agent ${agentName} deleted successfully. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
      }

      case 'api:config/commands': {
        const { method, name, body, directory } = (payload || {}) as { method?: string; name?: string; body?: Record<string, unknown>; directory?: string };
        const commandName = typeof name === 'string' ? name.trim() : '';
        if (!commandName) {
          return { id, type, success: false, error: 'Command name is required' };
        }

        // Use directory from request if provided, otherwise fall back to workspace
        const workingDirectory = (typeof directory === 'string' && directory.trim())
          ? directory.trim()
          : (ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

        const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
        if (normalizedMethod === 'GET') {
          const sources = getCommandSources(commandName, workingDirectory);
          const scope = sources.md.exists
            ? sources.md.scope
            : (sources.json.exists ? sources.json.scope : null);
          return {
            id,
            type,
            success: true,
            data: { name: commandName, sources, scope, isBuiltIn: !sources.md.exists && !sources.json.exists },
          };
        }

        if (normalizedMethod === 'POST') {
          // Extract scope from body if present
          const scopeValue = body?.scope as string | undefined;
          const scope: CommandScope | undefined = scopeValue === 'project' ? COMMAND_SCOPE.PROJECT : scopeValue === 'user' ? COMMAND_SCOPE.USER : undefined;
          createCommand(commandName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `Command ${commandName} created successfully. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        if (normalizedMethod === 'PATCH') {
          updateCommand(commandName, (body || {}) as Record<string, unknown>, workingDirectory);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `Command ${commandName} updated successfully. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        if (normalizedMethod === 'DELETE') {
          deleteCommand(commandName, workingDirectory);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `Command ${commandName} deleted successfully. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
      }

      case 'api:config/mcp': {
        const { method, name, body, directory } = (payload || {}) as { method?: string; name?: string; body?: Record<string, unknown>; directory?: string };
        const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
        const mcpName = typeof name === 'string' ? name.trim() : '';

        const workingDirectory = (typeof directory === 'string' && directory.trim())
          ? directory.trim()
          : (ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

        if (normalizedMethod === 'GET' && !mcpName) {
          const configs = listMcpConfigs(workingDirectory);
          return { id, type, success: true, data: configs };
        }

        if (!mcpName) {
          return { id, type, success: false, error: 'MCP server name is required' };
        }

        if (normalizedMethod === 'GET') {
          const config = getMcpConfig(mcpName, workingDirectory);
          if (!config) {
            return { id, type, success: false, error: `MCP server "${mcpName}" not found` };
          }
          return { id, type, success: true, data: config };
        }

        if (normalizedMethod === 'POST') {
          const scope = body?.scope as 'user' | 'project' | undefined;
          createMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `MCP server "${mcpName}" created. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        if (normalizedMethod === 'PATCH') {
          updateMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `MCP server "${mcpName}" updated. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        if (normalizedMethod === 'DELETE') {
          deleteMcpConfig(mcpName, workingDirectory);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `MCP server "${mcpName}" deleted. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
      }

      case 'api:config/skills': {
        const { method, name, body } = (payload || {}) as { method?: string; name?: string; body?: Record<string, unknown> };
        const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

        // LIST all skills (no name provided)
        if (!name && normalizedMethod === 'GET') {
          const skills = (await fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || discoverSkills(workingDirectory);
          return { id, type, success: true, data: { skills } };
        }

        const skillName = typeof name === 'string' ? name.trim() : '';
        if (!skillName) {
          return { id, type, success: false, error: 'Skill name is required' };
        }

        if (normalizedMethod === 'GET') {
          const discoveredSkill = ((await fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || [])
            .find((skill) => skill.name === skillName);
          const sources = getSkillSources(skillName, workingDirectory, discoveredSkill || null);
          return {
            id,
            type,
            success: true,
            data: { name: skillName, sources, scope: sources.md.scope, source: sources.md.source },
          };
        }

        if (normalizedMethod === 'POST') {
          const scopeValue = body?.scope as string | undefined;
          const sourceValue = body?.source as string | undefined;
          const scope: SkillScope | undefined = scopeValue === 'project' ? SKILL_SCOPE.PROJECT : scopeValue === 'user' ? SKILL_SCOPE.USER : undefined;
          const normalizedSource = sourceValue === 'agents' ? 'agents' : 'opencode';
          createSkill(skillName, { ...(body || {}), source: normalizedSource } as Record<string, unknown>, workingDirectory, scope);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `Skill ${skillName} created successfully. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        if (normalizedMethod === 'PATCH') {
          updateSkill(skillName, (body || {}) as Record<string, unknown>, workingDirectory);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `Skill ${skillName} updated successfully. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        if (normalizedMethod === 'DELETE') {
          deleteSkill(skillName, workingDirectory);
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              requiresReload: true,
              message: `Skill ${skillName} deleted successfully. Reloading interface…`,
              reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
            },
          };
        }

        return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
      }

      case 'api:config/skills:catalog': {
        const refresh = Boolean((payload as { refresh?: boolean } | undefined)?.refresh);
        const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        const settings = readSettings(ctx);
        const rawCatalogs = (settings as { skillCatalogs?: unknown }).skillCatalogs;

        const additionalSources: SkillsCatalogSourceConfig[] = Array.isArray(rawCatalogs)
          ? (rawCatalogs
              .map((entry) => {
                if (!entry || typeof entry !== 'object') return null;
                const candidate = entry as Record<string, unknown>;
                const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
                const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
                const source = typeof candidate.source === 'string' ? candidate.source.trim() : '';
                const subpath = typeof candidate.subpath === 'string' ? candidate.subpath.trim() : '';
                if (!id || !label || !source) return null;
                const normalized: SkillsCatalogSourceConfig = {
                  id,
                  label,
                  description: source,
                  source,
                  ...(subpath ? { defaultSubpath: subpath } : {}),
                };
                return normalized;
              })
              .filter((v) => v !== null) as SkillsCatalogSourceConfig[])
          : [];

        const installedSkills = (await fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || undefined;
        const data = await getSkillsCatalog(workingDirectory, refresh, additionalSources, installedSkills);
        return { id, type, success: true, data };
      }

      case 'api:config/skills:scan': {
        const body = (payload || {}) as { source?: string; subpath?: string; gitIdentityId?: string };
        const data = await scanSkillsRepositoryFromGit({
          source: String(body.source || ''),
          subpath: body.subpath,
        });
        return { id, type, success: true, data };
      }

      case 'api:config/skills:install': {
        const body = (payload || {}) as {
          source?: string;
          subpath?: string;
          scope?: 'user' | 'project';
          targetSource?: 'opencode' | 'agents';
          selections?: Array<{ skillDir: string }>;
          conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
          conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
        };

        const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        const data = await installSkillsFromGit({
          source: String(body.source || ''),
          subpath: body.subpath,
          scope: body.scope === 'project' ? 'project' : 'user',
          targetSource: body.targetSource === 'agents' ? 'agents' : 'opencode',
          workingDirectory: body.scope === 'project' ? workingDirectory : undefined,
          selections: Array.isArray(body.selections) ? body.selections : [],
          conflictPolicy: body.conflictPolicy,
          conflictDecisions: body.conflictDecisions,
        });

        if (data.ok) {
          const installed = data.installed || [];
          const skipped = data.skipped || [];
          const requiresReload = installed.length > 0;

          if (requiresReload) {
            await ctx?.manager?.restart();
          }

          return {
            id,
            type,
            success: true,
            data: {
              ok: true,
              installed,
              skipped,
              requiresReload,
              message: requiresReload ? 'Skills installed successfully. Reloading interface…' : 'No skills were installed',
              reloadDelayMs: requiresReload ? CLIENT_RELOAD_DELAY_MS : undefined,
            },
          };
        }

        return { id, type, success: true, data };
      }

      case 'api:config/skills/files': {
        const { method, name, filePath, content } = (payload || {}) as { 
          method?: string; 
          name?: string; 
          filePath?: string; 
          content?: string;
        };
        const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        const skillName = typeof name === 'string' ? name.trim() : '';
        if (!skillName) {
          return { id, type, success: false, error: 'Skill name is required' };
        }

        const relativePath = typeof filePath === 'string' ? filePath.trim() : '';
        if (!relativePath) {
          return { id, type, success: false, error: 'File path is required' };
        }

        const discoveredSkill = ((await fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || [])
          .find((skill) => skill.name === skillName);
        const sources = getSkillSources(skillName, workingDirectory, discoveredSkill || null);
        if (!sources.md.dir) {
          return { id, type, success: false, error: `Skill "${skillName}" not found` };
        }

        const skillDir = sources.md.dir;
        const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

        if (normalizedMethod === 'GET') {
          const fileContent = readSkillSupportingFile(skillDir, relativePath);
          if (fileContent === null) {
            return { id, type, success: false, error: `File "${relativePath}" not found in skill "${skillName}"` };
          }
          return { id, type, success: true, data: { content: fileContent } };
        }

        if (normalizedMethod === 'PUT') {
          writeSkillSupportingFile(skillDir, relativePath, content || '');
          return { id, type, success: true, data: { success: true } };
        }

        if (normalizedMethod === 'DELETE') {
          deleteSkillSupportingFile(skillDir, relativePath);
          return { id, type, success: true, data: { success: true } };
        }

        return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
      }

      case 'api:opencode/directory': {
        const target = (payload as { path?: string })?.path;
        if (!target) {
          return { id, type, success: false, error: 'Path is required' };
        }
        const baseDirectory =
          ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const resolvedPath = resolveUserPath(target, baseDirectory);
        const result = await ctx?.manager?.setWorkingDirectory(resolvedPath);
        if (!result) {
          return { id, type, success: false, error: 'OpenCode manager unavailable' };
        }
        return { id, type, success: true, data: result };
      }

      case 'api:models/metadata': {
        try {
          const data = await fetchModelsMetadata();
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
        const { original, modified, label } = payload as { original: string; modified: string; label?: string };
        try {
          // If the paths are just content, we need to create virtual documents or temp files.
          // However, 'editor:openDiff' usually implies comparing two URIs.
          // If the payload contains file paths:
          const originalUri = vscode.Uri.file(original);
          const modifiedUri = vscode.Uri.file(modified);
          const title = label || `${path.basename(original)} ↔ ${path.basename(modified)}`;
          
          await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);
          return { id, type, success: true };
        } catch (error) {
           const errorMessage = error instanceof Error ? error.message : String(error);
           return { id, type, success: false, error: errorMessage };
        }
      }

       case 'api:provider/auth:delete': {
        const { providerId, scope } = (payload || {}) as { providerId?: string; scope?: string };
        if (!providerId) {
          return { id, type, success: false, error: 'Provider ID is required' };
        }
        const normalizedScope = typeof scope === 'string' ? scope : 'auth';
        try {
          let removed = false;
        if (normalizedScope === 'auth') {
          removed = removeProviderAuth(providerId);
        } else if (normalizedScope === 'user' || normalizedScope === 'project' || normalizedScope === 'custom') {
          removed = removeProviderConfig(providerId, ctx?.manager?.getWorkingDirectory(), normalizedScope);
        } else if (normalizedScope === 'all') {
          const workingDirectory = ctx?.manager?.getWorkingDirectory();
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
              reloadDelayMs: removed ? CLIENT_RELOAD_DELAY_MS : undefined,
            },
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: errorMessage };
        }
      }

       case 'api:provider/source:get': {
        const { providerId } = (payload || {}) as { providerId?: string };
        if (!providerId) {
          return { id, type, success: false, error: 'Provider ID is required' };
        }
        try {
          const sources = getProviderSources(providerId, ctx?.manager?.getWorkingDirectory());
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

      // ============== Git Operations ==============

      case 'api:git/check': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const isRepo = await gitService.checkIsGitRepository(directory);
        return { id, type, success: true, data: isRepo };
      }

      case 'api:git/worktree-type': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const isLinked = await gitService.isLinkedWorktree(directory);
        return { id, type, success: true, data: isLinked };
      }

      case 'api:git/status': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const status = await gitService.getGitStatus(directory);
        return { id, type, success: true, data: status };
      }

      case 'api:git/branches': {
        const { directory, method, name, startPoint, force } = (payload || {}) as { 
          directory?: string; 
          method?: string;
          name?: string;
          startPoint?: string;
          force?: boolean;
        };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }

        const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';

        if (normalizedMethod === 'GET') {
          const branches = await gitService.getGitBranches(directory);
          return { id, type, success: true, data: branches };
        }

        if (normalizedMethod === 'POST') {
          if (!name) {
            return { id, type, success: false, error: 'Branch name is required' };
          }
          const result = await gitService.createBranch(directory, name, startPoint);
          return { id, type, success: true, data: result };
        }

        if (normalizedMethod === 'DELETE') {
          if (!name) {
            return { id, type, success: false, error: 'Branch name is required' };
          }
          const result = await gitService.deleteGitBranch(directory, name, force);
          return { id, type, success: true, data: result };
        }

        return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
      }

      case 'api:git/remote-branches': {
        const { directory, branch, remote } = (payload || {}) as { 
          directory?: string; 
          branch?: string;
          remote?: string;
        };
        if (!directory || !branch) {
          return { id, type, success: false, error: 'Directory and branch are required' };
        }
        const result = await gitService.deleteRemoteBranch(directory, branch, remote);
        return { id, type, success: true, data: result };
      }

      case 'api:git/checkout': {
        const { directory, branch } = (payload || {}) as { directory?: string; branch?: string };
        if (!directory || !branch) {
          return { id, type, success: false, error: 'Directory and branch are required' };
        }
        const result = await gitService.checkoutBranch(directory, branch);
        return { id, type, success: true, data: result };
      }

      case 'api:git/worktrees': {
        const { directory, method } = (payload || {}) as {
          directory?: string;
          method?: string;
          body?: unknown;
          directoryPath?: string;
          deleteLocalBranch?: boolean;
        };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }

        const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';

        if (normalizedMethod === 'GET') {
          const worktrees = await gitService.listGitWorktrees(directory);
          return { id, type, success: true, data: worktrees };
        }

        if (normalizedMethod === 'POST') {
          const created = await gitService.createWorktree(directory, (payload || {}) as gitService.CreateGitWorktreePayload);
          return { id, type, success: true, data: created };
        }

        if (normalizedMethod === 'DELETE') {
          const removePayload = payload as {
            body?: { directory?: string; deleteLocalBranch?: boolean };
            directory?: string;
            deleteLocalBranch?: boolean;
          };
          const bodyDirectory = typeof removePayload?.body?.directory === 'string'
            ? removePayload.body.directory
            : '';
          const legacyDirectory = typeof removePayload?.directory === 'string' ? removePayload.directory : '';
          const worktreeDirectory = bodyDirectory || legacyDirectory || '';

          if (!worktreeDirectory) {
            return { id, type, success: false, error: 'Worktree directory is required' };
          }
          const removed = await gitService.removeWorktree(directory, {
            directory: worktreeDirectory,
            deleteLocalBranch: removePayload?.body?.deleteLocalBranch === true || removePayload?.deleteLocalBranch === true,
          });
          return { id, type, success: true, data: { success: Boolean(removed) } };
        }

        return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
      }

      case 'api:git/worktrees/validate': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.validateWorktreeCreate(directory, (payload || {}) as gitService.CreateGitWorktreePayload);
        return { id, type, success: true, data: result };
      }

      case 'api:git/diff': {
        const { directory, path: filePath, staged, contextLines } = (payload || {}) as { 
          directory?: string; 
          path?: string;
          staged?: boolean;
          contextLines?: number;
        };
        if (!directory || !filePath) {
          return { id, type, success: false, error: 'Directory and path are required' };
        }
        const result = await gitService.getGitDiff(directory, filePath, staged, contextLines);
        return { id, type, success: true, data: result };
      }

      case 'api:git/file-diff': {
        const { directory, path: filePath, staged } = (payload || {}) as { 
          directory?: string; 
          path?: string;
          staged?: boolean;
        };
        if (!directory || !filePath) {
          return { id, type, success: false, error: 'Directory and path are required' };
        }
        const result = await gitService.getGitFileDiff(directory, filePath, staged);
        return { id, type, success: true, data: result };
      }

      case 'api:git/revert': {
        const { directory, path: filePath } = (payload || {}) as { directory?: string; path?: string };
        if (!directory || !filePath) {
          return { id, type, success: false, error: 'Directory and path are required' };
        }
        await gitService.revertGitFile(directory, filePath);
        return { id, type, success: true, data: { success: true } };
      }

      case 'api:git/commit': {
        const { directory, message, addAll, files } = (payload || {}) as { 
          directory?: string; 
          message?: string;
          addAll?: boolean;
          files?: string[];
        };
        if (!directory || !message) {
          return { id, type, success: false, error: 'Directory and message are required' };
        }
        const result = await gitService.createGitCommit(directory, message, { addAll, files });
        return { id, type, success: true, data: result };
      }

      case 'api:git/push': {
        const { directory, remote, branch, options } = (payload || {}) as { 
          directory?: string; 
          remote?: string;
          branch?: string;
          options?: string[] | Record<string, unknown>;
        };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.gitPush(directory, { remote, branch, options });
        return { id, type, success: true, data: result };
      }

      case 'api:git/pull': {
        const { directory, remote, branch } = (payload || {}) as { 
          directory?: string; 
          remote?: string;
          branch?: string;
        };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.gitPull(directory, { remote, branch });
        return { id, type, success: true, data: result };
      }

      case 'api:git/fetch': {
        const { directory, remote, branch } = (payload || {}) as { 
          directory?: string; 
          remote?: string;
          branch?: string;
        };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.gitFetch(directory, { remote, branch });
        return { id, type, success: true, data: result };
      }

      case 'api:git/remotes': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.getRemotes(directory);
        return { id, type, success: true, data: result };
      }

      case 'api:git/rebase': {
        const { directory, onto } = (payload || {}) as { directory?: string; onto?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        if (!onto) {
          return { id, type, success: false, error: 'onto is required' };
        }
        const result = await gitService.rebase(directory, { onto });
        return { id, type, success: true, data: result };
      }

      case 'api:git/rebase/abort': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.abortRebase(directory);
        return { id, type, success: true, data: result };
      }

      case 'api:git/merge': {
        const { directory, branch } = (payload || {}) as { directory?: string; branch?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        if (!branch) {
          return { id, type, success: false, error: 'branch is required' };
        }
        const result = await gitService.merge(directory, { branch });
        return { id, type, success: true, data: result };
      }

      case 'api:git/merge/abort': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.abortMerge(directory);
        return { id, type, success: true, data: result };
      }

      case 'api:git/rebase/continue': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.continueRebase(directory);
        return { id, type, success: true, data: result };
      }

      case 'api:git/merge/continue': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.continueMerge(directory);
        return { id, type, success: true, data: result };
      }

      case 'api:git/stash': {
        const { directory, message, includeUntracked } = (payload || {}) as {
          directory?: string;
          message?: string;
          includeUntracked?: boolean;
        };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.stash(directory, { message, includeUntracked });
        return { id, type, success: true, data: result };
      }

      case 'api:git/stash/pop': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.stashPop(directory);
        return { id, type, success: true, data: result };
      }

      case 'api:git/log': {
        const { directory, maxCount, from, to, file } = (payload || {}) as { 
          directory?: string; 
          maxCount?: number;
          from?: string;
          to?: string;
          file?: string;
        };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        const result = await gitService.getGitLog(directory, { maxCount, from, to, file });
        return { id, type, success: true, data: result };
      }

      case 'api:git/commit-files': {
        const { directory, hash } = (payload || {}) as { directory?: string; hash?: string };
        if (!directory || !hash) {
          return { id, type, success: false, error: 'Directory and hash are required' };
        }
        const result = await gitService.getCommitFiles(directory, hash);
        return { id, type, success: true, data: result };
      }

      case 'api:git/pr-description': {
        const { directory, base, head, context, providerId, modelId, zenModel: payloadZenModel } = (payload || {}) as {
          directory?: string;
          base?: string;
          head?: string;
          context?: string;
          providerId?: string;
          modelId?: string;
          zenModel?: string;
        };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }
        if (!base || !head) {
          return { id, type, success: false, error: 'base and head are required' };
        }

        // Collect diffs (best-effort)
        let files: string[] = [];
        try {
          const listed = await gitService.getGitRangeFiles(directory, base, head);
          files = Array.isArray(listed) ? listed : [];
        } catch {
          files = [];
        }

        if (files.length === 0) {
          return { id, type, success: false, error: 'No diffs available for base...head' };
        }

        let diffSummaries = '';
        for (const file of files) {
          try {
            const diff = await gitService.getGitRangeDiff(directory, base, head, file, 3);
            const raw = typeof diff?.diff === 'string' ? diff.diff : '';
            if (!raw.trim()) continue;
            diffSummaries += `FILE: ${file}\n${raw}\n\n`;
          } catch {
            // ignore
          }
        }

        if (!diffSummaries.trim()) {
          return { id, type, success: false, error: 'No diffs available for selected files' };
        }

        const prompt = `You are drafting a GitHub Pull Request title + description. Respond in JSON of the shape {"title": string, "body": string} (ONLY JSON in response, no markdown fences) with these rules:\n- title: concise, sentence case, <= 80 chars, no trailing punctuation, no commit-style prefixes (no "feat:", "fix:")\n- body: GitHub-flavored markdown with these sections in this order: Summary, Testing, Notes\n- Summary: 3-6 bullet points describing user-visible changes; avoid internal helper function names\n- Testing: bullet list ("- Not tested" allowed)\n- Notes: bullet list; include breaking/rollout notes only when relevant\n\nContext:\n- base branch: ${base}\n- head branch: ${head}${context?.trim() ? `\n- Additional context: ${context.trim()}` : ''}\n\nDiff summary:\n${diffSummaries}`;

        try {
          const apiUrl = ctx?.manager?.getApiUrl();
          if (!apiUrl) {
            return { id, type, success: false, error: 'OpenCode API unavailable' };
          }

          const settings = readSettings(ctx) as Record<string, unknown>;
          const { providerID, modelID } = await resolveBridgeGitGenerationModel(
            { providerId, modelId, zenModel: payloadZenModel },
            settings,
            apiUrl,
            ctx?.manager?.getOpenCodeAuthHeaders()
          );
          const raw = await generateBridgeTextWithSessionFlow({
            apiUrl,
            directory,
            prompt,
            providerID,
            modelID,
            authHeaders: ctx?.manager?.getOpenCodeAuthHeaders(),
          });
          if (!raw) {
            return { id, type, success: false, error: 'No PR description returned by generator' };
          }

          const cleaned = String(raw)
            .trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

          const parsed = parseJsonObjectSafe(cleaned) || parseJsonObjectSafe(raw);
          if (parsed) {
            const title = typeof parsed.title === 'string' ? parsed.title : '';
            const body = typeof parsed.body === 'string' ? parsed.body : '';
            return { id, type, success: true, data: { title, body } };
          }

          return { id, type, success: true, data: { title: '', body: String(raw) } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      case 'api:git/identity': {
        const { directory, method, userName, userEmail, sshKey } = (payload || {}) as { 
          directory?: string; 
          method?: string;
          userName?: string;
          userEmail?: string;
          sshKey?: string | null;
        };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }

        const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';

        if (normalizedMethod === 'GET') {
          const identity = await gitService.getCurrentGitIdentity(directory);
          return { id, type, success: true, data: identity };
        }

        if (normalizedMethod === 'POST') {
          if (!userName || !userEmail) {
            return { id, type, success: false, error: 'userName and userEmail are required' };
          }
          const result = await gitService.setGitIdentity(directory, userName, userEmail, sshKey);
          return { id, type, success: true, data: result };
        }

        return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
      }

      case 'api:git/ignore-openchamber': {
        // LEGACY_WORKTREES: only needed for <project>/.openchamber era. Safe to remove after legacy support dropped.
        // This is now a no-op since the function was removed with legacy worktree support.
        return { id, type, success: true, data: { success: true } };
      }

      case 'api:git/conflict-details': {
        const { directory } = (payload || {}) as { directory?: string };
        if (!directory) {
          return { id, type, success: false, error: 'Directory is required' };
        }

        try {
          // Get git status --porcelain
          const statusResult = await execGit(['status', '--porcelain'], directory);
          const statusPorcelain = statusResult.stdout;

          // Get unmerged files (files with conflicts)
          const unmergedResult = await execGit(['diff', '--name-only', '--diff-filter=U'], directory);
          const unmergedFiles = unmergedResult.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

          // Get current diff
          const diffResult = await execGit(['diff'], directory);
          const diff = diffResult.stdout;

          // Detect operation type and get head info
          let operation: 'merge' | 'rebase' = 'merge';
          let headInfo = '';

          // Check for MERGE_HEAD (merge in progress)
          const mergeHeadResult = await execGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], directory);
          const mergeHeadExists = mergeHeadResult.exitCode === 0;

          if (mergeHeadExists) {
            operation = 'merge';
            const mergeHead = mergeHeadResult.stdout.trim();
            // Try to read MERGE_MSG file
            let mergeMsg = '';
            try {
              const mergeMsgPath = path.join(directory, '.git', 'MERGE_MSG');
              mergeMsg = await fs.promises.readFile(mergeMsgPath, 'utf8');
            } catch {
              // MERGE_MSG may not exist
            }
            headInfo = `MERGE_HEAD: ${mergeHead}${mergeMsg ? '\n' + mergeMsg : ''}`;
          } else {
            // Check for REBASE_HEAD (rebase in progress)
            const rebaseHeadResult = await execGit(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], directory);
            const rebaseHeadExists = rebaseHeadResult.exitCode === 0;

            if (rebaseHeadExists) {
              operation = 'rebase';
              const rebaseHead = rebaseHeadResult.stdout.trim();
              headInfo = `REBASE_HEAD: ${rebaseHead}`;
            }
          }

          return {
            id,
            type,
            success: true,
            data: {
              statusPorcelain: statusPorcelain.trim(),
              unmergedFiles,
              diff: diff.trim(),
              headInfo: headInfo.trim(),
              operation,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { id, type, success: false, error: message };
        }
      }

      default:
        return { id, type, success: false, error: `Unknown message type: ${type}` };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { id, type, success: false, error: errorMessage };
  }
}
