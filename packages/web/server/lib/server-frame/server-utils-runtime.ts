import { registerOpenCodeProxy } from '../opencode/proxy.js';
import type { OpenCodeProxyDependencies } from '../opencode/proxy.js';
import { pathLooksUserConfigured, mergePathValues } from '../opencode/path-utils.js';
import type { Application } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import { isString } from '../shared/object-guards.js';

interface ServerUtilsDependencies extends Pick<OpenCodeProxyDependencies,
  'getRuntime' | 'getOpenCodeAuthHeaders' | 'buildOpenCodeUrl' | 'ensureOpenCodeApiPrefix'
  | 'getArchivedSessions' | 'getUnreadBaseline' | 'hiddenSessions' | 'getStoredSessionMetadata'
  | 'openCodeTrust' | 'mcpOAuthSignIn' | 'chatsRoot' | 'getSessionDirectoryCanonicalizer'> {
  fs: NonNullable<OpenCodeProxyDependencies['fs']> & Pick<typeof import('node:fs'), 'existsSync'>;
  os: Pick<typeof import('node:os'), 'homedir'>;
  path: Pick<typeof import('node:path'), 'join' | 'delimiter'>;
  process: Pick<NodeJS.Process, 'platform' | 'env'>;
  openCodeReadyGraceMs: number;
  longRequestTimeoutMs: number;
  getUpstreamStallTimeoutMs: NonNullable<OpenCodeProxyDependencies['getSseUpstreamStallTimeoutMs']>;
  getUiNotificationClients: () => ReadonlySet<import('node:http').ServerResponse>;
  getOpenCodePort: () => number | null;
  setOpenCodePortState: (port: number) => void;
  syncToHmrState: () => void;
  markOpenCodeNotReady: () => void;
  setOpenCodeNotReadySince: (at: number) => void;
  clearLastOpenCodeError: () => void;
  getLoginShellPath: () => string | null;
  getMergeSpaceSessionList?: (() => NonNullable<OpenCodeProxyDependencies['mergeSpaceSessionList']> | null) | null;
  getSpaceEventHub?: (() => NonNullable<OpenCodeProxyDependencies['spaceEventHub']> | null) | null;
  readWorktreeBootstrapStatus: NonNullable<OpenCodeProxyDependencies['readWorktreeBootstrapStatus']>;
}

const hasPayloadField = (value: JsonValue): value is { payload?: JsonValue } =>
  value !== null && typeof value === 'object';

const isObjectPayload = (value: JsonValue | undefined): value is JsonValue[] | JsonObject =>
  value !== null && typeof value === 'object';

const isCallback = <Result>(value: (() => Result) | null): value is () => Result =>
  typeof value === 'function';

export const createServerUtilsRuntime = (dependencies: ServerUtilsDependencies) => {
  const {
    fs,
    os,
    path,
    process,
    openCodeReadyGraceMs,
    longRequestTimeoutMs,
    getRuntime,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    getUpstreamStallTimeoutMs,
    getUiNotificationClients,
    getOpenCodePort,
    setOpenCodePortState,
    syncToHmrState,
    markOpenCodeNotReady,
    setOpenCodeNotReadySince,
    clearLastOpenCodeError,
    getLoginShellPath,
    getArchivedSessions = null,
    getUnreadBaseline = null,
    getMergeSpaceSessionList = null,
    getSpaceEventHub = null,
    hiddenSessions = null,
    getStoredSessionMetadata = null,
    openCodeTrust = null,
    mcpOAuthSignIn = null,
    readWorktreeBootstrapStatus,
    chatsRoot = null,
    getSessionDirectoryCanonicalizer = null,
  } = dependencies;

  const setOpenCodePort = (port: number) => {
    if (!Number.isFinite(port) || port <= 0) {
      return;
    }

    const numericPort = Math.trunc(port);
    const currentPort = getOpenCodePort();
    const portChanged = currentPort !== numericPort;

    if (portChanged || currentPort === null) {
      setOpenCodePortState(numericPort);
      syncToHmrState();
      console.log(`Detected OpenCode port: ${numericPort}`);

      if (portChanged) {
        markOpenCodeNotReady();
      }
      setOpenCodeNotReadySince(Date.now());
    }

    clearLastOpenCodeError();
  };

  const waitForOpenCodePort = async (timeoutMs = 15000) => {
    if (getOpenCodePort() !== null) {
      return getOpenCodePort();
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (getOpenCodePort() !== null) {
        return getOpenCodePort();
      }
    }

    throw new Error('Timed out waiting for OpenCode port');
  };

  const getEnvValue = (name: string) => {
    const env = process.env || {};
    if (isString(env[name])) return env[name];
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key && isString(env[key]) ? env[key] : '';
  };

  const buildWindowsManagedToolchainPath = () => {
    if (process.platform !== 'win32') return '';

    const home = os.homedir();
    const userProfile = getEnvValue('USERPROFILE') || home;
    const appData = getEnvValue('APPDATA') || (userProfile ? path.join(userProfile, 'AppData', 'Roaming') : '');
    const localAppData = getEnvValue('LOCALAPPDATA') || (userProfile ? path.join(userProfile, 'AppData', 'Local') : '');
    const programFiles = getEnvValue('ProgramFiles') || 'C:\\Program Files';
    const programFilesX86 = getEnvValue('ProgramFiles(x86)');
    const programData = getEnvValue('ProgramData') || 'C:\\ProgramData';
    const bunInstall = getEnvValue('BUN_INSTALL');
    const voltaHome = getEnvValue('VOLTA_HOME');
    const scoop = getEnvValue('SCOOP');
    const scoopGlobal = getEnvValue('SCOOP_GLOBAL');

    const candidates = [
      path.join(appData, 'npm'),
      path.join(programFiles, 'nodejs'),
      programFilesX86 ? path.join(programFilesX86, 'nodejs') : '',
      path.join(localAppData, 'Programs', 'nodejs'),
      getEnvValue('PNPM_HOME'),
      path.join(localAppData, 'pnpm'),
      bunInstall ? path.join(bunInstall, 'bin') : '',
      path.join(userProfile, '.bun', 'bin'),
      voltaHome ? path.join(voltaHome, 'bin') : '',
      path.join(localAppData, 'Volta', 'bin'),
      path.join(localAppData, 'Yarn', 'bin'),
      path.join(localAppData, 'Yarn', 'Data', 'global', 'node_modules', '.bin'),
      scoop ? path.join(scoop, 'shims') : '',
      path.join(userProfile, 'scoop', 'shims'),
      scoopGlobal ? path.join(scoopGlobal, 'shims') : '',
      path.join(programData, 'chocolatey', 'bin'),
      path.join(localAppData, 'Microsoft', 'WindowsApps'),
      path.join(userProfile, '.opencode', 'bin'),
      path.join(userProfile, '.local', 'bin'),
    ];

    const seen = new Set();
    const existing = [];
    for (const candidate of candidates) {
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      try {
        if (fs.existsSync(trimmed)) existing.push(trimmed);
      } catch {
        continue;
      }
    }

    return existing.join(path.delimiter);
  };

  const buildAugmentedPath = () => {
    const currentPath = getEnvValue('PATH');
    const loginShellPath = getLoginShellPath();
    const home = os.homedir();
    const currentPathLooksUserConfigured = pathLooksUserConfigured(currentPath, home, path.delimiter);
    const primaryPath = currentPathLooksUserConfigured ? currentPath : loginShellPath;
    const fallbackPath = currentPathLooksUserConfigured ? loginShellPath : currentPath;

    return mergePathValues(primaryPath, fallbackPath, path.delimiter);
  };

  const buildManagedOpenCodePath = () => {
    const currentPath = getEnvValue('PATH');
    const loginShellPath = getLoginShellPath();
    const basePath = mergePathValues(loginShellPath || '', currentPath, path.delimiter);

    return mergePathValues(basePath, buildWindowsManagedToolchainPath(), path.delimiter);
  };

  const parseSseDataPayload = (block: string | null | undefined) => {
    if (!block || !isString(block)) {
      return null;
    }
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^\s/, ''));

    if (dataLines.length === 0) {
      return null;
    }

    const payloadText = dataLines.join('\n').trim();
    if (!payloadText) {
      return null;
    }

    try {
      const parsed: JsonValue = JSON.parse(payloadText);
      if (
        parsed &&
        hasPayloadField(parsed) &&
        isObjectPayload(parsed.payload)
      ) {
        return parsed.payload;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  const setupProxy = (app: Application) => {
    const proxyDependencies = {
      fs,
      os,
      path,
      OPEN_CODE_READY_GRACE_MS: openCodeReadyGraceMs,
      LONG_REQUEST_TIMEOUT_MS: longRequestTimeoutMs,
      getRuntime,
      getOpenCodeAuthHeaders,
      buildOpenCodeUrl,
      ensureOpenCodeApiPrefix,
      getSseUpstreamStallTimeoutMs: getUpstreamStallTimeoutMs,
      getUiNotificationClients,
      getArchivedSessions,
      getUnreadBaseline,
      getStoredSessionMetadata,
      mergeSpaceSessionList: isCallback(getMergeSpaceSessionList) ? getMergeSpaceSessionList() : null,
      spaceEventHub: isCallback(getSpaceEventHub) ? getSpaceEventHub() : null,
      hiddenSessions,
      openCodeTrust,
      mcpOAuthSignIn,
      readWorktreeBootstrapStatus,
      chatsRoot,
      getSessionDirectoryCanonicalizer,
    };
    registerOpenCodeProxy(app, proxyDependencies);
  };

  return {
    setOpenCodePort,
    waitForOpenCodePort,
    buildAugmentedPath,
    buildManagedOpenCodePath,
    parseSseDataPayload,
    setupProxy,
  };
};
