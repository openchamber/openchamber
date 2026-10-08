import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const WINDOWS_EXECUTABLE_EXTENSIONS = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
  .split(';')
  .map((ext) => ext.trim().toLowerCase())
  .filter(Boolean)
  .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

export function isExecutable(filePath: string): boolean {
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

export function isMacOpenCodeAppBundlePath(candidate: string): boolean {
  return process.platform === 'darwin' && /\/OpenCode(?: Dev| Beta)?\.app\/Contents\/MacOS\/(?:OpenCode(?: Dev| Beta)?|opencode-cli)$/i.test(candidate);
}

function isWindowsOpenCodeDesktopAppPath(candidate: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }
  const localAppDataPath = process.env.LOCALAPPDATA;
  if (!localAppDataPath?.trim()) {
    return false;
  }
  const localAppData = path.resolve(localAppDataPath).toLowerCase();
  const normalized = path.resolve(candidate).toLowerCase();
  return normalized.startsWith(`${localAppData}${path.sep}`)
    && normalized.endsWith(`${path.sep}programs${path.sep}opencode${path.sep}opencode.exe`);
}

export function isKnownOpenCodeDesktopAppPath(candidate: string): boolean {
  return isMacOpenCodeAppBundlePath(candidate) || isWindowsOpenCodeDesktopAppPath(candidate);
}

function findExecutableInPath(binaryName: string): string | null {
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
      if (isExecutable(candidate) && !isKnownOpenCodeDesktopAppPath(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

let cachedDetectedOpencodeCliPath: string | undefined;

export function resolveDetectedOpencodeCliPath(): string | null {
  const fromPath = findExecutableInPath('opencode');
  if (fromPath) {
    cachedDetectedOpencodeCliPath = fromPath;
    return fromPath;
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

  const fallbacks = process.platform === 'win32' ? winFallbacks : unixFallbacks;
  for (const candidate of fallbacks) {
    if (isExecutable(candidate) && !isKnownOpenCodeDesktopAppPath(candidate)) {
      cachedDetectedOpencodeCliPath = candidate;
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where', ['opencode'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 10_000,
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
