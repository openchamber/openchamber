import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isString } from '../shared/guards.js';
import { getExecutableSearchDirectories, getWindowsAppsDirectory } from '../tunnels/executable-search.js';

// Resolving the Windows PowerShell interpreter the managed OpenCode shell will
// use, and finding a PowerShell 7 install whose path does not change under the
// user's feet (#4895).
//
// The failing class this file exists for: a Store-installed PowerShell 7 is
// reachable through the app-execution alias
// `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`, an NTFS reparse point whose
// target embeds the package version under `C:\Program Files\WindowsApps`. The
// OpenCode server resolves `pwsh` once, canonicalizes it to that versioned
// target and keeps the absolute string for the life of the process. A Store
// upgrade renames the package folder, and every later shell spawn dies with
// ERROR_PATH_NOT_FOUND before the interpreter starts. That cache belongs to the
// OpenCode server; nothing here can empty it. What this module can do is put a
// pwsh whose path never changes in front of the alias directory, and say out
// loud which interpreter the shell is actually going to run.

// An interpreter is verified by running it, never by its path existing: a
// half-removed MSI, a quarantined file and a stale reparse target all sit at a
// path that looks right. A healthy PowerShell answers in well under a second,
// so a probe that overruns is abandoned rather than holding the server's event
// loop, and the whole resolution stops once its budget is spent.
const WINDOWS_POWERSHELL_PROBE_TIMEOUT_MS = 2_000;
const WINDOWS_POWERSHELL_PROBE_BUDGET_MS = 5_000;
const MINIMUM_POWERSHELL_MAJOR = 7;

// Version and the executable that actually ran. `Get-Process` reports the real
// module path, so the alias case shows the versioned target the OpenCode server
// would cache rather than the alias it was called through.
const VERSION_PROBE_COMMAND = '[Console]::Out.Write("$($PSVersionTable.PSVersion)|$((Get-Process -Id $PID -ErrorAction SilentlyContinue).Path)")';
const VERSION_PROBE_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VERSION_PROBE_COMMAND];

const firstNonEmpty = (...values) => {
  for (const value of values) {
    if (isString(value) && value.trim()) return value.trim();
  }
  return '';
};

const withPath = (env, pathValue) => ({ ...env, PATH: pathValue, Path: pathValue, path: pathValue });

const legacyWindowsPowerShellPath = ({ env, path: pathApi }) => pathApi.join(
  firstNonEmpty(env.SystemRoot, env.SYSTEMROOT, env.systemroot) || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);

/**
 * Directories a PowerShell 7 install lives in and keeps its name across a Store
 * upgrade. A Store install has no such directory, which is why a machine that
 * only has the Store build cannot be helped by PATH alone.
 */
export const getStablePowerShell7Directories = ({ env = process.env, platform = process.platform, path: pathApi = path } = {}) => {
  if (platform !== 'win32') return [];

  const programFiles = firstNonEmpty(env.ProgramFiles, env.PROGRAMFILES, env.programfiles) || 'C:\\Program Files';
  const localAppData = firstNonEmpty(env.LOCALAPPDATA, env.LocalAppData, env.localappdata);

  const directories = [
    pathApi.join(programFiles, 'PowerShell', '7'),
    pathApi.join(programFiles, 'PowerShell', '7-preview'),
  ];
  if (localAppData) {
    directories.push(pathApi.join(localAppData, 'Microsoft', 'PowerShell', '7'));
  }
  return directories;
};

const parseVersionProbeOutput = (raw) => {
  const text = isString(raw) ? raw.trim() : '';
  if (!text) return null;

  const line = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).pop();
  if (!line) return null;

  const [versionText = '', executableText = ''] = line.split('|');
  const version = versionText.trim();
  // A preview build answers with a version like `7.5.0-preview.4`, which is a
  // usable PowerShell 7 and must not be read as "no interpreter".
  if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.]+)?$/.test(version)) return null;

  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major)) return null;

  return {
    version,
    major,
    executable: executableText.trim() || null,
  };
};

const versionParts = (version) => String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);

const isNewerVersion = (candidate, current) => {
  const left = versionParts(candidate);
  const right = versionParts(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

export const createWindowsPowerShellResolver = ({
  env = process.env,
  platform = process.platform,
  path: pathApi = path,
  spawnSync: runSpawnSync = spawnSync,
  timeoutMs = WINDOWS_POWERSHELL_PROBE_TIMEOUT_MS,
} = {}) => {
  // Probing costs a process, so one result per executable and PATH is kept for
  // the life of the resolver. The managed server can restart many times in one
  // app run and must not pay for the same answer again.
  const probeCache = new Map();
  let stableResolved = false;
  let stableDirectory = null;
  let stableProbe = null;
  const reportCache = new Map();

  const probe = (executable, pathValue) => {
    const key = `${executable}\u0000${pathValue ?? ''}`;
    if (probeCache.has(key)) return probeCache.get(key);

    let result = null;
    try {
      const spawned = runSpawnSync(executable, VERSION_PROBE_ARGS, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        timeout: timeoutMs,
        env: withPath(env, pathValue),
      });
      if (spawned && spawned.status === 0) {
        result = parseVersionProbeOutput(spawned.stdout);
      }
    } catch {
      result = null;
    }

    probeCache.set(key, result);
    return result;
  };

  // The PATH the resolver reports against when the caller has none of its own.
  const defaultPathValue = () => firstNonEmpty(env.PATH, env.Path, env.path);

  // The absolute files a bare name resolves to, in the order the Windows loader
  // tries them. Handing the name to spawnSync would answer something else: a
  // bare name is looked up with the calling process's PATH, and the child `env`
  // block is applied only after the lookup, so the probe would describe the
  // server's own PATH rather than the managed PATH it is reporting on.
  const nameCandidates = (name, pathValue) => getExecutableSearchDirectories({
    env: withPath(env, pathValue),
    platform,
  }).map((directory) => pathApi.join(directory, name));

  const probeName = (name, pathValue, deadline) => {
    for (const candidate of nameCandidates(name, pathValue)) {
      if (Date.now() > deadline) return null;
      const probed = probe(candidate, pathValue);
      if (probed) return probed;
    }
    return null;
  };

  // A PowerShell 7 this machine has whatever the managed PATH reaches. The alias
  // directory comes from the user profile rather than from LOCALAPPDATA on
  // purpose: the managed PATH is built from LOCALAPPDATA, so asking that same
  // source twice could never disagree and the downgrade warning below could
  // never fire.
  const userAliasCandidates = () => {
    const userProfile = firstNonEmpty(env.USERPROFILE, env.UserProfile, env.userprofile);
    const directory = getWindowsAppsDirectory(userProfile ? { USERPROFILE: userProfile } : {});
    return directory ? [pathApi.join(directory, 'pwsh.exe')] : [];
  };

  // The stable install to prepend, verified by running it. The newest of the
  // stable directories wins, so a leftover older install never shadows a newer
  // one that sits beside it.
  const resolveStable = () => {
    if (platform !== 'win32') return null;
    if (stableResolved) return stableDirectory ? { directory: stableDirectory, probe: stableProbe } : null;
    stableResolved = true;

    const deadline = Date.now() + WINDOWS_POWERSHELL_PROBE_BUDGET_MS;
    for (const directory of getStablePowerShell7Directories({ env, platform, path: pathApi })) {
      if (Date.now() > deadline) break;
      const probed = probe(pathApi.join(directory, 'pwsh.exe'), defaultPathValue());
      if (!probed || probed.major < MINIMUM_POWERSHELL_MAJOR) continue;
      if (!stableProbe || isNewerVersion(probed.version, stableProbe.version)) {
        stableDirectory = directory;
        stableProbe = probed;
      }
    }

    return stableDirectory ? { directory: stableDirectory, probe: stableProbe } : null;
  };

  /**
   * What the managed shell will run, given the PATH OpenChamber hands it.
   *
   * `installed` is a PowerShell 7 this machine has: the one the managed PATH
   * already resolves, or a stable install, or the Store alias under the user's
   * own profile. `effective` is what the shell resolves by name from the given
   * PATH. The two differ only when PowerShell 7 is installed but reachable
   * through something the managed PATH does not carry, which is the one case
   * worth naming in a warning.
   */
  const describe = ({ managedPath } = {}) => {
    if (platform !== 'win32') return null;

    const effectivePathValue = isString(managedPath) && managedPath ? managedPath : defaultPathValue();
    if (reportCache.has(effectivePathValue)) return reportCache.get(effectivePathValue);

    const deadline = Date.now() + WINDOWS_POWERSHELL_PROBE_BUDGET_MS;
    const stable = resolveStable();
    const effectiveProbe = probeName('pwsh.exe', effectivePathValue, deadline)
      ?? probeName('powershell.exe', effectivePathValue, deadline)
      ?? probe(legacyWindowsPowerShellPath({ env, path: pathApi }), effectivePathValue);

    const installedProbe = (() => {
      if (effectiveProbe && effectiveProbe.major >= MINIMUM_POWERSHELL_MAJOR) return effectiveProbe;
      if (stable && stable.probe) return stable.probe;
      for (const candidate of userAliasCandidates()) {
        if (Date.now() > deadline) return null;
        const probed = probe(candidate, effectivePathValue);
        if (probed && probed.major >= MINIMUM_POWERSHELL_MAJOR) return probed;
      }
      return null;
    })();

    const downgrade = installedProbe !== null
      && (!effectiveProbe || effectiveProbe.major < MINIMUM_POWERSHELL_MAJOR);
    const label = (probeResult) => (probeResult.major >= MINIMUM_POWERSHELL_MAJOR
      ? `PowerShell ${probeResult.version}`
      : `Windows PowerShell ${probeResult.version}`);
    const effectiveLabel = effectiveProbe
      ? label(effectiveProbe)
      : 'no PowerShell interpreter';

    const report = {
      summary: effectiveProbe
        ? `Shell interpreter: ${effectiveLabel} at ${effectiveProbe.executable || '<unknown>'}`
        : 'Shell interpreter: none found, PowerShell commands will not run',
      warning: downgrade
        ? `The OpenCode shell runs ${effectiveLabel}, but this machine has ${label(installedProbe)} at `
          + `${installedProbe.executable || '<unknown>'}. Windows PowerShell 5.1 reads and writes files with the `
          + 'system ANSI code page, so commands that touch UTF-8 files can corrupt them.'
        : null,
      diagnostics: {
        insertedDirectory: stable ? stable.directory : null,
        pwshPath: installedProbe ? installedProbe.executable : null,
        pwshVersion: installedProbe ? installedProbe.version : null,
        effectivePath: effectiveProbe ? effectiveProbe.executable : null,
        effectiveVersion: effectiveProbe ? effectiveProbe.version : null,
        downgrade,
      },
    };

    reportCache.set(effectivePathValue, report);
    return report;
  };

  return {
    getStableDirectory: () => (resolveStable() ? stableDirectory : null),
    describe,
  };
};
