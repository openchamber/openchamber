import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnterprisePolicy } from '../enterprise-mode.js';
import { clearAppImageArgv0FromProcessEnv } from '../inherited-env.js';
import { mergePathValues } from './path-utils.js';
import { bundledOpenCodeServerLaunch, isBundledOpenCodeServer, isRetiredBundledCliSetting, resolveBundledOpenCodeServer } from './bundled-opencode-server.js';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import type { ManagedOpenCodeLaunchSpec } from './lifecycle.js';

export interface OpenCodeEnvState {
  cachedLoginShellEnvSnapshot?: NodeJS.ProcessEnv | null | undefined;
  resolvedOpencodeBinary?: string | null;
  resolvedOpencodeBinarySource?: 'policy' | 'settings' | 'env' | 'bundled' | 'path' | 'fallback' | 'where' | 'shell' | 'wsl' | 'unknown' | null | undefined;
  resolvedNodeBinary?: string | null;
  resolvedBunBinary?: string | null;
  resolvedGitBinary?: string | null;
  useWslForOpencode?: boolean;
  resolvedWslBinary?: string | null;
  resolvedWslOpencodePath?: string | null;
  resolvedWslDistro?: string | null;
}

export interface OpenCodeEnvDependencies {
  state: OpenCodeEnvState;
  normalizeDirectoryPath: (value: string) => string;
  readSettingsFromDiskMigrated: () => Promise<{ opencodeBinary?: unknown } | null>;
  spawnSync?: (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => OpenCodeEnvProbeResult;
  providedLoginShellEnvSnapshot?: () => NodeJS.ProcessEnv | null | undefined;
  homedir?: () => string;
  wellKnownOpencodePaths?: string[];
  readPinnedOpencodeBinary?: () => string | null;
  isExecutable?: (filePath: string) => boolean;
}

export interface OpenCodeEnvProbeResult {
  status: number | null;
  stdout: string | null;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isSettingsObject = (value: unknown): value is { opencodeBinary?: unknown } =>
  value !== null && typeof value === 'object';
const desktopProcess: NodeJS.Process & { resourcesPath?: string } = process;

const SHELL_PROBE_TIMEOUT_MS = 5_000;
const WINDOWS_PROBE_TIMEOUT_MS = 10_000;

const LOGIN_SHELL_ENV_MARKER = '__OPENCHAMBER_ENV__';
const LOGIN_SHELL_ENV_COMMAND = `echo ${LOGIN_SHELL_ENV_MARKER}; env -0`;

const WELL_KNOWN_OPENCODE_PATHS = [
  '/opt/homebrew/bin/opencode',
  '/usr/local/bin/opencode',
  '/home/linuxbrew/.linuxbrew/bin/opencode',
  '/usr/bin/opencode',
  '/bin/opencode',
];

const stripShellStartupOutput = (text: string) => {
  const markerLine = `${LOGIN_SHELL_ENV_MARKER}\n`;
  const markerIndex = text.lastIndexOf(markerLine);
  return markerIndex === -1 ? text : text.slice(markerIndex + markerLine.length);
};

export const createOpenCodeEnvRuntime = (deps: OpenCodeEnvDependencies) => {
  const {
    state,
    normalizeDirectoryPath,
    readSettingsFromDiskMigrated,
  } = deps;
  const runSpawnSync = deps.spawnSync ?? spawnSync;
  const readProvidedLoginShellEnvSnapshot = deps.providedLoginShellEnvSnapshot !== undefined
    ? deps.providedLoginShellEnvSnapshot
    : () => undefined;
  const resolveHomeDir = deps.homedir ?? (() => os.homedir());
  const wellKnownOpencodePaths = deps.wellKnownOpencodePaths !== undefined
    ? deps.wellKnownOpencodePaths
    : WELL_KNOWN_OPENCODE_PATHS;
  const readPinnedOpencodeBinary = deps.readPinnedOpencodeBinary ?? (() => readEnterprisePolicy().opencodeBinary);

  const parseNullSeparatedEnvSnapshot = (raw: string) => {
    if (raw.length === 0) {
      return null;
    }

    const result: NodeJS.ProcessEnv = {};
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

    if (Object.keys(result).length === 0) {
      return null;
    }

    if (process.platform === 'win32' && !isString(result.PATH)) {
      const pathEntry = Object.entries(result).find(([key]) => key.toLowerCase() === 'path');
      if (pathEntry && isString(pathEntry[1])) {
        result.PATH = pathEntry[1];
      }
    }

    return result;
  };

  const probeExecutable = (filePath: string) => {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return false;
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
  };
  const isExecutable = deps.isExecutable ?? probeExecutable;

  const resolveWindowsExecutablePath = (candidate: string) => {
    if (process.platform !== 'win32' || candidate.trim().length === 0) {
      return candidate;
    }

    const trimmed = candidate.trim();
    const ext = path.extname(trimmed).toLowerCase();
    if (ext) {
      return isExecutable(trimmed) ? trimmed : null;
    }

    const pathExt = process.env.PATHEXT || process.env.PathExt || '.COM;.EXE;.BAT;.CMD';
    for (const rawExt of pathExt.split(';')) {
      const normalizedExt = rawExt.trim();
      if (!normalizedExt) continue;
      const withExt = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
      if (isExecutable(withExt)) {
        return withExt;
      }
    }

    return isExecutable(trimmed) ? trimmed : null;
  };

  const searchPathFor = (binaryName: string, searchPath = process.env.PATH || '') => {
    const trimmed = binaryName.trim();
    if (!trimmed) {
      return null;
    }

    const parts = searchPath.split(path.delimiter).filter(Boolean);
    const candidateNames: string[] = [];

    if (process.platform === 'win32' && !path.extname(trimmed)) {
      const pathExt = process.env.PATHEXT || process.env.PathExt || '.COM;.EXE;.BAT;.CMD';
      for (const ext of pathExt.split(';')) {
        const normalizedExt = ext.trim();
        if (!normalizedExt) continue;
        const candidateName = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
        if (!candidateNames.some((existing) => existing.toLowerCase() === candidateName.toLowerCase())) {
          candidateNames.push(candidateName);
        }
      }
    }

    candidateNames.push(trimmed);

    for (const dir of parts) {
      for (const candidateName of candidateNames) {
        const candidate = path.join(dir, candidateName);
        if (isExecutable(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  };

  const prependToPath = (dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed) return;
    const current = process.env.PATH || '';
    const parts = current.split(path.delimiter).filter(Boolean);
    if (parts.includes(trimmed)) return;
    process.env.PATH = [trimmed, ...parts].join(path.delimiter);
  };

  const getWindowsShellEnvSnapshot = () => {
    const parseResult = (stdout: string | null) => parseNullSeparatedEnvSnapshot(isString(stdout) ? stdout : '');

    const psScript = [
      '$entries = [ordered]@{}',
      'Get-ChildItem Env: | ForEach-Object { $entries[$_.Name] = $_.Value }',
      "$pathValues = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Process')) | Where-Object { $_ }",
      "if ($pathValues.Count -gt 0) { $entries['Path'] = ($pathValues -join ';') }",
      "$entries.GetEnumerator() | ForEach-Object { [Console]::Out.Write($_.Name); [Console]::Out.Write('='); [Console]::Out.Write($_.Value); [Console]::Out.Write([char]0) }",
    ].join('; ');

    const powershellCandidates = [
      'pwsh.exe',
      'powershell.exe',
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ];

    for (const shellPath of powershellCandidates) {
      try {
        const result = runSpawnSync(shellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
          timeout: WINDOWS_PROBE_TIMEOUT_MS,
        });
        if (result.status !== 0) {
          continue;
        }
        const parsed = parseResult(result.stdout);
        if (parsed) {
          return parsed;
        }
      } catch {
        void 0;
      }
    }

    const comspec = process.env.ComSpec || 'cmd.exe';
    try {
      const result = runSpawnSync(comspec, ['/d', '/s', '/c', 'set'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        timeout: WINDOWS_PROBE_TIMEOUT_MS,
      });
      if (result.status === 0 && isString(result.stdout) && result.stdout.length > 0) {
        return parseNullSeparatedEnvSnapshot(result.stdout.replace(/\r?\n/g, '\0'));
      }
    } catch {
      void 0;
    }

    return null;
  };

  const getLoginShellEnvSnapshot = () => {
    if (state.cachedLoginShellEnvSnapshot !== undefined) {
      return state.cachedLoginShellEnvSnapshot;
    }

    const provided = readProvidedLoginShellEnvSnapshot();
    if (provided !== undefined) {
      state.cachedLoginShellEnvSnapshot = provided;
      return provided;
    }

    if (process.platform === 'win32') {
      const windowsSnapshot = getWindowsShellEnvSnapshot();
      state.cachedLoginShellEnvSnapshot = windowsSnapshot;
      return windowsSnapshot;
    }

    const shellCandidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter((value): value is string => Boolean(value));

    for (const shellPath of shellCandidates) {
      if (!isExecutable(shellPath)) {
        continue;
      }

      try {
        const result = runSpawnSync(shellPath, ['-lic', LOGIN_SHELL_ENV_COMMAND], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
          timeout: SHELL_PROBE_TIMEOUT_MS,
        });

        if (result.status !== 0) {
          continue;
        }

        const parsed = parseNullSeparatedEnvSnapshot(stripShellStartupOutput(result.stdout || ''));
        if (parsed) {
          state.cachedLoginShellEnvSnapshot = parsed;
          return parsed;
        }
      } catch {
        void 0;
      }
    }

    state.cachedLoginShellEnvSnapshot = null;
    return null;
  };

  const applyLoginShellEnvSnapshot = () => {
    clearAppImageArgv0FromProcessEnv();

    const snapshot = getLoginShellEnvSnapshot();
    if (!snapshot) {
      return;
    }

    const skipKeys = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'ARGV0']);
    for (const [key, value] of Object.entries(snapshot)) {
      if (skipKeys.has(key)) {
        continue;
      }
      const existing = process.env[key];
      if (isString(existing) && existing.length > 0) {
        continue;
      }
      process.env[key] = value;
    }

    const currentPath = process.env.PATH || '';
    const shellPath = snapshot.PATH || '';
    if (!shellPath) {
      return;
    }

    process.env.PATH = mergePathValues(shellPath, currentPath, path.delimiter);
  };

  const isWslExecutableValue = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    return /(^|[\\/])wsl(\.exe)?$/i.test(trimmed);
  };

  const isWindowsOpenCodeDesktopAppPath = (candidate: string) => {
    if (process.platform !== 'win32') {
      return false;
    }
    const normalized = path.resolve(candidate).toLowerCase();
    const localAppData = isString(process.env.LOCALAPPDATA) && process.env.LOCALAPPDATA.trim()
      ? path.resolve(process.env.LOCALAPPDATA).toLowerCase()
      : '';
    if (!localAppData || !normalized.startsWith(`${localAppData}${path.sep}`)) {
      return false;
    }
    return normalized.endsWith(`${path.sep}programs${path.sep}opencode${path.sep}opencode.exe`);
  };

  const bundledOpenCodeServerDirectories = () => [
    process.env.OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR,
    desktopProcess.resourcesPath ? path.join(desktopProcess.resourcesPath, 'opencode-server') : null,
  ];

  const isBundledOpenCodePath = (candidate: string | null | undefined) => isBundledOpenCodeServer(candidate, bundledOpenCodeServerDirectories());

  const bundledOpenCodeFallback = () => {
    const bundled = resolveBundledOpenCodeServer(bundledOpenCodeServerDirectories());
    if (!bundled) return null;
    clearWslOpencodeResolution();
    state.resolvedOpencodeBinarySource = 'bundled';
    return bundled;
  };

  const clearWslOpencodeResolution = () => {
    state.useWslForOpencode = false;
    state.resolvedWslBinary = null;
    state.resolvedWslOpencodePath = null;
    state.resolvedWslDistro = null;
  };

  const stripWrappingQuotes = (value: string | undefined | null) => {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length >= 2
      && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  };

  const resolveOpencodeCliPath = () => {
    const explicit = [
      process.env.OPENCODE_BINARY,
      process.env.OPENCODE_PATH,
      process.env.OPENCHAMBER_OPENCODE_PATH,
      process.env.OPENCHAMBER_OPENCODE_BIN,
    ]
      .map(stripWrappingQuotes)
      .filter(Boolean);

    for (const candidate of explicit) {
      if (isExecutable(candidate) && !isWindowsOpenCodeDesktopAppPath(candidate)) {
        clearWslOpencodeResolution();
        state.resolvedOpencodeBinarySource = 'env';
        return candidate;
      }
    }

    const bundled = bundledOpenCodeFallback();
    if (bundled) return bundled;

    const resolvedFromPath = searchPathFor('opencode');
    if (resolvedFromPath) {
      clearWslOpencodeResolution();
      state.resolvedOpencodeBinarySource = 'path';
      return resolvedFromPath;
    }

    const home = resolveHomeDir();
    const unixFallbacks = [
      path.join(home, '.opencode', 'bin', 'opencode'),
      path.join(home, '.bun', 'bin', 'opencode'),
      path.join(home, '.local', 'bin', 'opencode'),
      path.join(home, 'bin', 'opencode'),
      ...wellKnownOpencodePaths,
    ];

    const winFallbacks = (() => {
      const userProfile = process.env.USERPROFILE || home;
      const appData = process.env.APPDATA || '';
      const programData = process.env.ProgramData || 'C:\\ProgramData';

      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

      return [
        path.join(userProfile, '.opencode', 'bin', 'opencode.exe'),
        path.join(userProfile, '.opencode', 'bin', 'opencode.cmd'),
        path.join(appData, 'npm', 'opencode.cmd'),
        path.join(programFiles, 'nodejs', 'opencode.cmd'),
        path.join(userProfile, 'scoop', 'shims', 'opencode.exe'),
        path.join(userProfile, 'scoop', 'shims', 'opencode.cmd'),
        path.join(programData, 'chocolatey', 'bin', 'opencode.exe'),
        path.join(programData, 'chocolatey', 'bin', 'opencode.cmd'),
        path.join(userProfile, '.bun', 'bin', 'opencode.exe'),
        path.join(userProfile, '.bun', 'bin', 'opencode.cmd'),
      ].filter(Boolean);
    })();

    const fallbacks = process.platform === 'win32' ? winFallbacks : unixFallbacks;
    for (const candidate of fallbacks) {
      if (isExecutable(candidate)) {
        clearWslOpencodeResolution();
        state.resolvedOpencodeBinarySource = 'fallback';
        return candidate;
      }
    }

    if (process.platform === 'win32') {
      try {
        const result = runSpawnSync('where', ['opencode'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: WINDOWS_PROBE_TIMEOUT_MS,
        });
        if (result.status === 0) {
          const lines = (result.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          const found = lines.find((line) => isExecutable(line) && !isWindowsOpenCodeDesktopAppPath(line));
          if (found) {
            clearWslOpencodeResolution();
            state.resolvedOpencodeBinarySource = 'where';
            return found;
          }
        }
      } catch {
        void 0;
      }
      return null;
    }

    const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter((value): value is string => Boolean(value));
    for (const shell of shells) {
      if (!isExecutable(shell)) continue;
      try {
        const result = runSpawnSync(shell, ['-lic', 'command -v opencode'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: SHELL_PROBE_TIMEOUT_MS,
        });
        if (result.status === 0) {
          const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
          if (found && isExecutable(found)) {
            clearWslOpencodeResolution();
            state.resolvedOpencodeBinarySource = 'shell';
            return found;
          }
        }
      } catch {
        void 0;
      }
    }

    return null;
  };

  const resolveNodeCliPath = () => {
    const explicit = [process.env.NODE_BINARY, process.env.OPENCHAMBER_NODE_BINARY]
      .map((v) => (isString(v) ? v.trim() : ''))
      .filter(Boolean);

    for (const candidate of explicit) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }

    const resolvedFromPath = searchPathFor('node');
    if (resolvedFromPath) {
      return resolvedFromPath;
    }

    const unixFallbacks = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/bin/node'];
    for (const candidate of unixFallbacks) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }

    if (process.platform === 'win32') {
      try {
        const result = runSpawnSync('where', ['node'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: WINDOWS_PROBE_TIMEOUT_MS,
        });
        if (result.status === 0) {
          const lines = (result.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          const found = lines.find((line) => isExecutable(line));
          if (found) return found;
        }
      } catch {
        void 0;
      }
      return null;
    }

    const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter((value): value is string => Boolean(value));
    for (const shell of shells) {
      if (!isExecutable(shell)) continue;
      try {
        const result = runSpawnSync(shell, ['-lic', 'command -v node'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: SHELL_PROBE_TIMEOUT_MS,
        });
        if (result.status === 0) {
          const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
          if (found && isExecutable(found)) {
            return found;
          }
        }
      } catch {
        void 0;
      }
    }

    return null;
  };

  const resolveBunCliPath = () => {
    const explicit = [process.env.BUN_BINARY, process.env.OPENCHAMBER_BUN_BINARY]
      .map((v) => (isString(v) ? v.trim() : ''))
      .filter(Boolean);

    for (const candidate of explicit) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }

    const resolvedFromPath = searchPathFor('bun');
    if (resolvedFromPath) {
      return resolvedFromPath;
    }

    const home = os.homedir();
    const unixFallbacks = [
      path.join(home, '.bun', 'bin', 'bun'),
      '/opt/homebrew/bin/bun',
      '/usr/local/bin/bun',
      '/usr/bin/bun',
      '/bin/bun',
    ];
    for (const candidate of unixFallbacks) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }

    if (process.platform === 'win32') {
      const userProfile = process.env.USERPROFILE || home;
      const winFallbacks = [
        path.join(userProfile, '.bun', 'bin', 'bun.exe'),
        path.join(userProfile, '.bun', 'bin', 'bun.cmd'),
      ];
      for (const candidate of winFallbacks) {
        if (isExecutable(candidate)) return candidate;
      }

      try {
        const result = runSpawnSync('where', ['bun'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: WINDOWS_PROBE_TIMEOUT_MS,
        });
        if (result.status === 0) {
          const lines = (result.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          const found = lines.find((line) => isExecutable(line));
          if (found) return found;
        }
      } catch {
        void 0;
      }
      return null;
    }

    const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter((value): value is string => Boolean(value));
    for (const shell of shells) {
      if (!isExecutable(shell)) continue;
      try {
        const result = runSpawnSync(shell, ['-lic', 'command -v bun'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: SHELL_PROBE_TIMEOUT_MS,
        });
        if (result.status === 0) {
          const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
          if (found && isExecutable(found)) {
            return found;
          }
        }
      } catch {
        void 0;
      }
    }

    return null;
  };

  const ensureBunCliEnv = () => {
    if (state.resolvedBunBinary) {
      return state.resolvedBunBinary;
    }

    const resolved = resolveBunCliPath();
    if (resolved) {
      prependToPath(path.dirname(resolved));
      state.resolvedBunBinary = resolved;
      return resolved;
    }

    return null;
  };

  const ensureNodeCliEnv = () => {
    if (state.resolvedNodeBinary) {
      return state.resolvedNodeBinary;
    }

    const resolved = resolveNodeCliPath();
    if (resolved) {
      prependToPath(path.dirname(resolved));
      state.resolvedNodeBinary = resolved;
      return resolved;
    }

    return null;
  };

  const WINDOWS_BATCH_EXTENSIONS = new Set(['.cmd', '.bat', '.com']);

  const normalizeExecutableCandidate = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (process.platform === 'win32') {
      return resolveWindowsExecutablePath(trimmed);
    }
    return isExecutable(trimmed) ? trimmed : null;
  };

  const WINDOWS_X64_NATIVE_PACKAGES = [
    path.join('@opencode', 'cli-windows-x64-baseline'),
    path.join('@opencode', 'cli-windows-x64'),
    'opencode-windows-x64-baseline',
    'opencode-windows-x64',
  ];

  const getWindowsNativeOpencodePackageNames = () => {
    if (process.arch === 'arm64') {
      return [path.join('@opencode', 'cli-windows-arm64'), 'opencode-windows-arm64'];
    }
    if (process.arch === 'x64') {
      return WINDOWS_X64_NATIVE_PACKAGES;
    }
    return [];
  };

  const OPENCODE_NPM_PACKAGE_DIRS = [path.join('@opencode', 'cli'), 'opencode-ai'];

  const resolveNativeOpencodeBinaryFromNodeModules = (nodeModulesDir: string | null) => {
    if (nodeModulesDir === null || nodeModulesDir.trim().length === 0) {
      return null;
    }

    for (const packageDir of OPENCODE_NPM_PACKAGE_DIRS) {
      const packageShim = path.join(nodeModulesDir, packageDir, 'bin', 'opencode.exe');
      if (isExecutable(packageShim)) {
        return packageShim;
      }
    }

    for (const packageName of getWindowsNativeOpencodePackageNames()) {
      const candidates = [
        path.join(nodeModulesDir, packageName, 'bin', 'opencode.exe'),
        ...OPENCODE_NPM_PACKAGE_DIRS.map((packageDir) =>
          path.join(nodeModulesDir, packageDir, 'node_modules', packageName, 'bin', 'opencode.exe')),
      ];
      for (const candidate of candidates) {
        if (isExecutable(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  };

  const resolveOpencodeNodeLaunchSpecFromNodeModules = (nodeModulesDir: string | null): ManagedOpenCodeLaunchSpec | null => {
    if (nodeModulesDir === null || nodeModulesDir.trim().length === 0) {
      return null;
    }

    const launcher = path.join(nodeModulesDir, 'opencode-ai', 'bin', 'opencode');
    if (!isExecutable(launcher) && !fs.existsSync(launcher)) {
      return null;
    }

    const nodeBinary = ensureNodeCliEnv() || resolveNodeCliPath() || 'node';
    return {
      binary: nodeBinary,
      args: [launcher],
      wrapperType: 'node-launcher',
    };
  };

  const resolveNodeModulesDirFromCmdWrapper = (wrapperPath: string) => {
    if (!wrapperPath) {
      return null;
    }

    try {
      const content = fs.readFileSync(wrapperPath, 'utf8');
      const launcherMatch = content.match(/node_modules[\\/]+(?:@opencode[\\/]+cli|opencode-ai)[\\/]+bin[\\/]+opencode/i);
      if (!launcherMatch) {
        return null;
      }

      const launcherPath = path.resolve(path.dirname(wrapperPath), launcherMatch[0].replace(/[\\/]+/g, path.sep));
      const depth = /[\\/]@opencode[\\/]/i.test(launcherMatch[0]) ? 4 : 3;
      let nodeModulesDir = launcherPath;
      for (let index = 0; index < depth; index += 1) nodeModulesDir = path.dirname(nodeModulesDir);
      return nodeModulesDir;
    } catch {
      return null;
    }
  };

  const resolveOpencodeNodeModulesDir = (opencodePath: string) => {
    if (opencodePath.trim().length === 0) {
      return null;
    }

    const normalized = path.resolve(opencodePath);
    const lower = normalized.toLowerCase();
    const fileDir = path.dirname(normalized);
    const nodeModulesCandidates: string[] = [];
    const pushCandidate = (candidate: string | null) => {
      if (candidate === null || candidate.trim().length === 0) {
        return;
      }
      if (!nodeModulesCandidates.includes(candidate)) {
        nodeModulesCandidates.push(candidate);
      }
    };

    if (lower.includes(`${path.sep}.bun${path.sep}bin${path.sep}opencode`)) {
      const bunRoot = path.dirname(path.dirname(normalized));
      pushCandidate(path.join(bunRoot, 'install', 'global', 'node_modules'));
    }

    if (lower.endsWith(`${path.sep}node_modules${path.sep}.bin${path.sep}opencode`)
      || lower.endsWith(`${path.sep}node_modules${path.sep}.bin${path.sep}opencode.cmd`)
      || lower.endsWith(`${path.sep}node_modules${path.sep}.bin${path.sep}opencode.bat`)
      || lower.endsWith(`${path.sep}node_modules${path.sep}.bin${path.sep}opencode.exe`)) {
      pushCandidate(path.dirname(fileDir));
    }

    if (lower.endsWith(`${path.sep}node_modules${path.sep}opencode-ai${path.sep}bin${path.sep}opencode`)) {
      pushCandidate(path.dirname(path.dirname(fileDir)));
    }

    if (lower.endsWith(`${path.sep}node_modules${path.sep}@opencode${path.sep}cli${path.sep}bin${path.sep}opencode`)
      || lower.endsWith(`${path.sep}node_modules${path.sep}@opencode${path.sep}cli${path.sep}bin${path.sep}opencode.exe`)) {
      pushCandidate(path.dirname(path.dirname(path.dirname(fileDir))));
    }

    if (path.basename(fileDir).toLowerCase() === 'npm') {
      pushCandidate(path.join(fileDir, 'node_modules'));
    }

    if (WINDOWS_BATCH_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
      pushCandidate(resolveNodeModulesDirFromCmdWrapper(normalized));
    }

    for (const candidate of nodeModulesCandidates) {
      if (resolveNativeOpencodeBinaryFromNodeModules(candidate) || resolveOpencodeNodeLaunchSpecFromNodeModules(candidate)) {
        return candidate;
      }
    }

    return null;
  };

  const resolveManagedOpenCodeLaunchSpec = (opencodePath: string | null | undefined): ManagedOpenCodeLaunchSpec => {
    const fallbackBinary = opencodePath != null && opencodePath.trim().length > 0
      ? opencodePath.trim()
      : 'opencode';

    if (isBundledOpenCodePath(fallbackBinary)) return bundledOpenCodeServerLaunch(fallbackBinary, resolveNodeCliPath);

    if (process.platform !== 'win32') {
      return { binary: fallbackBinary, args: [], wrapperType: null };
    }

    const ext = path.extname(fallbackBinary).toLowerCase();
    const candidatePaths = [fallbackBinary];
    if (WINDOWS_BATCH_EXTENSIONS.has(ext)) {
      candidatePaths.push(fallbackBinary.slice(0, -ext.length) + '.exe');
    }

    for (const candidate of candidatePaths) {
      const nodeModulesDir = resolveOpencodeNodeModulesDir(candidate);
      const nativeBinary = resolveNativeOpencodeBinaryFromNodeModules(nodeModulesDir);
      if (nativeBinary) {
        return {
          binary: nativeBinary,
          args: [],
          wrapperType: nativeBinary === fallbackBinary ? null : 'native-wrapper',
        };
      }

      const nodeLaunchSpec = resolveOpencodeNodeLaunchSpecFromNodeModules(nodeModulesDir);
      if (nodeLaunchSpec) {
        return nodeLaunchSpec;
      }

      const interpreter = opencodeShimInterpreter(candidate);
      if (interpreter === 'node') {
        return {
          binary: ensureNodeCliEnv() || resolveNodeCliPath() || 'node',
          args: [candidate],
          wrapperType: 'node-shebang',
        };
      }
      if (interpreter === 'bun') {
        return {
          binary: ensureBunCliEnv() || resolveBunCliPath() || 'bun',
          args: [candidate],
          wrapperType: 'bun-shebang',
        };
      }

      const directBinary = normalizeExecutableCandidate(candidate);
      if (directBinary) {
        const directExt = path.extname(directBinary).toLowerCase();
        if (WINDOWS_BATCH_EXTENSIONS.has(directExt)) {
          return {
            binary: process.env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', 'call', directBinary],
            wrapperType: 'cmd-wrapper',
          };
        }

        return {
          binary: directBinary,
          args: [],
          wrapperType: directBinary === fallbackBinary ? null : 'executable-wrapper',
        };
      }
    }

    if (WINDOWS_BATCH_EXTENSIONS.has(ext)) {
      return {
        binary: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'call', fallbackBinary],
        wrapperType: 'cmd-wrapper',
      };
    }

    return { binary: fallbackBinary, args: [], wrapperType: null };
  };

  const readShebang = (opencodePath: string) => {
    if (!opencodePath) {
      return null;
    }
    try {
      const fd = fs.openSync(opencodePath, 'r');
      try {
        const buf = Buffer.alloc(256);
        const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytes).toString('utf8');
        const firstLine = head.split(/\r?\n/, 1)[0] || '';
        if (!firstLine.startsWith('#!')) {
          return null;
        }
        const shebang = firstLine.slice(2).trim();
        if (!shebang) {
          return null;
        }
        return shebang;
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          void 0;
        }
      }
    } catch {
      return null;
    }
  };

  const opencodeShimInterpreter = (opencodePath: string) => {
    const shebang = readShebang(opencodePath);
    if (!shebang) return null;
    if (/\bnode\b/i.test(shebang)) return 'node';
    if (/\bbun\b/i.test(shebang)) return 'bun';
    return null;
  };

  const ensureOpencodeShimRuntime = (opencodePath: string) => {
    const runtime = opencodeShimInterpreter(opencodePath);
    if (runtime === 'node') {
      ensureNodeCliEnv();
    }
    if (runtime === 'bun') {
      ensureBunCliEnv();
    }
  };

  const isMacOpenCodeAppBundlePath = (candidate: string) => {
    if (process.platform !== 'darwin') {
      return false;
    }
    return /\/OpenCode(?: Dev| Beta)?\.app\/Contents\/MacOS\/(?:OpenCode(?: Dev| Beta)?|opencode-cli)$/i.test(candidate);
  };

  const isKnownOpenCodeDesktopAppPath = (candidate: string) => isMacOpenCodeAppBundlePath(candidate)
    || isWindowsOpenCodeDesktopAppPath(candidate);

  const createConfiguredOpencodeBinaryError = (raw: string, normalized: string | null) => {
    const configured = raw.trim();
    const candidate = normalized !== null && normalized.trim().length > 0 ? normalized.trim() : configured;
    const messageSuffix = 'OpenChamber needs the standalone opencode CLI. Install it and set settings.opencodeBinary to the CLI path, for example ~/.opencode/bin/opencode, or leave the setting empty to use PATH lookup.';
    const error: NodeJS.ErrnoException = (() => {
      if (isKnownOpenCodeDesktopAppPath(candidate) || isKnownOpenCodeDesktopAppPath(configured)) {
        const platformName = process.platform === 'win32' ? 'Windows desktop app install' : 'macOS desktop app bundle';
        return new Error(`Configured OpenCode binary points at the ${platformName}, not the CLI: ${candidate}. ${messageSuffix}`);
      }

      try {
        const configuredStat = fs.statSync(configured);
        if (configuredStat.isDirectory()) {
          return new Error(`Configured OpenCode binary directory does not contain an executable ${process.platform === 'win32' ? 'opencode.exe' : 'opencode'}: ${configured}. ${messageSuffix}`);
        }
      } catch {
        void 0;
      }

      try {
        const stat = fs.statSync(candidate);
        if (stat.isDirectory()) {
          return new Error(`Configured OpenCode binary directory does not contain an executable ${process.platform === 'win32' ? 'opencode.exe' : 'opencode'}: ${candidate}. ${messageSuffix}`);
        }
        if (!stat.isFile()) {
          return new Error(`Configured OpenCode binary is not a file: ${candidate}. ${messageSuffix}`);
        }
        return new Error(`Configured OpenCode binary is not executable: ${candidate}. ${messageSuffix}`);
      } catch {
        return new Error(`Configured OpenCode binary not found: ${candidate}. ${messageSuffix}`);
      }
    })();
    error.code = 'OPENCODE_BINARY_INVALID';
    return error;
  };

  const createConfiguredWslOpencodeError = (raw: string) => new Error(
    `Configured settings.opencodeBinary uses WSL but OpenChamber could not resolve a WSL OpenCode command: ${raw}. Ensure WSL is available and opencode is installed in the configured distro.`
  );

  const normalizeOpencodeBinarySetting = (raw: string) => {
    const trimmed = normalizeDirectoryPath(raw).trim();
    if (!trimmed) {
      return '';
    }

    try {
      const stat = fs.statSync(trimmed);
      if (stat.isDirectory()) {
        const bin = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
        return path.join(trimmed, bin);
      }
    } catch {
      void 0;
    }

    return trimmed;
  };

  const createPinnedOpencodeBinaryError = (candidate: string) => {
    const error: NodeJS.ErrnoException = new Error(
      `The OpenCode CLI pinned by your administrator (opencodeBinary in the OpenChamber policy file) is missing or not executable: ${candidate}. `
      + 'Ask your administrator to install the standalone opencode CLI at that path or update the policy.'
    );
    error.code = 'OPENCODE_BINARY_INVALID';
    return error;
  };

  const applyPinnedOpencodeBinary = (): { pinned: false } | { pinned: true; binary: null; error: Error } | { pinned: true; binary: string; error: null } => {
    const pinned = readPinnedOpencodeBinary();
    if (!pinned) {
      if (state.resolvedOpencodeBinarySource === 'policy') {
        delete process.env.OPENCODE_BINARY;
        state.resolvedOpencodeBinary = null;
        state.resolvedOpencodeBinarySource = null;
      }
      return { pinned: false };
    }

    const normalized = normalizeOpencodeBinarySetting(stripWrappingQuotes(pinned));
    if (!normalized || !isExecutable(normalized) || isKnownOpenCodeDesktopAppPath(normalized)) {
      state.resolvedOpencodeBinary = null;
      state.resolvedOpencodeBinarySource = null;
      clearWslOpencodeResolution();
      return { pinned: true, binary: null, error: createPinnedOpencodeBinaryError(normalized || pinned) };
    }

    clearWslOpencodeResolution();
    process.env.OPENCODE_BINARY = normalized;
    prependToPath(path.dirname(normalized));
    state.resolvedOpencodeBinary = normalized;
    state.resolvedOpencodeBinarySource = 'policy';
    ensureOpencodeShimRuntime(normalized);
    return { pinned: true, binary: normalized, error: null };
  };

  const applyOpencodeBinaryFromSettings = async (options: { strict?: boolean } = {}) => {
    const strict = options?.strict === true;
    const pin = applyPinnedOpencodeBinary();
    if (pin.pinned) {
      if (pin.error === null) return pin.binary;
      if (strict) throw pin.error;
      console.warn(pin.error.message);
      return null;
    }
    try {
      const settings = await readSettingsFromDiskMigrated();
      if (!isSettingsObject(settings)) {
        return null;
      }
      if (!Object.prototype.hasOwnProperty.call(settings, 'opencodeBinary')) {
        return null;
      }

      const normalized = isString(settings.opencodeBinary) ? normalizeOpencodeBinarySetting(settings.opencodeBinary) : null;

      if (normalized === '' || (isString(settings.opencodeBinary) && isRetiredBundledCliSetting(settings.opencodeBinary))) {
        if (state.resolvedOpencodeBinarySource === 'settings') {
          delete process.env.OPENCODE_BINARY;
        }
        state.resolvedOpencodeBinary = null;
        state.resolvedOpencodeBinarySource = null;
        clearWslOpencodeResolution();
        return null;
      }

      const raw = isString(settings.opencodeBinary) ? settings.opencodeBinary.trim() : '';
      const explicitWslPath = process.platform === 'win32'
        ? raw.match(/^wsl:\s*(.+)$/i)
        : null;

      if (explicitWslPath && explicitWslPath[1] && explicitWslPath[1].trim().length > 0) {
        clearWslOpencodeResolution();
        if (strict) {
          throw createConfiguredWslOpencodeError(raw);
        }
        console.warn(`Configured settings.opencodeBinary uses WSL, which is no longer supported by OpenChamber desktop: ${raw}`);
        return null;
      }

      if (process.platform === 'win32' && (isWslExecutableValue(raw) || isWslExecutableValue(normalized || ''))) {
        clearWslOpencodeResolution();
        if (strict) {
          throw createConfiguredWslOpencodeError(raw);
        }
        console.warn(`Configured settings.opencodeBinary points to WSL, which is no longer supported by OpenChamber desktop: ${raw}`);
        return null;
      }

      if (normalized && isExecutable(normalized) && !isKnownOpenCodeDesktopAppPath(normalized)) {
        clearWslOpencodeResolution();
        process.env.OPENCODE_BINARY = normalized;
        prependToPath(path.dirname(normalized));
        state.resolvedOpencodeBinary = normalized;
        state.resolvedOpencodeBinarySource = 'settings';
        ensureOpencodeShimRuntime(normalized);
        return normalized;
      }

      if (raw) {
        if (strict) {
          throw createConfiguredOpencodeBinaryError(raw, normalized);
        }
        console.warn(`Configured settings.opencodeBinary is not executable: ${raw}`);
      }
    } catch (error) {
      if (strict) {
        throw error;
      }
    }

    return null;
  };

  const ensureOpencodeCliEnv = () => {
    const pin = applyPinnedOpencodeBinary();
    if (pin.pinned) return pin.binary;

    if (state.resolvedOpencodeBinary) {
      if (state.useWslForOpencode || state.resolvedOpencodeBinarySource === 'bundled') {
        return state.resolvedOpencodeBinary;
      }
      ensureOpencodeShimRuntime(state.resolvedOpencodeBinary);
      return state.resolvedOpencodeBinary;
    }

    const existing = isString(process.env.OPENCODE_BINARY) ? process.env.OPENCODE_BINARY.trim() : '';
    if (existing && isExecutable(existing)) {
      clearWslOpencodeResolution();
      state.resolvedOpencodeBinary = existing;
      state.resolvedOpencodeBinarySource = state.resolvedOpencodeBinarySource || 'env';
      prependToPath(path.dirname(existing));
      ensureOpencodeShimRuntime(existing);
      return state.resolvedOpencodeBinary;
    }

    const resolved = resolveOpencodeCliPath();
    if (resolved) {
      if (state.useWslForOpencode) {
        state.resolvedOpencodeBinary = resolved;
        state.resolvedOpencodeBinarySource = state.resolvedOpencodeBinarySource || 'wsl';
        console.log(`Resolved opencode CLI via WSL: ${state.resolvedWslOpencodePath || 'opencode'}`);
        return resolved;
      }

      if (state.resolvedOpencodeBinarySource !== 'bundled') {
        process.env.OPENCODE_BINARY = resolved;
        prependToPath(path.dirname(resolved));
        ensureOpencodeShimRuntime(resolved);
      }
      state.resolvedOpencodeBinary = resolved;
      state.resolvedOpencodeBinarySource = state.resolvedOpencodeBinarySource || 'unknown';
      console.log(`Resolved opencode CLI: ${resolved}`);
      return resolved;
    }

    clearWslOpencodeResolution();
    return null;
  };

  const resolveExplicitGitBinary = () => {
    const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
      .map((value) => (isString(value) ? value.trim() : ''))
      .filter(Boolean);
    return explicit.find((candidate) => isExecutable(candidate)) || null;
  };

  const resolveGitBinaryForSpawn = () => {
    if (process.platform !== 'win32') {
      return resolveExplicitGitBinary() || 'git';
    }

    if (state.resolvedGitBinary) {
      return state.resolvedGitBinary;
    }

    const explicit = resolveExplicitGitBinary();
    if (explicit) {
      state.resolvedGitBinary = explicit;
      return state.resolvedGitBinary;
    }

    const candidates: string[] = [];
    const normalizeGitCandidate = (candidate: string | null) => {
      if (candidate === null) {
        return '';
      }
      const trimmed = candidate.trim();
      if (!trimmed) {
        return '';
      }
      const ext = path.extname(trimmed).toLowerCase();
      if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
        const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
        if (isExecutable(exeCandidate)) {
          return exeCandidate;
        }
      }
      return trimmed;
    };

    const pathCandidate = normalizeGitCandidate(searchPathFor('git'));
    if (pathCandidate && isExecutable(pathCandidate)) {
      candidates.push(pathCandidate);
    }

    const pathExeCandidate = normalizeGitCandidate(searchPathFor('git.exe'));
    if (pathExeCandidate && isExecutable(pathExeCandidate)) {
      candidates.push(pathExeCandidate);
    }

    const programRoots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LocalAppData,
    ]
      .map((value) => (isString(value) ? value.trim() : ''))
      .filter(Boolean);
    for (const root of programRoots) {
      const installCandidates = [
        path.join(root, 'Git', 'cmd', 'git.exe'),
        path.join(root, 'Git', 'bin', 'git.exe'),
        path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'),
        path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'),
        path.join(root, 'Programs', 'Git', 'bin', 'git.exe'),
      ];
      for (const candidate of installCandidates) {
        const normalized = normalizeGitCandidate(candidate);
        if (normalized && isExecutable(normalized)) {
          candidates.push(normalized);
        }
      }
    }

    const preferredExe = candidates.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
    state.resolvedGitBinary = preferredExe || candidates[0] || 'git.exe';
    return state.resolvedGitBinary;
  };

  const clearResolvedOpenCodeBinary = () => {
    state.resolvedOpencodeBinary = null;
  };

  return {
    applyLoginShellEnvSnapshot,
    ensureOpencodeCliEnv,
    applyOpencodeBinaryFromSettings,
    getLoginShellEnvSnapshot,
    resolveOpencodeCliPath,
    isBundledOpenCodePath,
    resolveManagedOpenCodeLaunchSpec,
    isExecutable,
    searchPathFor,
    resolveGitBinaryForSpawn,
    clearResolvedOpenCodeBinary,
  };
};
