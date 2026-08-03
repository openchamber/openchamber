import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path, { win32 as windowsPath } from 'node:path';
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
const WINDOWS_SYSTEM_TOOL_RELATIVE_PATHS = Object.freeze({
  powershell: ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'],
  icacls: ['System32', 'icacls.exe'],
  whoami: ['System32', 'whoami.exe'],
});
const WINDOWS_SYSTEM_TOOL_FALLBACK_ROOT = 'C:\\Windows';

const normalizeWindowsSystemToolName = (toolName) => {
  if (typeof toolName !== 'string') return null;
  const normalized = toolName.trim().toLowerCase();
  return normalized.endsWith('.exe') ? normalized.slice(0, -4) : normalized;
};

const resolveWindowsSystemRoot = (systemRoot) => {
  const root = typeof systemRoot === 'string' ? systemRoot.trim() : '';
  return /^[A-Za-z]:[\\/]/.test(root) && windowsPath.isAbsolute(root)
    ? root
    : WINDOWS_SYSTEM_TOOL_FALLBACK_ROOT;
};

/**
 * Resolve an inbox Windows system tool without consulting PATH or the current
 * working directory. SystemRoot is accepted only when it is a local absolute
 * Windows path; the fixed fallback is also absolute and is used only when
 * that trusted root is unavailable or malformed.
 */
const WINDOWS_SYSTEM_TOOL_FALLBACK_PATHS = Object.freeze(
  Object.fromEntries(
    Object.entries(WINDOWS_SYSTEM_TOOL_RELATIVE_PATHS).map(([toolName, relativePath]) => [
      toolName,
      windowsPath.join(WINDOWS_SYSTEM_TOOL_FALLBACK_ROOT, ...relativePath),
    ]),
  ),
);

export function resolveWindowsSystemToolPath(toolName, systemRoot = process.env.SystemRoot) {
  const normalizedToolName = normalizeWindowsSystemToolName(toolName);
  const relativePath = normalizedToolName
    ? WINDOWS_SYSTEM_TOOL_RELATIVE_PATHS[normalizedToolName]
    : undefined;
  if (!relativePath) {
    throw new TypeError(`Unsupported Windows system tool: ${String(toolName)}`);
  }
  return windowsPath.join(resolveWindowsSystemRoot(systemRoot), ...relativePath);
}

export const WINDOWS_POWERSHELL_FALLBACK_PATH = WINDOWS_SYSTEM_TOOL_FALLBACK_PATHS.powershell;

export function resolveWindowsPowerShellPath(systemRoot = process.env.SystemRoot) {
  return resolveWindowsSystemToolPath('powershell', systemRoot);
}

const runWindowsPowerShellQuery = (script, {
  spawnSync,
  systemRoot,
} = {}) => spawnSync(resolveWindowsPowerShellPath(systemRoot), [
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
  shell: false,
});

const windowsStartTicks = (pid, spawnSync, systemRoot) => {
  const script = `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
  const result = runWindowsPowerShellQuery(script, { spawnSync, systemRoot });
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
  systemRoot,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      return parseLinuxStartTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    }
    if (platform === 'win32') {
      return windowsStartTicks(pid, spawnSync, systemRoot);
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
  systemRoot,
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
      const result = runWindowsPowerShellQuery(script, { spawnSync, systemRoot });
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
  systemRoot,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const stat = fs.statSync(`/proc/${pid}`);
      return Number.isSafeInteger(stat.uid) && stat.uid >= 0 ? String(stat.uid) : null;
    }
    if (platform === 'win32') {
      const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${String(pid)}\").GetOwner().User`;
      const result = runWindowsPowerShellQuery(script, { spawnSync, systemRoot });
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

const normalizeWindowsCommandToken = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && !/[\x00-\x1F\x7F]/.test(normalized)
    ? normalized.toLocaleLowerCase('en-US')
    : null;
};

/**
 * Parse the ordinary argv form emitted by CreateProcess/Win32_Process. This
 * intentionally rejects an unterminated quote instead of falling back to a
 * substring check, because command identity is used before a destructive
 * operation.
 */
const parseWindowsCommandLine = (value) => {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!input) return null;

  const tokens = [];
  let token = '';
  let tokenStarted = false;
  let inQuotes = false;
  let index = 0;

  const pushToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };

  while (index < input.length) {
    const character = input[index];
    if (character === '\\') {
      const start = index;
      while (index < input.length && input[index] === '\\') index += 1;
      const slashCount = index - start;
      if (input[index] === '"') {
        token += '\\'.repeat(Math.floor(slashCount / 2));
        tokenStarted = true;
        if (slashCount % 2 === 1) {
          token += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
          index += 1;
        }
      } else {
        token += '\\'.repeat(slashCount);
        tokenStarted = true;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = !inQuotes;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (/\s/.test(character) && !inQuotes) {
      pushToken();
      index += 1;
      continue;
    }
    token += character;
    tokenStarted = true;
    index += 1;
  }

  if (inQuotes) return null;
  pushToken();
  return tokens.length > 0 ? tokens : null;
};

const isQualifiedWindowsExecutable = (value) => /[\\/:]/.test(value);

const normalizeWindowsExecutable = (value) => {
  const normalized = normalizeWindowsCommandToken(value);
  return normalized ? normalized.replaceAll('/', '\\') : null;
};

const windowsExecutableStem = (value) => {
  const normalized = normalizeWindowsExecutable(value);
  if (!normalized) return null;
  const basename = windowsPath.basename(normalized);
  return basename.replace(/\.(?:exe|cmd|bat)$/i, '');
};

const buildWindowsLaunchTokens = (launchSpec, port = launchSpec?.port) => {
  if (!launchSpec || typeof launchSpec !== 'object') return null;
  if (typeof launchSpec.binary !== 'string' || !launchSpec.binary.trim()) return null;
  if (!Array.isArray(launchSpec.args) || launchSpec.args.some((arg) => typeof arg !== 'string')) return null;
  if (typeof launchSpec.hostname !== 'string' || !launchSpec.hostname.trim()) return null;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535 || launchSpec.port !== port) return null;
  const values = [
    launchSpec.binary,
    ...launchSpec.args,
    'serve',
    '--hostname',
    launchSpec.hostname,
    '--port',
    String(port),
  ];
  return values.every((value) => normalizeWindowsCommandToken(value) !== null) ? values : null;
};

/**
 * Compare a live Windows command line with the exact launch argv we recorded.
 * Only an unqualified executable may use the basename/stem compatibility rule
 * needed for PATH-resolved `opencode`/`node` launches. Every supplied argument
 * and the required serve/hostname/port tuple must match as a complete token.
 */
export function matchesWindowsProcessLaunchIdentity(commandLine, launchSpec, { port } = {}) {
  const expected = buildWindowsLaunchTokens(launchSpec, port ?? launchSpec?.port);
  const actual = parseWindowsCommandLine(commandLine);
  if (!expected || !actual || expected.length !== actual.length) return false;

  const expectedBinary = normalizeWindowsExecutable(expected[0]);
  const actualBinary = normalizeWindowsExecutable(actual[0]);
  if (!expectedBinary || !actualBinary) return false;
  if (expectedBinary !== actualBinary) {
    if (isQualifiedWindowsExecutable(expectedBinary)) return false;
    if (windowsExecutableStem(expectedBinary) !== windowsExecutableStem(actualBinary)) return false;
  }

  for (let index = 1; index < expected.length; index += 1) {
    if (normalizeWindowsCommandToken(expected[index]) !== normalizeWindowsCommandToken(actual[index])) {
      return false;
    }
  }
  return true;
}

const normalizeWindowsCommandLine = (value) => {
  const tokens = parseWindowsCommandLine(value);
  if (!tokens) return null;
  const normalized = tokens.map(normalizeWindowsCommandToken);
  return normalized.every(Boolean) ? normalized.join('\u0000') : null;
};

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
export function compareProcessIdentity(expected, actual, { platform = process.platform } = {}) {
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
  const expectedCommandLine = platform === 'win32'
    ? normalizeWindowsCommandLine(expectedIdentity.launch.commandLine)
    : normalizeCommandLine(expectedIdentity.launch.commandLine);
  const actualCommandLine = platform === 'win32'
    ? normalizeWindowsCommandLine(actualIdentity.launch.commandLine)
    : normalizeCommandLine(actualIdentity.launch.commandLine);
  if (!expectedCommandLine || !actualCommandLine || expectedCommandLine !== actualCommandLine) {
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
  WINDOWS_POWERSHELL_FALLBACK_PATH,
  WINDOWS_SYSTEM_TOOL_FALLBACK_PATHS,
  parseLinuxStartTicks,
  normalizeCommandLine,
  normalizeStartTicks,
  normalizeIdentityText,
  normalizeLaunch,
  normalizeWindowsSystemToolName,
  resolveWindowsSystemRoot,
  normalizeWindowsCommandToken,
  parseWindowsCommandLine,
  normalizeWindowsCommandLine,
  buildWindowsLaunchTokens,
};
