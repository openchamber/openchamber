import os from 'node:os';
import path from 'node:path';

const GUARDIAN_DIRECTORY_NAME = 'managed-opencode-handoff-v2';

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const resolveExplicitPath = (value, label) => {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value) || !path.isAbsolute(value.trim())) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(value.trim());
};

const resolveBaseDataDir = ({ platform, env, dataDir }) => {
  const explicit = dataDir ?? env.OPENCHAMBER_DATA_DIR;
  if (isNonEmptyString(explicit)) {
    if (!path.isAbsolute(explicit.trim())) {
      throw new TypeError('OpenChamber data directory must be an absolute path');
    }
    return path.resolve(explicit.trim());
  }

  if (platform === 'win32') {
    const localAppData = isNonEmptyString(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA.trim()
      : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(path.resolve(localAppData), 'openchamber');
  }

  const stateHome = isNonEmptyString(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME.trim()
    : path.join(os.homedir(), '.local', 'state');
  return path.join(path.resolve(stateHome), 'openchamber');
};

/**
 * Resolve every guardian-owned path from one input contract.
 *
 * `rootDir` is an explicit guardian root override used by isolated tests and
 * by callers which already resolved a data directory. `dataDir` is the
 * installation/runtime data directory and is expanded with the same
 * `managed-opencode-handoff-v2` suffix on every platform. `socketPath` and
 * `portPath` are transport overrides; when the active platform uses one of
 * them without an explicit data root, the derived auth secret follows that
 * same custom transport root instead of silently falling back to the process
 * environment's default. An explicit `rootDir`/`dataDir` remains authoritative
 * for the auth secret even when the transport path is overridden.
 */
export function resolveGuardianPaths({
  platform = process.platform,
  env = process.env,
  dataDir,
  rootDir,
  socketPath,
  portPath,
} = {}) {
  const baseDir = rootDir === undefined
    ? resolveBaseDataDir({ platform, env, dataDir })
    : null;
  const guardianRoot = rootDir === undefined
    ? path.join(baseDir, GUARDIAN_DIRECTORY_NAME)
    : path.resolve(rootDir);

  const root = path.resolve(guardianRoot);
  const explicitSocketPath = resolveExplicitPath(socketPath, 'Guardian socket path');
  const explicitPortPath = resolveExplicitPath(portPath, 'Guardian port path');
  const resolvedSocketPath = explicitSocketPath
    ?? (platform === 'win32' ? undefined : path.join(root, 'guardian.sock'));
  const resolvedPortPath = explicitPortPath
    ?? (platform === 'win32' ? path.join(root, 'port') : undefined);
  const activeTransportPath = platform === 'win32' ? resolvedPortPath : resolvedSocketPath;
  const hasExplicitDataRoot = rootDir !== undefined
    || isNonEmptyString(dataDir)
    || isNonEmptyString(env.OPENCHAMBER_DATA_DIR);
  const authRoot = !hasExplicitDataRoot && (platform === 'win32' ? explicitPortPath : explicitSocketPath)
    ? path.dirname(activeTransportPath)
    : root;

  return Object.freeze({
    platform,
    dataDir: baseDir ?? path.dirname(root),
    rootDir: root,
    pidFile: path.join(root, 'guardian.pid'),
    socketPath: resolvedSocketPath,
    portPath: resolvedPortPath,
    authSecretPath: path.join(authRoot, 'guardian-auth.secret'),
    storePath: path.join(root, 'records.sqlite3'),
    logFile: path.join(root, 'guardian.log'),
  });
}

export const GUARDIAN_PATHS = Object.freeze({
  directoryName: GUARDIAN_DIRECTORY_NAME,
});
