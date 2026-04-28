import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergePathValues } from './path-utils.js';

export const createOpenCodeEnvRuntime = (deps) => {
  const {
    state,
    normalizeDirectoryPath,
    readSettingsFromDiskMigrated,
    ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
  } = deps;

  const parseNullSeparatedEnvSnapshot = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }

    const result = {};
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
  };

  const isExecutable = (filePath) => {
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

  const searchPathFor = (binaryName) => {
    const current = process.env.PATH || '';
    const parts = current.split(path.delimiter).filter(Boolean);
    for (const dir of parts) {
      const candidate = path.join(dir, binaryName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  const prependToPath = (dir) => {
    const trimmed = typeof dir === 'string' ? dir.trim() : '';
    if (!trimmed) return;
    const current = process.env.PATH || '';
    const parts = current.split(path.delimiter).filter(Boolean);
    if (parts.includes(trimmed)) return;
    process.env.PATH = [trimmed, ...parts].join(path.delimiter);
  };

  const getWindowsShellEnvSnapshot = () => {
    const parseResult = (stdout) => parseNullSeparatedEnvSnapshot(typeof stdout === 'string' ? stdout : '');

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
    }

    return null;
  };

  const getLoginShellEnvSnapshot = () => {
    if (state.cachedLoginShellEnvSnapshot !== undefined) {
      return state.cachedLoginShellEnvSnapshot;
    }

    if (process.platform === 'win32') {
      const windowsSnapshot = getWindowsShellEnvSnapshot();
      state.cachedLoginShellEnvSnapshot = windowsSnapshot;
      return windowsSnapshot;
    }

    const shellCandidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);

    for (const shellPath of shellCandidates) {
      if (!isExecutable(shellPath)) {
        continue;
      }

      try {
        const result = spawnSync(shellPath, ['-lic', 'env -0'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        });

        if (result.status !== 0) {
          continue;
        }

        const parsed = parseNullSeparatedEnvSnapshot(result.stdout || '');
        if (parsed) {
          state.cachedLoginShellEnvSnapshot = parsed;
          return parsed;
        }
      } catch {
      }
    }

    state.cachedLoginShellEnvSnapshot = null;
    return null;
  };

  const applyLoginShellEnvSnapshot = () => {
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

    const currentPath = process.env.PATH || '';
    const shellPath = snapshot.PATH || '';
    if (!shellPath) {
      return;
    }

    process.env.PATH = mergePathValues(shellPath, currentPath, path.delimiter);
  };

  const isWslExecutableValue = (value) => {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    return /(^|[\\/])wsl(\.exe)?$/i.test(trimmed);
  };

  const clearWslOpencodeResolution = () => {
    state.useWslForOpencode = false;
    state.resolvedWslBinary = null;
    state.resolvedWslOpencodePath = null;
    state.resolvedWslDistro = null;
  };

  const resolveWslExecutablePath = () => {
    if (process.platform !== 'win32') {
      return null;
    }

    const explicit = [process.env.WSL_BINARY, process.env.OPENCHAMBER_WSL_BINARY]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean);

    for (const candidate of explicit) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }

    try {
      const result = spawnSync('where', ['wsl'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (result.status === 0) {
        const lines = (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const found = lines.find((line) => isExecutable(line));
        if (found) {
          return found;
        }
      }
    } catch {
    }

    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const fallback = path.join(systemRoot, 'System32', 'wsl.exe');
    if (isExecutable(fallback)) {
      return fallback;
    }

    return null;
  };

  const buildWslExecArgs = (execArgs, distroOverride = null) => {
    const distro = typeof distroOverride === 'string' && distroOverride.trim().length > 0
      ? distroOverride.trim()
      : ENV_CONFIGURED_OPENCODE_WSL_DISTRO;

    const prefix = distro ? ['-d', distro] : [];
    return [...prefix, '--exec', ...execArgs];
  };

  const probeWslForOpencode = () => {
    if (process.platform !== 'win32') {
      return null;
    }

    const wslBinary = resolveWslExecutablePath();
    if (!wslBinary) {
      return null;
    }

    try {
      const result = spawnSync(
        wslBinary,
        buildWslExecArgs(['sh', '-lc', 'command -v opencode']),
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 6000,
          windowsHide: true,
        }
      );

      if (result.status !== 0) {
        return null;
      }

      const lines = (result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const found = lines[0] || '';
      if (!found) {
        return null;
      }

      return {
        wslBinary,
        opencodePath: found,
        distro: ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
      };
    } catch {
      return null;
    }
  };

  const applyWslOpencodeResolution = ({ wslBinary, opencodePath, source = 'wsl', distro = null } = {}) => {
    const resolvedWsl = wslBinary || resolveWslExecutablePath();
    if (!resolvedWsl) {
      return null;
    }

    state.useWslForOpencode = true;
    state.resolvedWslBinary = resolvedWsl;
    state.resolvedWslOpencodePath = typeof opencodePath === 'string' && opencodePath.trim().length > 0
      ? opencodePath.trim()
      : 'opencode';
    state.resolvedWslDistro = typeof distro === 'string' && distro.trim().length > 0 ? distro.trim() : ENV_CONFIGURED_OPENCODE_WSL_DISTRO;
    state.resolvedOpencodeBinary = `wsl:${state.resolvedWslOpencodePath}`;
    state.resolvedOpencodeBinarySource = source;

    delete process.env.OPENCODE_BINARY;
    return state.resolvedOpencodeBinary;
  };

  const resolveOpencodeCliPath = () => {
    const explicit = [
      process.env.OPENCODE_BINARY,
      process.env.OPENCODE_PATH,
      process.env.OPENCHAMBER_OPENCODE_PATH,
      process.env.OPENCHAMBER_OPENCODE_BIN,
    ]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean);

    for (const candidate of explicit) {
      if (isExecutable(candidate)) {
        clearWslOpencodeResolution();
        state.resolvedOpencodeBinarySource = 'env';
        return candidate;
      }
    }

    const resolvedFromPath = searchPathFor('opencode');
    if (resolvedFromPath) {
      clearWslOpencodeResolution();
      state.resolvedOpencodeBinarySource = 'path';
      return resolvedFromPath;
    }

    const home = os.homedir();
    const unixFallbacks = [
      path.join(home, '.opencode', 'bin', 'opencode'),
      path.join(home, '.bun', 'bin', 'opencode'),
      path.join(home, '.local', 'bin', 'opencode'),
      path.join(home, 'bin', 'opencode'),
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
      '/usr/bin/opencode',
      '/bin/opencode',
    ];

    const winFallbacks = (() => {
      const userProfile = process.env.USERPROFILE || home;
      const appData = process.env.APPDATA || '';
      const localAppData = process.env.LOCALAPPDATA || '';
      const programData = process.env.ProgramData || 'C:\\ProgramData';

      return [
        path.join(userProfile, '.opencode', 'bin', 'opencode.exe'),
        path.join(userProfile, '.opencode', 'bin', 'opencode.cmd'),
        path.join(appData, 'npm', 'opencode.cmd'),
        path.join(userProfile, 'scoop', 'shims', 'opencode.cmd'),
        path.join(programData, 'chocolatey', 'bin', 'opencode.exe'),
        path.join(programData, 'chocolatey', 'bin', 'opencode.cmd'),
        path.join(userProfile, '.bun', 'bin', 'opencode.exe'),
        path.join(userProfile, '.bun', 'bin', 'opencode.cmd'),
        localAppData ? path.join(localAppData, 'Programs', 'opencode', 'opencode.exe') : '',
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
          const found = lines.find((line) => isExecutable(line));
          if (found) {
            clearWslOpencodeResolution();
            state.resolvedOpencodeBinarySource = 'where';
            return found;
          }
        }
      } catch {
      }
      const wsl = probeWslForOpencode();
      if (wsl) {
        return applyWslOpencodeResolution({
          wslBinary: wsl.wslBinary,
          opencodePath: wsl.opencodePath,
          source: 'wsl',
          distro: wsl.distro,
        });
      }
      return null;
    }

    const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
    for (const shell of shells) {
      if (!isExecutable(shell)) continue;
      try {
        const result = spawnSync(shell, ['-lic', 'command -v opencode'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
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
      }
    }

    return null;
  };

  const resolveNodeCliPath = () => {
    const explicit = [process.env.NODE_BINARY, process.env.OPENCHAMBER_NODE_BINARY]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
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
        const result = spawnSync('where', ['node'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
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
      }
      return null;
    }

    const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
    for (const shell of shells) {
      if (!isExecutable(shell)) continue;
      try {
        const result = spawnSync(shell, ['-lic', 'command -v node'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        if (result.status === 0) {
          const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
          if (found && isExecutable(found)) {
            return found;
          }
        }
      } catch {
      }
    }

    return null;
  };

  const resolveBunCliPath = () => {
    const explicit = [process.env.BUN_BINARY, process.env.OPENCHAMBER_BUN_BINARY]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
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
        const result = spawnSync('where', ['bun'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
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
      }
      return null;
    }

    const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
    for (const shell of shells) {
      if (!isExecutable(shell)) continue;
      try {
        const result = spawnSync(shell, ['-lic', 'command -v bun'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        if (result.status === 0) {
          const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
          if (found && isExecutable(found)) {
            return found;
          }
        }
      } catch {
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

  const normalizeExecutableCandidate = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return isExecutable(trimmed) ? trimmed : null;
  };

  const getWindowsNativeOpencodePackageNames = () => {
    if (process.arch === 'arm64') {
      return ['opencode-windows-arm64'];
    }
    if (process.arch === 'x64') {
      // Prefer the baseline build when bypassing package-manager wrappers so the
      // direct binary still runs on hosts without AVX2 support.
      return ['opencode-windows-x64-baseline', 'opencode-windows-x64'];
    }
    return [];
  };

  const resolveNativeOpencodeBinaryFromNodeModules = (nodeModulesDir) => {
    if (typeof nodeModulesDir !== 'string' || nodeModulesDir.trim().length === 0) {
      return null;
    }

    for (const packageName of getWindowsNativeOpencodePackageNames()) {
      const candidate = path.join(nodeModulesDir, packageName, 'bin', 'opencode.exe');
      if (isExecutable(candidate)) {
        return candidate;
      }
    }

    return null;
  };

  const resolveOpencodeNodeLaunchSpecFromNodeModules = (nodeModulesDir) => {
    if (typeof nodeModulesDir !== 'string' || nodeModulesDir.trim().length === 0) {
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

  const resolveNodeModulesDirFromCmdWrapper = (wrapperPath) => {
    if (!wrapperPath || typeof wrapperPath !== 'string') {
      return null;
    }

    try {
      const content = fs.readFileSync(wrapperPath, 'utf8');
      const launcherMatch = content.match(/node_modules[\\/]+opencode-ai[\\/]+bin[\\/]+opencode/i);
      if (!launcherMatch) {
        return null;
      }

      const launcherPath = path.resolve(path.dirname(wrapperPath), launcherMatch[0]);
      return path.dirname(path.dirname(path.dirname(launcherPath)));
    } catch {
      return null;
    }
  };

  const resolveOpencodeNodeModulesDir = (opencodePath) => {
    if (typeof opencodePath !== 'string' || opencodePath.trim().length === 0) {
      return null;
    }

    const normalized = path.resolve(opencodePath);
    const lower = normalized.toLowerCase();
    const fileDir = path.dirname(normalized);
    const nodeModulesCandidates = [];
    const pushCandidate = (candidate) => {
      if (typeof candidate !== 'string' || candidate.trim().length === 0) {
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

  const resolveManagedOpenCodeLaunchSpec = (opencodePath) => {
    const fallbackBinary = typeof opencodePath === 'string' && opencodePath.trim().length > 0
      ? opencodePath.trim()
      : 'opencode';

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
        return {
          binary: directBinary,
          args: [],
          wrapperType: directBinary === fallbackBinary ? null : 'executable-wrapper',
        };
      }
    }

    return { binary: fallbackBinary, args: [], wrapperType: null };
  };

  const readShebang = (opencodePath) => {
    if (!opencodePath || typeof opencodePath !== 'string') {
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
        }
      }
    } catch {
      return null;
    }
  };

  const opencodeShimInterpreter = (opencodePath) => {
    const shebang = readShebang(opencodePath);
    if (!shebang) return null;
    if (/\bnode\b/i.test(shebang)) return 'node';
    if (/\bbun\b/i.test(shebang)) return 'bun';
    return null;
  };

  const ensureOpencodeShimRuntime = (opencodePath) => {
    const runtime = opencodeShimInterpreter(opencodePath);
    if (runtime === 'node') {
      ensureNodeCliEnv();
    }
    if (runtime === 'bun') {
      ensureBunCliEnv();
    }
  };

  const normalizeOpencodeBinarySetting = (raw) => {
    if (typeof raw !== 'string') {
      return null;
    }
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
    }

    return trimmed;
  };

  const applyOpencodeBinaryFromSettings = async () => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      if (!settings || typeof settings !== 'object') {
        return null;
      }
      if (!Object.prototype.hasOwnProperty.call(settings, 'opencodeBinary')) {
        return null;
      }

      const normalized = normalizeOpencodeBinarySetting(settings.opencodeBinary);

      if (normalized === '') {
        delete process.env.OPENCODE_BINARY;
        state.resolvedOpencodeBinary = null;
        state.resolvedOpencodeBinarySource = null;
        clearWslOpencodeResolution();
        return null;
      }

      const raw = typeof settings.opencodeBinary === 'string' ? settings.opencodeBinary.trim() : '';
      const explicitWslPath = process.platform === 'win32' && typeof raw === 'string'
        ? raw.match(/^wsl:\s*(.+)$/i)
        : null;

      if (explicitWslPath && explicitWslPath[1] && explicitWslPath[1].trim().length > 0) {
        const probe = probeWslForOpencode();
        const applied = applyWslOpencodeResolution({
          wslBinary: probe?.wslBinary || resolveWslExecutablePath(),
          opencodePath: explicitWslPath[1].trim(),
          source: 'settings-wsl-path',
          distro: probe?.distro || ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
        });
        if (applied) {
          return applied;
        }
      }

      if (process.platform === 'win32' && (isWslExecutableValue(raw) || isWslExecutableValue(normalized || ''))) {
        const probe = probeWslForOpencode();
        const applied = applyWslOpencodeResolution({
          wslBinary: probe?.wslBinary || normalized || raw || null,
          opencodePath: probe?.opencodePath || 'opencode',
          source: 'settings-wsl',
          distro: probe?.distro || ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
        });
        if (applied) {
          return applied;
        }
      }

      if (normalized && isExecutable(normalized)) {
        clearWslOpencodeResolution();
        process.env.OPENCODE_BINARY = normalized;
        prependToPath(path.dirname(normalized));
        state.resolvedOpencodeBinary = normalized;
        state.resolvedOpencodeBinarySource = 'settings';
        ensureOpencodeShimRuntime(normalized);
        return normalized;
      }

      if (raw) {
        console.warn(`Configured settings.opencodeBinary is not executable: ${raw}`);
      }
    } catch {
    }

    return null;
  };

  const ensureOpencodeCliEnv = () => {
    if (state.resolvedOpencodeBinary) {
      if (state.useWslForOpencode) {
        return state.resolvedOpencodeBinary;
      }
      ensureOpencodeShimRuntime(state.resolvedOpencodeBinary);
      return state.resolvedOpencodeBinary;
    }

    const existing = typeof process.env.OPENCODE_BINARY === 'string' ? process.env.OPENCODE_BINARY.trim() : '';
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

      process.env.OPENCODE_BINARY = resolved;
      prependToPath(path.dirname(resolved));
      ensureOpencodeShimRuntime(resolved);
      state.resolvedOpencodeBinary = resolved;
      state.resolvedOpencodeBinarySource = state.resolvedOpencodeBinarySource || 'unknown';
      console.log(`Resolved opencode CLI: ${resolved}`);
      return resolved;
    }

    clearWslOpencodeResolution();
    return null;
  };

  const resolveGitBinaryForSpawn = () => {
    if (process.platform !== 'win32') {
      return 'git';
    }

    if (state.resolvedGitBinary) {
      return state.resolvedGitBinary;
    }

    const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    for (const candidate of explicit) {
      if (isExecutable(candidate)) {
        state.resolvedGitBinary = candidate;
        return state.resolvedGitBinary;
      }
    }

    const candidates = [];
    const normalizeGitCandidate = (candidate) => {
      if (typeof candidate !== 'string') {
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
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
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
    resolveManagedOpenCodeLaunchSpec,
    isExecutable,
    searchPathFor,
    resolveGitBinaryForSpawn,
    resolveWslExecutablePath,
    buildWslExecArgs,
    clearResolvedOpenCodeBinary,
  };
};
