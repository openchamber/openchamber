import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';

const WINDOWS_EXECUTABLE_EXTENSIONS = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
  .split(';')
  .map((ext) => ext.trim().toLowerCase())
  .filter(Boolean)
  .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

let cachedDetectedOpencodeCliPath: string | undefined;

export function readOpenChamberSettings(): Record<string, unknown> {
  const settingsPath = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function isExecutable(filePath: string): boolean {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    // Windows executability is extension-based.
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) return true;
      return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Windows launch spec: .cmd/.bat shims (and bare names, which resolve to .cmd
// shims via PATHEXT) must run under cmd.exe. Spawn cmd.exe DIRECTLY with the
// shim path as its own argv element (shell:false) — `shell: true` builds an
// unquoted command line, so a space-containing path like
// "C:\Program Files\nodejs\opencode.cmd" broke with
// "'C:\Program' is not recognized as an internal or external command".
export function resolveWindowsLaunchSpec(binary: string, args: string[]): { binary: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { binary, args };
  }
  const trimmed = (binary || '').trim();
  const ext = path.extname(trimmed).toLowerCase();
  const isBatchShim = ext === '.cmd' || ext === '.bat';
  const isBareName = !ext && !trimmed.includes('\\') && !trimmed.includes('/');
  if (!isBatchShim && !isBareName) {
    return { binary: trimmed, args };
  }
  return {
    binary: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', 'call', trimmed, ...args],
  };
}

// Strip a single wrapping quote pair (Windows "Copy as path" and quoted shell
// snippets) — literal quotes are never part of a real path and break every
// executable check.
export function stripWrappingQuotes(value: string): string {
  const trimmed = (value || '').trim();
  if (trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function appendToPath(dir: string) {
  const trimmed = (dir || '').trim();
  if (!trimmed) return;
  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(trimmed)) return;
  process.env.PATH = [trimmed, ...parts].join(path.delimiter);
}

export function findExecutableInPath(binaryName: string): string | null {
  const trimmed = (binaryName || '').trim();
  if (!trimmed) {
    return null;
  }

  const current = process.env.PATH || '';
  if (!current) {
    return null;
  }

  const extensions = process.platform === 'win32' ? WINDOWS_EXECUTABLE_EXTENSIONS : [''];
  for (const segment of current.split(path.delimiter)) {
    const dir = segment.trim();
    if (!dir) {
      continue;
    }

    for (const ext of extensions) {
      const candidate = path.join(dir, process.platform === 'win32' ? `${trimmed}${ext}` : trimmed);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function normalizeConfiguredOpencodeBinary(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = stripWrappingQuotes(raw);
  if (!trimmed) {
    return null;
  }
  try {
    const stat = fs.statSync(trimmed);
    if (stat.isDirectory()) {
      return path.join(trimmed, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    }
  } catch {
    // Keep the explicit path so strict startup validation can report it.
  }
  return trimmed;
}

export function isMacOpenCodeAppBundlePath(candidate: string): boolean {
  return process.platform === 'darwin' && /\/OpenCode(?: Dev| Beta)?\.app\/Contents\/MacOS\/(?:OpenCode(?: Dev| Beta)?|opencode-cli)$/i.test(candidate);
}

export function isWindowsOpenCodeDesktopAppPath(candidate: string): boolean {
  if (process.platform !== 'win32' || typeof candidate !== 'string') {
    return false;
  }
  const localAppData = typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA.trim()
    ? path.resolve(process.env.LOCALAPPDATA).toLowerCase()
    : '';
  if (!localAppData) {
    return false;
  }
  const normalized = path.resolve(candidate).toLowerCase();
  return normalized.startsWith(`${localAppData}${path.sep}`)
    && normalized.endsWith(`${path.sep}programs${path.sep}opencode${path.sep}opencode.exe`);
}

export function isKnownOpenCodeDesktopAppPath(candidate: string): boolean {
  return isMacOpenCodeAppBundlePath(candidate) || isWindowsOpenCodeDesktopAppPath(candidate);
}

function createConfiguredOpencodeBinaryError(raw: string, normalized: string): Error {
  const messageSuffix = 'OpenChamber needs the standalone opencode CLI. Install it and set openchamber.opencodeBinary to the CLI path, for example ~/.opencode/bin/opencode, or leave the setting empty to use PATH lookup.';
  if (isKnownOpenCodeDesktopAppPath(raw) || isKnownOpenCodeDesktopAppPath(normalized)) {
    const platformName = process.platform === 'win32' ? 'Windows desktop app install' : 'macOS desktop app bundle';
    return new Error(`Configured OpenCode binary points at the ${platformName}, not the CLI: ${normalized}. ${messageSuffix}`);
  }

  try {
    const rawStat = fs.statSync(raw);
    if (rawStat.isDirectory()) {
      return new Error(`Configured OpenCode binary directory does not contain an executable ${process.platform === 'win32' ? 'opencode.exe' : 'opencode'}: ${raw}. ${messageSuffix}`);
    }
  } catch {
    // The normalized path check below produces the missing-path error.
  }

  try {
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) {
      return new Error(`Configured OpenCode binary is not a file: ${normalized}. ${messageSuffix}`);
    }
    return new Error(`Configured OpenCode binary is not executable: ${normalized}. ${messageSuffix}`);
  } catch {
    return new Error(`Configured OpenCode binary not found: ${normalized}. ${messageSuffix}`);
  }
}

export function validateConfiguredOpencodeBinaryForManagedStart(): string | null {
  const candidates: string[] = [];
  try {
    // Lazy-load vscode so pure discovery helpers can be unit-tested without the extension host.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscodeApi = require('vscode') as typeof import('vscode');
    const config = vscodeApi.workspace.getConfiguration('openchamber');
    const raw = config.get<string>('opencodeBinary') || '';
    if (raw.trim()) {
      candidates.push(raw.trim());
    }
  } catch {
    // ignore
  }

  try {
    const settings = readOpenChamberSettings();
    const raw = typeof settings.opencodeBinary === 'string' ? settings.opencodeBinary.trim() : '';
    if (raw) {
      candidates.push(raw);
    }
  } catch {
    // ignore
  }

  const raw = candidates[0];
  if (!raw) {
    return null;
  }

  const normalized = normalizeConfiguredOpencodeBinary(raw);
  if (!normalized) {
    return null;
  }

  if (isExecutable(normalized) && !isKnownOpenCodeDesktopAppPath(normalized)) {
    return normalized;
  }

  throw createConfiguredOpencodeBinaryError(raw, normalized);
}

export function resolveOpencodeCliPath(): string | null {
  const configured = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vscodeApi = require('vscode') as typeof import('vscode');
      const config = vscodeApi.workspace.getConfiguration('openchamber');
      return normalizeConfiguredOpencodeBinary(config.get<string>('opencodeBinary') || '');
    } catch {
      return null;
    }
  })();

  if (configured && isExecutable(configured) && !isKnownOpenCodeDesktopAppPath(configured)) {
    return configured;
  }

  const sharedFromOpenChamber = (() => {
    try {
      const settings = readOpenChamberSettings();
      const candidate = settings.opencodeBinary;
      if (typeof candidate !== 'string') {
        return null;
      }
      return normalizeConfiguredOpencodeBinary(candidate);
    } catch {
      return null;
    }
  })();

  if (sharedFromOpenChamber && isExecutable(sharedFromOpenChamber) && !isKnownOpenCodeDesktopAppPath(sharedFromOpenChamber)) {
    return sharedFromOpenChamber;
  }

  const explicit = [
    process.env.OPENCODE_BINARY,
    process.env.OPENCODE_PATH,
    process.env.OPENCHAMBER_OPENCODE_PATH,
    process.env.OPENCHAMBER_OPENCODE_BIN,
  ]
    .map((v) => (typeof v === 'string' ? stripWrappingQuotes(v) : ''))
    .filter(Boolean);

  for (const candidate of explicit) {
    if (isExecutable(candidate) && !isKnownOpenCodeDesktopAppPath(candidate)) {
      return candidate;
    }
  }

  if (cachedDetectedOpencodeCliPath) {
    if (isExecutable(cachedDetectedOpencodeCliPath) && !isKnownOpenCodeDesktopAppPath(cachedDetectedOpencodeCliPath)) {
      return cachedDetectedOpencodeCliPath;
    }
    cachedDetectedOpencodeCliPath = undefined;
  }

  const home = os.homedir();
  const unixFallbacks = [
    path.join(home, '.opencode', 'bin', 'opencode'),
    path.join(home, '.bun', 'bin', 'opencode'),
    path.join(home, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
    path.join(home, 'bin', 'opencode'),
  ];

  const winFallbacks = (() => {
    const userProfile = process.env.USERPROFILE || home;
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    const npmDir = path.join(appData, 'npm');

    return [
      path.join(userProfile, '.opencode', 'bin', 'opencode.exe'),
      path.join(userProfile, '.opencode', 'bin', 'opencode.cmd'),
      path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      path.join(npmDir, 'opencode.exe'),
      path.join(npmDir, 'opencode.cmd'),
      path.join(npmDir, 'opencode.bat'),
      // System-wide Node installer keeps the global npm prefix here
      // (npm i -g opencode-ai → opencode.cmd shim).
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'opencode.cmd'),
      path.join(userProfile, 'scoop', 'shims', 'opencode.exe'),
      path.join(userProfile, 'scoop', 'shims', 'opencode.cmd'),
      path.join(programData, 'chocolatey', 'bin', 'opencode.exe'),
      path.join(programData, 'chocolatey', 'bin', 'opencode.cmd'),
      // Bun global install
      path.join(userProfile, '.bun', 'bin', 'opencode.exe'),
      path.join(userProfile, '.bun', 'bin', 'opencode.cmd'),
    ].filter(Boolean);
  })();

  if (process.platform !== 'win32') {
    const fromPath = findExecutableInPath('opencode');
    if (fromPath && !isKnownOpenCodeDesktopAppPath(fromPath)) {
      cachedDetectedOpencodeCliPath = fromPath;
      return fromPath;
    }
  }

  const fallbacks = process.platform === 'win32' ? winFallbacks : unixFallbacks;
  for (const candidate of fallbacks) {
    if (isExecutable(candidate) && !isKnownOpenCodeDesktopAppPath(candidate)) {
      cachedDetectedOpencodeCliPath = candidate;
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    const fromPath = findExecutableInPath('opencode');
    if (fromPath && !isKnownOpenCodeDesktopAppPath(fromPath)) {
      cachedDetectedOpencodeCliPath = fromPath;
      return fromPath;
    }

    try {
      const result = spawnSync('where', ['opencode'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        const lines = (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const found = lines.find((line) => isExecutable(line) && !isKnownOpenCodeDesktopAppPath(line));
        if (found) {
          cachedDetectedOpencodeCliPath = found;
          return found;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export function clearCachedDetectedOpencodeCliPath(): void {
  cachedDetectedOpencodeCliPath = undefined;
}
