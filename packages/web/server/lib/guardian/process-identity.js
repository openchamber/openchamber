import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync as defaultSpawnSync } from 'node:child_process';

const parseLinuxStartTicks = (statLine) => {
  if (typeof statLine !== 'string') return null;
  const closingParen = statLine.lastIndexOf(')');
  if (closingParen < 0) return null;
  const fields = statLine.slice(closingParen + 2).trim().split(/\s+/);
  // /proc/<pid>/stat field 22 is index 19 after the comm field.
  const ticks = fields[19];
  return /^(?:0|[1-9]\d*)$/.test(ticks) ? ticks : null;
};

const normalizeCommandLine = (value) => String(value ?? '')
  .split('\0')
  .filter(Boolean)
  .join('\u0000');

const normalizeIdentityText = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 4096
    ? normalized
    : null;
};

const normalizeStartTicks = (value) => {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  return null;
};

const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 5000;

const windowsStartTicks = (pid, spawnSync) => {
  const script = `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result?.error || result?.status !== 0) return null;
  const ticks = String(result.stdout ?? '').replace(/^\uFEFF/, '').trim();
  // DateTime.Ticks is commonly larger than Number.MAX_SAFE_INTEGER. Keep
  // the canonical decimal text all the way through persistence and MAC
  // comparisons instead of rounding it through a JavaScript Number.
  return /^(?:0|[1-9]\d*)$/.test(ticks) ? ticks : null;
};

/** Return a process start identity that detects PID reuse when possible. */
export function readProcessStartTicks(pid, {
  platform = process.platform,
  spawnSync = defaultSpawnSync,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      return parseLinuxStartTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    }
    if (platform === 'win32') {
      return windowsStartTicks(pid, spawnSync);
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const started = String(result?.stdout ?? '').trim();
    if (!started) return null;
    const digest = createHash('sha256').update(started).digest('hex').slice(0, 12);
    return Number.parseInt(digest, 16).toString();
  } catch {
    return null;
  }
}

/** Read enough live process metadata to verify a durable launch fingerprint. */
export function readProcessLaunchIdentity(pid, {
  platform = process.platform,
  spawnSync = defaultSpawnSync,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      return { commandLine: normalizeCommandLine(commandLine), cwd };
    }
    if (platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Filter \"ProcessId = ${String(pid)}\" | Select-Object -ExpandProperty CommandLine`;
      const result = spawnSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        script,
      ], {
        encoding: 'utf8',
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
      });
      if (result?.error || result?.status !== 0) return null;
      const commandLine = String(result?.stdout ?? '').trim();
      // Win32_Process does not provide a reliable working-directory field.
      // Keep this explicit rather than inferring cwd from command-line text.
      return commandLine ? { commandLine: normalizeCommandLine(commandLine), cwd: null } : null;
    }
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const commandLine = String(result?.stdout ?? '').trim();
    return commandLine ? { commandLine: normalizeCommandLine(commandLine), cwd: null } : null;
  } catch {
    return null;
  }
}

/**
 * Read the operating-system owner for a process when the platform exposes it.
 * A missing owner is intentionally represented as null: callers can require
 * it when a persisted marker contains one, while still using start-time and
 * command-line identity on platforms where owner lookup is not reliable.
 */
export function readProcessOwnerIdentity(pid, {
  platform = process.platform,
  spawnSync = defaultSpawnSync,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const stat = fs.statSync(`/proc/${pid}`);
      return Number.isSafeInteger(stat.uid) && stat.uid >= 0 ? String(stat.uid) : null;
    }
    if (platform === 'win32') {
      const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${String(pid)}\").GetOwner().User`;
      const result = spawnSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        script,
      ], {
        encoding: 'utf8',
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
      });
      if (result?.error || result?.status !== 0) return null;
      return normalizeIdentityText(String(result.stdout ?? '').replace(/^\uFEFF/, ''));
    }
    const result = spawnSync('ps', ['-o', 'user=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return normalizeIdentityText(result?.stdout);
  } catch {
    return null;
  }
}

/** Read all supported process identity fields through one shared seam. */
export function readProcessIdentity(pid, options = {}) {
  const processStartTicks = readProcessStartTicks(pid, options);
  const launch = readProcessLaunchIdentity(pid, options);
  const owner = readProcessOwnerIdentity(pid, options);
  if (processStartTicks === null && !launch && owner === null) return null;
  return {
    processStartTicks,
    launch,
    owner,
  };
}

/**
 * Distinguish a definitely exited process from an alive or ambiguous one.
 * Permission and other probe failures are deliberately unknown so callers
 * cannot turn an inaccessible process into a safe signal target.
 */
export function probeProcessLiveness(pid, { killFn = process.kill } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'dead';
  try {
    killFn(pid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

const normalizeLaunch = (launch) => {
  if (!launch || typeof launch !== 'object') return null;
  const commandLine = normalizeCommandLine(launch.commandLine);
  if (!commandLine) return null;
  const cwd = normalizeIdentityText(launch.cwd);
  return { commandLine, cwd };
};

/** Normalize persisted or inspected identity data without guessing fields. */
export function normalizeProcessIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const processStartTicks = normalizeStartTicks(identity.processStartTicks);
  const launch = normalizeLaunch(identity.launch);
  const owner = normalizeIdentityText(identity.owner);
  if (processStartTicks === null && !launch && owner === null) return null;
  return { processStartTicks, launch, owner };
}

/**
 * Compare the durable identity with a fresh OS observation. Returns null on a
 * match, otherwise a stable diagnostic suitable for fail-closed callers.
 */
export function compareProcessIdentity(expected, actual) {
  const expectedIdentity = normalizeProcessIdentity(expected);
  const actualIdentity = normalizeProcessIdentity(actual);
  if (!expectedIdentity || !actualIdentity) return 'process identity is unavailable';
  if (expectedIdentity.processStartTicks === null) return 'process start identity is unavailable';
  if (actualIdentity.processStartTicks === null) return 'process start identity is unavailable';
  if (expectedIdentity.processStartTicks !== actualIdentity.processStartTicks) {
    return 'process start identity changed';
  }

  if (!expectedIdentity.launch?.commandLine || !actualIdentity.launch?.commandLine) {
    return 'process launch identity is unavailable';
  }
  if (expectedIdentity.launch.commandLine !== actualIdentity.launch.commandLine) {
    return 'process command line identity changed';
  }
  if (expectedIdentity.launch.cwd !== null) {
    if (actualIdentity.launch.cwd === null) return 'process working directory identity is unavailable';
    if (path.resolve(actualIdentity.launch.cwd) !== path.resolve(expectedIdentity.launch.cwd)) {
      return 'process working directory identity changed';
    }
  }
  if (expectedIdentity.owner !== null) {
    if (actualIdentity.owner === null) return 'process owner identity is unavailable';
    if (expectedIdentity.owner !== actualIdentity.owner) return 'process owner identity changed';
  }
  return null;
}

export const __test__ = {
  parseLinuxStartTicks,
  normalizeCommandLine,
  normalizeStartTicks,
  normalizeIdentityText,
  normalizeLaunch,
};
