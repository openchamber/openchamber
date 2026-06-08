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
  } = deps;
  const runSpawnSync = typeof deps.spawnSync === 'function' ? deps.spawnSync : spawnSync;

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

    if (Object.keys(result).length === 0) {
      return null;
    }

    if (process.platform === 'win32' && typeof result.PATH !== 'string') {
      const pathEntry = Object.entries(result).find(([key]) => key.toLowerCase() === 'path');
      if (pathEntry && typeof pathEntry[1] === 'string') {
        result.PATH = pathEntry[1];
      }
    }

    return result;
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

  const resolveWindowsExecutablePath = (candidate) => {
    if (process.platform !== 'win32' || typeof candidate !== 'string' || candidate.trim().length === 0) {
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

  const searchPathFor = (binaryName) => {
    const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
    if (!trimmed) {
      return null;
    }

    const current = process.env.PATH || '';
    const parts = current.split(path.delimiter).filter(Boolean);
    const candidateNames = [];

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
        const result = runSpawnSync(shellPath, ['-NoLogo', '-Command', psScript], {
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
      const result = runSpawnSync(comspec, ['/d', '/s', '/c', 'set'], {
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
        const result = runSpawnSync(shellPath, ['-lic', 'env -0'], {
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
        const result = runSpawnSync('where', ['opencode'], {
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
      // Do not auto-detect OpenCode from WSL. OpenCode sessions are keyed by
      // server-visible directories, and mixing Windows paths with WSL paths
      // creates duplicate/missing project state in the desktop app.
      return null;
    }

    const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
    for (const shell of shells) {
      if (!isExecutable(shell)) continue;
      try {
        const result = runSpawnSync(shell, ['-lic', 'command -v opencode'], {
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
        const result = runSpawnSync('where', ['node'], {
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
        const result = runSpawnSync(shell, ['-lic', 'command -v node'], {
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
        const result = runSpawnSync('where', ['bun'], {
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
        const result = runSpawnSync(shell, ['-lic', 'command -v bun'], {
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
    if (process.platform === 'win32') {
      return resolveWindowsExecutablePath(trimmed);
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

    const packageShim = path.join(nodeModulesDir, 'opencode-ai', 'bin', 'opencode.exe');
    if (isExecutable(packageShim)) {
      return packageShim;
    }

    for (const packageName of getWindowsNativeOpencodePackageNames()) {
      const candidates = [
        path.join(nodeModulesDir, packageName, 'bin', 'opencode.exe'),
        path.join(nodeModulesDir, 'opencode-ai', 'node_modules', packageName, 'bin', 'opencode.exe'),
      ];
      for (const candidate of candidates) {
        if (isExecutable(candidate)) {
          return candidate;
        }
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

      const launcherPath = path.resolve(path.dirname(wrapperPath), launcherMatch[0].replace(/[\\/]+/g, path.sep));
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

  const isMacOpenCodeAppBundlePath = (candidate) => {
    if (process.platform !== 'darwin' || typeof candidate !== 'string') {
      return false;
    }
    return /\/OpenCode\.app\/Contents\/MacOS\/(?:OpenCode|opencode-cli)$/i.test(candidate);
  };

  const createConfiguredOpencodeBinaryError = (raw, normalized) => {
    const configured = typeof raw === 'string' ? raw.trim() : '';
    const candidate = typeof normalized === 'string' && normalized.trim().length > 0 ? normalized.trim() : configured;
    const messageSuffix = 'OpenChamber needs the standalone opencode CLI. Install it and set settings.opencodeBinary to the CLI path, for example ~/.opencode/bin/opencode, or leave the setting empty to use PATH lookup.';
    const error = (() => {
      if (isMacOpenCodeAppBundlePath(candidate) || isMacOpenCodeAppBundlePath(configured)) {
        return new Error(`Configured OpenCode binary points at the macOS desktop app bundle, not the CLI: ${candidate}. ${messageSuffix}`);
      }

      try {
        const configuredStat = fs.statSync(configured);
        if (configuredStat.isDirectory()) {
          return new Error(`Configured OpenCode binary directory does not contain an executable ${process.platform === 'win32' ? 'opencode.exe' : 'opencode'}: ${configured}. ${messageSuffix}`);
        }
      } catch {
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

  const createConfiguredWslOpencodeError = (raw) => new Error(
    `Configured settings.opencodeBinary uses WSL but OpenChamber could not resolve a WSL OpenCode command: ${raw}. Ensure WSL is available and opencode is installed in the configured distro.`
  );

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

  const applyOpencodeBinaryFromSettings = async (options = {}) => {
    const strict = options?.strict === true;
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

      if (normalized && isExecutable(normalized) && !isMacOpenCodeAppBundlePath(normalized)) {
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
    clearResolvedOpenCodeBinary,
  };
};
