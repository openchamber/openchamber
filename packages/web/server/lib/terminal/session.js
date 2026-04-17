import { canonicalPath, toNativePath } from '../PathUtils.js';
import { IS_WIN } from '../platform.js';

export const TERMINAL_SHELL_PREFERENCES = ['default', 'powershell', 'cmd', 'bash', 'wsl'];

export const normalizeTerminalShellPreference = (value) => {
  if (typeof value !== 'string') {
    return 'default';
  }

  const normalized = value.trim().toLowerCase();
  return TERMINAL_SHELL_PREFERENCES.includes(normalized) ? normalized : 'default';
};

const resolveCandidate = (candidate, isExecutable, searchPathFor) => {
  if (typeof candidate !== 'string') {
    return null;
  }

  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  const lookedUp = trimmed.includes('/') || trimmed.includes('\\')
    ? trimmed
    : searchPathFor(trimmed);
  if (lookedUp && isExecutable(lookedUp)) {
    return lookedUp;
  }
  if (isExecutable(trimmed)) {
    return trimmed;
  }
  return null;
};

const getWindowsShellCandidatesForPreference = (preference, env, pathModule) => {
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  const comspec = env.ComSpec || 'cmd.exe';
  const powershellPath = pathModule.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const wslPath = pathModule.join(systemRoot, 'System32', 'wsl.exe');
  const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  const gitBashCandidates = programFiles.flatMap((root) => [
    pathModule.join(root, 'Git', 'bin', 'bash.exe'),
    pathModule.join(root, 'Git', 'usr', 'bin', 'bash.exe'),
  ]);

  switch (preference) {
    case 'powershell':
      return ['pwsh.exe', powershellPath, 'powershell.exe', comspec];
    case 'cmd':
      return [comspec, 'cmd.exe', powershellPath];
    case 'bash':
      return ['bash.exe', 'bash', ...gitBashCandidates, powershellPath, comspec];
    case 'wsl':
      return ['wsl.exe', wslPath, powershellPath, comspec];
    default:
      return [
        env.OPENCHAMBER_TERMINAL_SHELL,
        env.SHELL,
        comspec,
        powershellPath,
        'pwsh.exe',
        'powershell.exe',
        'cmd.exe',
      ];
  }
};

const getUnixShellCandidatesForPreference = (preference, env) => {
  switch (preference) {
    case 'powershell':
      return ['pwsh', '/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh', env.SHELL, '/bin/bash', 'bash', '/bin/sh', 'sh'];
    case 'cmd':
    case 'wsl':
      return [env.SHELL, '/bin/bash', 'bash', '/bin/sh', 'sh'];
    case 'bash':
      return ['/bin/bash', 'bash', env.SHELL, '/bin/zsh', 'zsh', '/bin/sh', 'sh'];
    default:
      return [env.OPENCHAMBER_TERMINAL_SHELL, env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh'];
  }
};

export const getTerminalShellCandidates = ({
  preference = 'default',
  env = process.env,
  pathModule,
  isExecutable,
  searchPathFor,
  platform = process.platform,
}) => {
  const normalizedPreference = normalizeTerminalShellPreference(preference);
  const candidates = platform === 'win32'
    ? getWindowsShellCandidatesForPreference(normalizedPreference, env, pathModule)
    : getUnixShellCandidatesForPreference(normalizedPreference, env);

  const resolved = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const executable = resolveCandidate(candidate, isExecutable, searchPathFor);
    if (!executable || seen.has(executable)) {
      continue;
    }
    seen.add(executable);
    resolved.push(executable);
  }

  return resolved;
};

export const createPtySession = (ptyProvider, {
  cols,
  rows,
  cwd,
  env,
  shellPreference = 'default',
  pathModule,
  isExecutable,
  searchPathFor,
  platform = process.platform,
}) => {
  const shellCandidates = getTerminalShellCandidates({
    preference: shellPreference,
    env,
    pathModule,
    isExecutable,
    searchPathFor,
    platform,
  });

  if (shellCandidates.length === 0) {
    throw new Error(`No executable shell found for terminal preference "${normalizeTerminalShellPreference(shellPreference)}"`);
  }

  const normalizedCwd = typeof cwd === 'string' && cwd.trim().length > 0
    ? toNativePath(canonicalPath(cwd))
    : cwd;

  let lastError = null;
  for (const shell of shellCandidates) {
    try {
      const ptyOptions = {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: normalizedCwd,
        env: {
          ...env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      };

      if (IS_WIN && ptyProvider?.backend === 'node-pty') {
        ptyOptions.useConpty = true;
      }

      const ptyProcess = ptyProvider.spawn(shell, [], ptyOptions);
      return {
        ptyProcess,
        shell,
        shellPreference: normalizeTerminalShellPreference(shellPreference),
        usedConpty: ptyOptions.useConpty === true,
      };
    } catch (error) {
      lastError = error;
    }
  }

  const baseMessage = lastError && lastError.message ? lastError.message : 'PTY spawn failed';
  throw new Error(`Failed to spawn terminal PTY with available shells (${shellCandidates.join(', ')}): ${baseMessage}`);
};
