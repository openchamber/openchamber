import { installOpenCodeV2, supportsOpenCodeV2Install } from '../../web/server/lib/opencode/v2-install.js';
import { describeOpenCodeCompatibility, readOpenCodeCliVersion, readExternalOpenCodeVersion, readOpenCodeInfo, isSupportedOpenCodeVersion, type OpenCodeCompatibility } from '../../web/server/lib/opencode/compatibility.js';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { normalizeWindowsDriveLetter } from './pathUtils';
import { resolveWorkingDirectoryChange } from './workingDirectoryChange';
import { reapOrphanedProcesses } from './opencodeProcessRegistry';
import { applyProviderEnvAliases } from './provider-env-aliases';
import { checkOpenCodeVersionOutput } from './opencodeVersion';
import { runOpenCodeCliUpgrade } from '../../web/server/lib/opencode/cli-upgrade.js';
import { spawnManagedOpenCodeProcess } from './managed-opencode-process';

const t = vscode.l10n.t;

const READY_CHECK_TIMEOUT_MS = 30000;

// Reuse a single output channel across restarts instead of creating (and
// leaking) a new one on every waitForReady call.
let managerOutputChannel: vscode.OutputChannel | null = null;

function getManagerOutputChannel(): vscode.OutputChannel {
  if (!managerOutputChannel) {
    managerOutputChannel = vscode.window.createOutputChannel('OpenChamberManager');
  }
  return managerOutputChannel;
}
const WINDOWS_EXECUTABLE_EXTENSIONS = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
  .split(';')
  .map((ext) => ext.trim().toLowerCase())
  .filter(Boolean)
  .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

type OpenCodeDebugInfo = {
  mode: 'managed' | 'external';
  status: ConnectionStatus;
  lastError?: string;
  workingDirectory: string;
  cliAvailable: boolean;
  cliPath: string | null;
  configuredApiUrl: string | null;
  configuredPort: number | null;
  detectedPort: number | null;
  apiPrefix: string;
  apiPrefixDetected: boolean;
  startCount: number;
  restartCount: number;
  lastStartAt: number | null;
  lastConnectedAt: number | null;
  lastExitCode: number | null;
  serverUrl: string | null;
  lastReadyElapsedMs: number | null;
  lastReadyAttempts: number | null;
  lastStartAttempts: number | null;
  version: string | null;
  secureConnection: boolean;
  authSource: 'user-env' | 'generated' | 'rotated' | null;
};

type SetWorkingDirectoryResult =
  | { success: true; path: string }
  | { success: false; error: string };

export interface OpenCodeManager {
  start(workdir?: string): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  upgradeCli(): Promise<void>;
  installV2(): Promise<void>;
  getCompatibility(): Promise<OpenCodeCompatibility>;
  setWorkingDirectory(path: string): Promise<SetWorkingDirectoryResult>;
  getStatus(): ConnectionStatus;
  getApiUrl(): string | null;
  getOpenCodeAuthHeaders(): Record<string, string>;
  getWorkingDirectory(): string;
  isCliAvailable(): boolean;
  getDebugInfo(): OpenCodeDebugInfo;
  onStatusChange(callback: (status: ConnectionStatus, error?: string) => void): vscode.Disposable;
}

function generateSecureOpenCodePassword(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildOpenCodeAuthHeader(password: string): string {
  const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode';
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function isValidOpenCodePassword(password: string): boolean {
  return typeof password === 'string' && password.trim().length > 0;
}

function readOpenChamberSettings(): Record<string, unknown> {
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

function resolvePortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    return parsed.port ? parseInt(parsed.port, 10) : null;
  } catch {
    return null;
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
function resolveWindowsLaunchSpec(binary: string, args: string[]): { binary: string; args: string[] } {
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
function stripWrappingQuotes(value: string): string {
  const trimmed = (value || '').trim();
  if (trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function appendToPath(dir: string) {
  const trimmed = (dir || '').trim();
  if (!trimmed) return;
  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(trimmed)) return;
  process.env.PATH = [trimmed, ...parts].join(path.delimiter);
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
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

let cachedDetectedOpencodeCliPath: string | undefined;

function normalizeConfiguredOpencodeBinary(raw: unknown): string | null {
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

function isMacOpenCodeAppBundlePath(candidate: string): boolean {
  return process.platform === 'darwin' && /\/OpenCode(?: Dev| Beta)?\.app\/Contents\/MacOS\/(?:OpenCode(?: Dev| Beta)?|opencode-cli)$/i.test(candidate);
}

function isWindowsOpenCodeDesktopAppPath(candidate: string): boolean {
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

function isKnownOpenCodeDesktopAppPath(candidate: string): boolean {
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

function validateConfiguredOpencodeBinaryForManagedStart(): string | null {
  const candidates: string[] = [];
  try {
    const config = vscode.workspace.getConfiguration('openchamber');
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

function resolveOpencodeCliPath(): string | null {
  const configured = (() => {
    try {
      const config = vscode.workspace.getConfiguration('openchamber');
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

type ReadyResult =
  | { ok: true; baseUrl: string; elapsedMs: number; attempts: number; version: string | null }
  | { ok: false; elapsedMs: number; attempts: number; version: null };

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function getCandidateBaseUrls(serverUrl: string): string[] {
  const normalized = normalizeBaseUrl(serverUrl);
  try {
    const parsed = new URL(normalized);
    const origin = parsed.origin;

    const candidates: string[] = [];
    const add = (url: string) => {
      const v = normalizeBaseUrl(url);
      if (!candidates.includes(v)) candidates.push(v);
    };

    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    // Prefer plain origin. Only keep SDK url when already root.
    add(origin);
    if (normalizedPath === '' || normalizedPath === '/') {
      add(normalized);
    }

    return candidates;
  } catch {
    return [normalized];
  }
}

let cachedLoginShellEnvSnapshot: Record<string, string> | null | undefined;

function parseNullSeparatedEnvSnapshot(raw: string): Record<string, string> | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  const result: Record<string, string> = {};
  const entries = raw.split('\0');
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    const idx = entry.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    result[key] = value;
  }

  return Object.keys(result).length > 0 ? result : null;
}

function getWindowsShellEnvSnapshot(): Record<string, string> | null {
  const parseResult = (stdout: string | null | undefined) => parseNullSeparatedEnvSnapshot(typeof stdout === 'string' ? stdout : '');

  const psScript =
    "Get-ChildItem Env: | ForEach-Object { [Console]::Out.Write($_.Name); [Console]::Out.Write('='); [Console]::Out.Write($_.Value); [Console]::Out.Write([char]0) }";

  const powershellCandidates = [
    'pwsh.exe',
    'powershell.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];

  for (const shellPath of powershellCandidates) {
    try {
      const result = spawnSync(shellPath, ['-NoLogo', '-Command', psScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      if (result.status !== 0) {
        continue;
      }
      const parsed = parseResult(result.stdout);
      if (parsed) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  const comspec = process.env.ComSpec || 'cmd.exe';
  try {
    const result = spawnSync(comspec, ['/d', '/s', '/c', 'set'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.length > 0) {
      return parseNullSeparatedEnvSnapshot(result.stdout.replace(/\r?\n/g, '\0'));
    }
  } catch {
    return null;
  }

  return null;
}

function getLoginShellEnvSnapshot(): Record<string, string> | null {
  if (cachedLoginShellEnvSnapshot !== undefined) {
    return cachedLoginShellEnvSnapshot;
  }

  // Avoid interactive POSIX login shells in the extension host.
  if (process.platform !== 'win32') {
    cachedLoginShellEnvSnapshot = null;
    return null;
  }

  const windowsSnapshot = getWindowsShellEnvSnapshot();
  cachedLoginShellEnvSnapshot = windowsSnapshot;
  return windowsSnapshot;
}

function mergePathValues(preferred: string, fallback: string): string {
  const merged = new Set<string>();
  const addSegments = (value: string) => {
    if (typeof value !== 'string' || !value) {
      return;
    }
    for (const segment of value.split(path.delimiter)) {
      if (segment) {
        merged.add(segment);
      }
    }
  };

  addSegments(preferred);
  addSegments(fallback);
  return Array.from(merged).join(path.delimiter);
}

function applyLoginShellEnvSnapshot() {
  const snapshot = getLoginShellEnvSnapshot();
  if (!snapshot) {
    return;
  }

  const skipKeys = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
  for (const [key, value] of Object.entries(snapshot)) {
    if (skipKeys.has(key)) {
      continue;
    }
    const existing = process.env[key];
    if (typeof existing === 'string' && existing.length > 0) {
      continue;
    }
    process.env[key] = value;
  }

  process.env.PATH = mergePathValues(snapshot.PATH || '', process.env.PATH || '');
}

async function waitForReady(
  serverUrl: string,
  timeoutMs = 15000,
  authHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<ReadyResult> {
  const start = Date.now();
  const candidates = getCandidateBaseUrls(serverUrl);
  let attempts = 0;

  while (Date.now() - start < timeoutMs) {
    for (const baseUrl of candidates) {
      signal?.throwIfAborted();
      attempts += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        // OpenCode 2.x readiness check: every route lives under /api. 2.0.8
        // removed `/api/health`; `/api/info` replaces it and a 200 is the whole
        // readiness answer — the payload has no `healthy` field.
        const url = new URL(`${baseUrl}/api/info`);
        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json', ...authHeaders },
          signal: controller.signal,
        });

        const body = await readOpenCodeInfo(res);
        if (body && isSupportedOpenCodeVersion(body.version)) {
          return { ok: true, baseUrl, elapsedMs: Date.now() - start, attempts, version: body.version };
        }
      } catch {
        // ignore
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }

    await new Promise(r => setTimeout(r, 100));
  }

  return { ok: false, elapsedMs: Date.now() - start, attempts, version: null };
}

/**
 * Refuses to start anything but OpenCode 2.x. A 1.x binary serves a different
 * API surface entirely, so letting it boot produces an app that loads and then
 * fails every request with no explanation.
 */
function assertSupportedOpenCodeBinary(binary: string): void {
  const launch = resolveWindowsLaunchSpec(binary, ['--version']);
  const result = spawnSync(launch.binary, launch.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const check = checkOpenCodeVersionOutput(output);
  if (!check.supported) {
    throw new Error(check.reason);
  }
  getManagerOutputChannel().appendLine(`OpenCode CLI version check passed: ${check.version} (${binary})`);
}

function spawnManagedOpenCodeServer(
  workingDirectory: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const binary = stripWrappingQuotes(process.env.OPENCODE_BINARY || 'opencode') || 'opencode';
  assertSupportedOpenCodeBinary(binary);
  const launch = resolveWindowsLaunchSpec(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)]);
  return spawnManagedOpenCodeProcess(launch.binary, launch.args, {
    cwd: workingDirectory,
    env: applyProviderEnvAliases({ ...process.env }),
    port, timeoutMs, signal, sourceBinary: binary,
    appBundleHint: isMacOpenCodeAppBundlePath(binary)
      ? ' The configured binary points at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI.'
      : '',
  });
}

async function allocateManagedOpenCodePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (error) => {
      reject(error);
    });

    server.once('listening', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        if (port > 0) {
          resolve(port);
          return;
        }
        reject(new Error('Failed to allocate OpenCode port'));
      });
    });

    server.listen(0, '127.0.0.1');
  });
}

export function createOpenCodeManager(context: vscode.ExtensionContext): OpenCodeManager {
  let server: ReturnType<typeof spawnManagedOpenCodeServer> | null = null;
  let startupAbort: AbortController | null = null;
  let lifecycleRevision = 0;
  let reapedOrphansOnce = false;
  let managedApiUrlOverride: string | null = null;
  let managedPassword: string | null = null;
  let managedPasswordSource: 'user-env' | 'generated' | 'rotated' | null = null;
  const userProvidedEnvPassword = (() => {
    const normalized = (process.env.OPENCODE_SERVER_PASSWORD || '').trim();
    return isValidOpenCodePassword(normalized) ? normalized : null;
  })();
  let status: ConnectionStatus = 'disconnected';
  let lastError: string | undefined;
  const listeners = new Set<(status: ConnectionStatus, error?: string) => void>();
  const workspaceDirectory = (): string =>
    normalizeWindowsDriveLetter(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir());
  const serverWorkingDirectory = (): string => normalizeWindowsDriveLetter(context.globalStorageUri.fsPath);
  let workingDirectory: string = workspaceDirectory();
  let startCount = 0;
  let restartCount = 0;
  let installInFlight: Promise<void> | null = null;
  let lastStartAt: number | null = null;
  let lastConnectedAt: number | null = null;
  let lastExitCode: number | null = null;
  let lastReadyElapsedMs: number | null = null;
  let lastReadyAttempts: number | null = null;
  let lastStartAttempts: number | null = null;
  let version: string | null = null;

  let detectedPort: number | null = null;
  let cliMissing = false;
  let cliPath: string | null = null;

  let pendingOperation: Promise<void> | null = null;

  const config = vscode.workspace.getConfiguration('openchamber');
  const configuredApiUrl = config.get<string>('apiUrl') || '';
  const useConfiguredUrl = configuredApiUrl && configuredApiUrl.trim().length > 0;

  let configuredPort: number | null = null;
  if (useConfiguredUrl) {
    try {
      const parsed = new URL(configuredApiUrl);
      if (parsed.port) {
        configuredPort = parseInt(parsed.port, 10);
      }
    } catch {
      // Invalid URL
    }
  }

  const setStatus = (newStatus: ConnectionStatus, error?: string) => {
    if (status !== newStatus || lastError !== error) {
      status = newStatus;
      lastError = error;
      if (newStatus === 'connected') {
        lastConnectedAt = Date.now();
      }
      listeners.forEach(cb => cb(status, error));
    }
  };

  const getApiUrl = (): string | null => {
    if (useConfiguredUrl && configuredApiUrl) {
      return configuredApiUrl.replace(/\/+$/, '');
    }
    if (managedApiUrlOverride) {
      return managedApiUrlOverride.replace(/\/+$/, '');
    }
    if (server?.url) {
      return server.url.replace(/\/+$/, '');
    }
    if (detectedPort) {
      return `http://127.0.0.1:${detectedPort}`;
    }
    return null;
  };

  const getOpenCodeAuthHeaders = (): Record<string, string> => {
    const password = (managedPassword || userProvidedEnvPassword || process.env.OPENCODE_SERVER_PASSWORD || '').trim();
    if (!password) {
      return {};
    }
    return { Authorization: buildOpenCodeAuthHeader(password) };
  };

  const setManagedPasswordState = (
    password: string,
    source: 'user-env' | 'generated' | 'rotated'
  ): string => {
    const normalized = password.trim();
    managedPassword = normalized;
    managedPasswordSource = source;
    process.env.OPENCODE_SERVER_PASSWORD = normalized;
    return normalized;
  };

  const ensureManagedOpenCodeServerPassword = async ({ rotateManaged = false }: { rotateManaged?: boolean } = {}): Promise<string> => {
    if (userProvidedEnvPassword) {
      return setManagedPasswordState(userProvidedEnvPassword, 'user-env');
    }

    if (rotateManaged) {
      return setManagedPasswordState(generateSecureOpenCodePassword(), 'rotated');
    }

    if (managedPassword && isValidOpenCodePassword(managedPassword)) {
      return setManagedPasswordState(
        managedPassword,
        managedPasswordSource || 'generated'
      );
    }

    return setManagedPasswordState(generateSecureOpenCodePassword(), 'generated');
  };

  async function startInternal(
    workdir?: string,
    options: { rotateManaged?: boolean } = {}
  ): Promise<void> {
    startCount += 1;
    setStatus('connecting');
    lastStartAt = Date.now();
    lastStartAttempts = startCount;

    if (typeof workdir === 'string' && workdir.trim().length > 0) {
      workingDirectory = normalizeWindowsDriveLetter(workdir.trim());
    } else {
      workingDirectory = workspaceDirectory();
    }

    if (useConfiguredUrl && configuredApiUrl) {
      setStatus('connecting');
      setStatus('connected');
      return;
    }

    // If server already running, don't spawn another
    if (server) {
      if (status !== 'connected') {
        setStatus('connected');
      }
      return;
    }

    const startup = new AbortController();
    startupAbort = startup;

    // Before spawning our own server, reap any OpenCode process WE spawned in a
    // prior run that was orphaned by a crash/host-kill. Verified + scoped to our
    // own pids, so it never touches a live instance's or the user's own server.
    if (!reapedOrphansOnce) {
      reapedOrphansOnce = true;
      try {
        const { reaped } = await reapOrphanedProcesses({ log: (msg) => console.log(msg) });
        if (reaped > 0) console.log(`[opencode] startup reaped ${reaped} orphaned process(es)`);
      } catch (error) {
        console.warn('[opencode] orphan reap failed:', error instanceof Error ? error.message : error);
      }
    }

    setStatus('connecting');
    cliMissing = false;
    cliPath = null;

    detectedPort = null;
    lastExitCode = null;
    managedApiUrlOverride = null;

    try {
      applyLoginShellEnvSnapshot();

      const configuredCli = validateConfiguredOpencodeBinaryForManagedStart();
      if (configuredCli) {
        cliPath = configuredCli;
        appendToPath(path.dirname(configuredCli));
        process.env.OPENCODE_BINARY = configuredCli;
      }

      // Best-effort: locate CLI even when VS Code PATH is stale.
      const resolvedCli = configuredCli || resolveOpencodeCliPath();
      if (resolvedCli) {
        cliPath = resolvedCli;
        appendToPath(path.dirname(resolvedCli));
        process.env.OPENCODE_BINARY = resolvedCli;
      }

      const password = await ensureManagedOpenCodeServerPassword({
        rotateManaged: options.rotateManaged === true,
      });
      process.env.OPENCODE_SERVER_PASSWORD = password;

      // Match the web runtime: keep the server process in a neutral cwd and pass
      // the selected workspace through explicit `directory` API parameters.
      const serverCwd = serverWorkingDirectory();
      startup.signal.throwIfAborted();
      fs.mkdirSync(serverCwd, { recursive: true });
      const port = await allocateManagedOpenCodePort();
      startup.signal.throwIfAborted();
      server = spawnManagedOpenCodeServer(serverCwd, port, READY_CHECK_TIMEOUT_MS, startup.signal);
      await server.ready;

      if (server && server.url) {
        // Validate readiness for the current workspace context.
        const ready = await waitForReady(server.url, READY_CHECK_TIMEOUT_MS, getOpenCodeAuthHeaders(), startup.signal);
        startup.signal.throwIfAborted();
        lastReadyElapsedMs = ready.elapsedMs;
        lastReadyAttempts = ready.attempts;
        if (ready.ok) {
          managedApiUrlOverride = ready.baseUrl;
          detectedPort = resolvePortFromUrl(ready.baseUrl);
          version = ready.version;
          setStatus('connected');
        } else {
          throw new Error('Server started but health check failed');
        }
      } else {
        throw new Error('Server started but URL is missing');
      }
    } catch (err) {
      await server?.close();
      server = null;
      if (startup.signal.aborted) {
        setStatus('disconnected');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);

      // Check for ENOENT or generic spawn failure which implies CLI missing
      if (message.includes('ENOENT') || message.includes('spawn opencode')) {
        cliMissing = true;
        if (!cliPath) {
          cliPath = resolveOpencodeCliPath();
        }
        const moreInfoLabel = t('More Info');
        setStatus('error', t('OpenCode CLI not found. Install it and ensure it\'s in PATH.'));
        vscode.window.showErrorMessage(
          t('OpenCode CLI not found. Please install it and ensure it\'s in PATH.'),
          moreInfoLabel
        ).then(selection => {
          if (selection === moreInfoLabel) {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/anomalyco/opencode'));
          }
        });
      } else {
        setStatus('error', t('Failed to start OpenCode: {0}', message));
      }
    } finally {
      if (startupAbort === startup) startupAbort = null;
    }
  }

  async function stopInternal(): Promise<void> {
    if (server) {
      await server.close();
      server = null;
    }

    managedApiUrlOverride = null;
    detectedPort = null;
    version = null;
    setStatus('disconnected');
  }

  async function restartInternal(revision: number): Promise<void> {
    restartCount += 1;
    const restartDirectory = workingDirectory;
    await stopInternal();
    await new Promise(r => setTimeout(r, 250));
    if (revision !== lifecycleRevision) return;
    await startInternal(restartDirectory, { rotateManaged: true });
  }

  async function enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const pending = (pendingOperation ?? Promise.resolve()).catch(() => {}).then(operation);
    pendingOperation = pending;
    try {
      await pending;
    } finally {
      if (pendingOperation === pending) pendingOperation = null;
    }
  }

  function start(workdir?: string): Promise<void> {
    const revision = lifecycleRevision;
    return enqueueOperation(async () => {
      if (revision !== lifecycleRevision) return;
      lastStartAttempts = 1;
      await startInternal(workdir, { rotateManaged: true });
    });
  }

  function stop(): Promise<void> {
    lifecycleRevision += 1;
    startupAbort?.abort();
    return enqueueOperation(stopInternal);
  }

  function restart(): Promise<void> {
    const revision = lifecycleRevision;
    return enqueueOperation(async () => {
      if (revision !== lifecycleRevision) return;
      lastStartAttempts = 1;
      await restartInternal(revision);
    });
  }

  async function setWorkingDirectory(newPath: string): Promise<SetWorkingDirectoryResult> {
    const trimmed = newPath.trim();
    if (!trimmed) {
      return { success: false, error: 'path not found' };
    }

    let stat;
    try {
      stat = await fs.promises.stat(trimmed);
    } catch {
      return { success: false, error: 'path not found' };
    }
    if (!stat.isDirectory()) {
      return { success: false, error: 'path not found' };
    }

    const change = resolveWorkingDirectoryChange(workingDirectory, trimmed);
    if (!change.changed) {
      return { success: true, path: change.path };
    }

    workingDirectory = change.path;
    return { success: true, path: change.path };
  }

  return {
    start,
    stop,
    restart,
    getCompatibility: async () => {
      if (useConfiguredUrl) {
        const detected = await readExternalOpenCodeVersion(configuredApiUrl, getOpenCodeAuthHeaders()).catch(() => null);
        return describeOpenCodeCompatibility(detected, 'external', false);
      }
      const binary = cliPath || resolveOpencodeCliPath();
      const detected = binary ? await readOpenCodeCliVersion(resolveWindowsLaunchSpec(binary, []), { env: process.env }).catch(() => null) : null;
      return describeOpenCodeCompatibility(detected, 'managed', supportsOpenCodeV2Install());
    },
    installV2: () => {
      if (installInFlight) return installInFlight;
      const revision = lifecycleRevision;
      installInFlight = enqueueOperation(async () => {
        if (revision !== lifecycleRevision) throw new Error('OpenCode installation was cancelled.');
        if (useConfiguredUrl || !supportsOpenCodeV2Install()) throw new Error('Automatic OpenCode v2 installation is unavailable for this runtime.');
        const previousBinary = cliPath || resolveOpencodeCliPath();
        const previousVersion = previousBinary
          ? await readOpenCodeCliVersion(resolveWindowsLaunchSpec(previousBinary, []), { env: process.env })
          : null;
        if (!previousVersion?.startsWith('1.')) throw new Error('OpenCode v1 is not installed.');
        const binary = await installOpenCodeV2();
        if (revision !== lifecycleRevision) throw new Error('OpenCode installation was cancelled.');
        const config = vscode.workspace.getConfiguration('openchamber');
        const setting = config.inspect<string>('opencodeBinary');
        const target = setting?.workspaceFolderValue !== undefined
          ? vscode.ConfigurationTarget.WorkspaceFolder
          : setting?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await config.update('opencodeBinary', binary, target);
        await restartInternal(revision);
        if (status !== 'connected' || !version || !isSupportedOpenCodeVersion(version)) {
          throw new Error('OpenCode v2 was installed, but the server did not become ready. Try reconnecting.');
        }
      }).finally(() => { installInFlight = null; });
      return installInFlight;
    },
    upgradeCli: () => enqueueOperation(async () => {
      if (useConfiguredUrl) {
        throw new Error('This OpenCode runtime cannot be upgraded by OpenChamber.');
      }
      // Match capability reporting: the resolver may find the CLI after startup.
      // Upgrading the binary does not require a live managed server process.
      const binary = cliPath || resolveOpencodeCliPath();
      if (!binary) throw new Error('OpenCode CLI could not be found.');
      await runOpenCodeCliUpgrade(resolveWindowsLaunchSpec(binary, []), {
        cwd: serverWorkingDirectory(), env: process.env,
      });
    }),
    setWorkingDirectory,
    getStatus: () => status,
    getApiUrl,
    getOpenCodeAuthHeaders,
    getWorkingDirectory: () => workingDirectory,
    isCliAvailable: () => !cliMissing || Boolean(cliPath || resolveOpencodeCliPath()),
    getDebugInfo: () => {
      const secureConnection = Boolean(getOpenCodeAuthHeaders().Authorization);
      const detectedCliPath = cliPath || resolveOpencodeCliPath();
      return {
        mode: useConfiguredUrl && configuredApiUrl ? 'external' : 'managed',
        status,
        lastError,
        workingDirectory,
        cliAvailable: !cliMissing || Boolean(detectedCliPath),
        cliPath: detectedCliPath,
        configuredApiUrl: useConfiguredUrl && configuredApiUrl ? configuredApiUrl.replace(/\/+$/, '') : null,
        configuredPort,
        detectedPort,
        apiPrefix: '',
        apiPrefixDetected: true,
        startCount,
        restartCount,
        lastStartAt,
        lastConnectedAt,
        lastExitCode,
        serverUrl: getApiUrl(),
        lastReadyElapsedMs,
        lastReadyAttempts,
        lastStartAttempts,
        version,
        secureConnection,
        authSource: managedPasswordSource || (userProvidedEnvPassword ? 'user-env' : null),
      };
    },
    onStatusChange(callback) {
      listeners.add(callback);
      callback(status, lastError);
      return new vscode.Disposable(() => listeners.delete(callback));
    },
  };
}
