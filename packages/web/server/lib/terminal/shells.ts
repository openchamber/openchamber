import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import type * as nodePath from 'node:path';

export type TerminalShellId = 'bash' | 'zsh' | 'sh' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'dash' | 'ksh' | 'nu';
export type TerminalShellPreference = 'auto' | TerminalShellId;
export type TerminalLaunchMode = 'interactive' | 'command';

export interface TerminalShellLaunchOptions {
  mode?: TerminalLaunchMode | undefined;
  command?: string | null | undefined;
  loginShell?: boolean;
  platform?: NodeJS.Platform;
}

export interface TerminalShellResolverOptions {
  fs: { promises: Pick<typeof fsPromises, 'readFile'>; statSync?: typeof statSync };
  path: Pick<typeof nodePath, 'join'>;
  searchPathFor: (name: string, searchPath: string) => string | null;
  isExecutable: (candidate: string) => boolean;
  probePowerShell?: (file: string) => Promise<boolean>;
  buildAugmentedPath?: () => string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export type TerminalShellChoice = {
  id: 'auto';
  name: string;
  executable: string | null;
  supportsLogin: boolean;
} | {
  id: TerminalShellId;
  name: string;
  executable: string;
  supportsLogin: boolean;
};

export type TerminalShellResolution =
  | { id: 'auto'; executables: AsyncIterable<string> }
  | { id: TerminalShellId; executables: string[] };

const TERMINAL_SHELL_IDS: TerminalShellId[] = ['bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu'];
const TERMINAL_SHELL_ID_SET = new Set<string>(TERMINAL_SHELL_IDS);
const isString = (value: unknown): value is string => String(value) === value;
const isShellText = (value: unknown): value is string => typeof value === 'string';
const isTerminalShellId = (value: string): value is TerminalShellId => TERMINAL_SHELL_ID_SET.has(value);

export const normalizeTerminalShell = (value: string | null | undefined) => {
  if (!isShellText(value)) return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'auto' || isTerminalShellId(normalized) ? normalized : null;
};

const shellIdFromPath = (value: string) => {
  const filename = String(value || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  const id = filename.endsWith('.exe') ? filename.slice(0, -4) : filename;
  return isTerminalShellId(id) ? id : null;
};

const SHELL_LABELS = new Map<TerminalShellId, string>([
  ['pwsh', 'PowerShell'], ['powershell', 'Windows PowerShell'], ['cmd', 'Command Prompt'],
]);
const shellLabel = (id: TerminalShellId) => SHELL_LABELS.get(id) ?? id;

export const getTerminalShellLoginArgs = (executable: string, platform = process.platform) => {
  const id = shellIdFromPath(executable);
  if (id === 'bash' || id === 'zsh' || id === 'ksh') return ['-l'];
  if (id === 'fish' || id === 'nu') return ['--login'];
  if (id === 'pwsh' && platform !== 'win32') return ['-Login'];
  return null;
};

export const buildTerminalShellLaunch = (executable: string, { mode = 'interactive', command = null, loginShell = false, platform = process.platform }: TerminalShellLaunchOptions = {}) => {
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

const WINDOWS_APPS_DIRECTORY = /[\\/]WindowsApps[\\/](?:[^\\/]+[\\/])?[^\\/]+$/i;

export const createTerminalShellResolver = ({ fs, path, searchPathFor, isExecutable, probePowerShell = (file) => new Promise((resolve) => {
  execFile(file, ['-NoProfile', '-Command', 'exit 0'], { timeout: 3000, windowsHide: true }, (error) => resolve(!error));
}), buildAugmentedPath = () => env.PATH || '', platform = process.platform, env = process.env }: TerminalShellResolverOptions) => {
  const isPowerShellAlias = async (file: string) => {
    if (!WINDOWS_APPS_DIRECTORY.test(file)) return false;
    try {
      (fs.statSync ?? statSync)(file);
      return false;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EACCES')) return false;
    }
    return probePowerShell(file);
  };

  const resolveExecutable = async (candidate: string | undefined, aliases: Map<string, Promise<boolean>>) => {
    if (!candidate) return null;
    const value = String(candidate);
    const probeAlias = (file: string) => {
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
      return isExecutable(value) ? value : null;
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

  type Candidate = string | undefined;
  const resolveCandidates = async function* (
    candidates: Candidate[],
    cache = new Map<Candidate, Promise<string | null>>(),
    aliases = new Map<string, Promise<boolean>>(),
  ) {
    const seen = new Set<string>();
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
    let configuredShells: string[] = [];
    if (platform !== 'win32') {
      try {
        const contents = await fs.promises.readFile('/etc/shells', 'utf8');
        configuredShells = contents
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
      } catch { configuredShells = []; }
    }

    return platform === 'win32'
      ? [...defaultCandidates(), ...TERMINAL_SHELL_IDS]
      : [env.OPENCHAMBER_TERMINAL_SHELL, env.SHELL, ...configuredShells, ...TERMINAL_SHELL_IDS, '/bin/zsh', '/bin/bash', '/bin/sh'];
  };

  const list = async () => {
    const candidates = await candidatesForList();
    const cache = new Map<Candidate, Promise<string | null>>();
    const aliases = new Map<string, Promise<boolean>>();
    let autoExecutable: string | null = null;
    for await (const executable of resolveCandidates(defaultCandidates(), cache, aliases)) {
      autoExecutable = executable;
      break;
    }
    const byId = new Map<TerminalShellPreference, TerminalShellChoice>([
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

  const resolve = async (preference: string | null | undefined): Promise<TerminalShellResolution> => {
    const normalized = normalizeTerminalShell(preference ?? 'auto');
    if (!normalized) throw new Error('Invalid terminal shell');
    if (normalized === 'auto') return { id: 'auto', executables: resolveCandidates(defaultCandidates()) };
    const candidates = (await candidatesForList()).filter((candidate) => candidate && shellIdFromPath(candidate) === normalized);
    for await (const executable of resolveCandidates(candidates)) {
      if (shellIdFromPath(executable) === normalized) return { id: normalized, executables: [executable] };
    }
    throw new Error(`Terminal shell "${normalized}" is not available`);
  };

  return { list, resolve };
};
