import { registerOpenCodeProxy } from './proxy.js';
import { isString } from '../shared/guards.js';
import { pathLooksUserConfigured, mergePathValues } from './path-utils.js';

export const createServerUtilsRuntime = (dependencies) => {
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
    // A verified PowerShell 7 install directory, or null. Only the Windows
    // managed PATH uses it; see `prependStablePowerShellDirectory`.
    getStablePowerShell7Directory = () => null,
    getArchivedSessions = null,
    getMergeSpaceSessionList = null,
    getSpaceEventHub = null,
    getStoredSessionMetadata = null,
  } = dependencies;

  const setOpenCodePort = (port) => {
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

  const getEnvValue = (name) => {
    const env = process.env || {};
    if (typeof env[name] === 'string') return env[name];
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key && typeof env[key] === 'string' ? env[key] : '';
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
      const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      try {
        if (fs.existsSync(trimmed)) existing.push(trimmed);
      } catch {
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

  // OpenCode resolves the shell interpreter by name through PATH. On Windows a
  // Store-installed PowerShell 7 answers through the app-execution alias in the
  // WindowsApps directory, whose target embeds the package version; OpenCode
  // canonicalizes that once and keeps the absolute path, so a Store upgrade
  // leaves every later spawn pointing at a folder that no longer exists
  // (#4895). A verified PowerShell 7 install directory goes in front of the
  // whole PATH, where by-name resolution hits a path that never changes. The
  // remaining entries keep their order and nothing is duplicated.
  let loggedStablePowerShellDirectory = null;
  const prependStablePowerShellDirectory = (pathValue) => {
    if (process.platform !== 'win32') {
      return pathValue;
    }

    const directory = getStablePowerShell7Directory();
    if (!isString(directory) || !directory.trim()) {
      return pathValue;
    }

    const trimmed = directory.trim();
    const merged = mergePathValues(trimmed, pathValue, path.delimiter);
    if (merged !== pathValue && loggedStablePowerShellDirectory !== trimmed) {
      loggedStablePowerShellDirectory = trimmed;
      console.log(`[OpenCode] Prepending verified PowerShell 7 directory to the managed PATH: ${trimmed}`);
    }
    return merged;
  };

  const buildManagedOpenCodePath = () => {
    const currentPath = getEnvValue('PATH');
    const loginShellPath = getLoginShellPath();
    const basePath = mergePathValues(loginShellPath || '', currentPath, path.delimiter);
    const toolchainPath = mergePathValues(basePath, buildWindowsManagedToolchainPath(), path.delimiter);

    return prependStablePowerShellDirectory(toolchainPath);
  };

  const parseSseDataPayload = (block) => {
    if (!block || typeof block !== 'string') {
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
      const parsed = JSON.parse(payloadText);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.payload === 'object' &&
        parsed.payload !== null
      ) {
        return parsed.payload;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  const setupProxy = (app) => {
    registerOpenCodeProxy(app, {
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
      getStoredSessionMetadata,
      // Read when the proxy is set up, after `main` decided whether the spaces host exists.
      mergeSpaceSessionList: typeof getMergeSpaceSessionList === 'function' ? getMergeSpaceSessionList() : null,
      spaceEventHub: typeof getSpaceEventHub === 'function' ? getSpaceEventHub() : null,
    });
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
