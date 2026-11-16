import { execFile } from 'node:child_process';

const TERMINAL_SHELL_IDS = ['bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu'];
const TERMINAL_SHELL_ID_SET = new Set(TERMINAL_SHELL_IDS);
const isString = (value) => String(value) === value;

export const normalizeTerminalShell = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'auto' || TERMINAL_SHELL_ID_SET.has(normalized) ? normalized : null;
};

const shellIdFromPath = (value) => {
  const filename = String(value || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  const id = filename.endsWith('.exe') ? filename.slice(0, -4) : filename;
  return TERMINAL_SHELL_ID_SET.has(id) ? id : null;
};

const SHELL_LABELS = { pwsh: 'PowerShell', powershell: 'Windows PowerShell', cmd: 'Command Prompt' };
const shellLabel = (id) => SHELL_LABELS[id] ?? id;

export const getTerminalShellLoginArgs = (executable, platform = process.platform) => {
  const id = shellIdFromPath(executable);
  if (id === 'bash' || id === 'zsh' || id === 'ksh') return ['-l'];
  if (id === 'fish' || id === 'nu') return ['--login'];
  if (id === 'pwsh' && platform !== 'win32') return ['-Login'];
  return null;
};

export const buildTerminalShellLaunch = (executable, { mode = 'interactive', command = null, loginShell = false, platform = process.platform } = {}) => {
  const loginArgs = loginShell ? getTerminalShellLoginArgs(executable, platform) : [];
  if (!loginArgs) throw new Error(`Terminal shell "${shellIdFromPath(executable) ?? executable}" does not support login mode`);

  if (mode === 'interactive') return { executable, args: loginArgs };

  const trimmedCommand = isString(command) ? command.trim() : '';
  if (!trimmedCommand) throw new Error('Terminal command is required');

  const id = shellIdFromPath(executable);
  if (id === 'nu') return { executable, args: [...loginArgs, '-c', trimmedCommand] };
  if (id === 'pwsh' || id === 'powershell') return { executable, args: [...loginArgs, '-Command', trimmedCommand] };
  if (id === 'cmd') return { executable, args: ['/d', '/s', '/c', trimmedCommand] };
  return { executable, args: [...loginArgs, '-i', '-c', trimmedCommand] };
};

export const createTerminalShellResolver = ({ fs, path, searchPathFor, isExecutable, probePowerShell = (file) => new Promise((resolve) => {
  execFile(file, ['-NoProfile', '-Command', 'exit 0'], { timeout: 3000, windowsHide: true }, (error) => resolve(!error));
}), buildAugmentedPath = () => env.PATH || '', platform = process.platform, env = process.env }) => {
  const isPowerShellAlias = async (file) => {
    try {
      fs.statSync(file);
      return false;
    } catch (error) {
      if (error?.code !== 'EACCES') return false;
    }
    return probePowerShell(file);
  };

  const resolveExecutable = async (candidate, aliases) => {
    if (!candidate) return null;
    const value = String(candidate);
    const probeAlias = (file) => {
      const key = file.toLowerCase();
      if (!aliases.has(key)) aliases.set(key, isPowerShellAlias(file));
      return aliases.get(key);
    };
    if (platform === 'win32' && /^(?:pwsh|pwsh\.exe)$/i.test(value)) {
      for (const directory of buildAugmentedPath().split(';').filter(Boolean)) {
        const found = searchPathFor(value, directory);
        if (found && isExecutable(found)) return found;
        const alias = path.join(directory, 'pwsh.exe');
        if (await probeAlias(alias)) return alias;
      }
      return null;
    }
    const found = value.includes('/') || value.includes('\\') ? value : searchPathFor(value, buildAugmentedPath());
    if (found && isExecutable(found)) return found;
    if (platform === 'win32' && found && shellIdFromPath(found) === 'pwsh' && await probeAlias(found)) return found;
    return isExecutable(value) ? value : null;
  };

  const defaultCandidates = () => platform === 'win32'
    ? [
        env.OPENCHAMBER_TERMINAL_SHELL,
        env.SHELL,
        env.ComSpec,
        path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        'pwsh.exe',
        'powershell.exe',
        'cmd.exe',
      ]
    : [env.OPENCHAMBER_TERMINAL_SHELL, env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh'];

  const resolveCandidates = async function* (candidates, cache = new Map(), aliases = new Map()) {
    const seen = new Set();
    for (const candidate of candidates) {
      if (!cache.has(candidate)) cache.set(candidate, resolveExecutable(candidate, aliases));
      const executable = await cache.get(candidate);
      if (executable && !seen.has(executable)) {
        seen.add(executable);
        yield executable;
      }
    }
  };

  const candidatesForList = async () => {
    let configuredShells = [];
    if (platform !== 'win32') {
      try {
        const contents = await fs.promises.readFile('/etc/shells', 'utf8');
        configuredShells = contents
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
      } catch {
        // PATH and platform defaults below remain authoritative fallbacks.
      }
    }

    return platform === 'win32'
      ? [...defaultCandidates(), ...TERMINAL_SHELL_IDS]
      : [env.OPENCHAMBER_TERMINAL_SHELL, env.SHELL, ...configuredShells, ...TERMINAL_SHELL_IDS, '/bin/zsh', '/bin/bash', '/bin/sh'];
  };

  const list = async () => {
    const candidates = await candidatesForList();
    const cache = new Map();
    const aliases = new Map();
    let autoExecutable = null;
    for await (const executable of resolveCandidates(defaultCandidates(), cache, aliases)) {
      autoExecutable = executable;
      break;
    }
    const byId = new Map([
      ['auto', {
        id: 'auto',
        name: 'Auto',
        executable: autoExecutable,
        supportsLogin: Boolean(autoExecutable && getTerminalShellLoginArgs(autoExecutable, platform)),
      }],
    ]);
    for await (const executable of resolveCandidates(candidates, cache, aliases)) {
      const id = shellIdFromPath(executable);
      if (id && !byId.has(id)) {
        byId.set(id, { id, name: shellLabel(id), executable, supportsLogin: Boolean(getTerminalShellLoginArgs(executable, platform)) });
      }
    }
    return [...byId.values()];
  };

  const resolve = async (preference) => {
    const normalized = normalizeTerminalShell(preference ?? 'auto');
    if (!normalized) throw new Error('Invalid terminal shell');
    if (normalized === 'auto') return { id: 'auto', executables: resolveCandidates(defaultCandidates()) };
    const candidates = (await candidatesForList()).filter((candidate) => shellIdFromPath(candidate) === normalized);
    for await (const executable of resolveCandidates(candidates)) {
      if (shellIdFromPath(executable) === normalized) return { id: normalized, executables: [executable] };
    }
    throw new Error(`Terminal shell "${normalized}" is not available`);
  };

  return { list, resolve };
};
