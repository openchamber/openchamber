import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SpaceError } from '../errors.js';
import type { RunCommand } from '../command-contracts.js';

type DockerSetupAction = 'install_all' | 'install_cli' | 'start_colima' | 'start_desktop';

export interface DockerCheck {
  available: boolean;
  code?: string;
}

export interface DockerSetupJob {
  action: DockerSetupAction;
  running: boolean;
  failure: { code: unknown; message: unknown; output: unknown } | null;
}

interface DockerSetupOptions {
  runCommand: RunCommand;
  findProgram: (name: string) => string | null;
  dockerPath?: string;
  environment?: NodeJS.ProcessEnv;
  check: () => Promise<DockerCheck>;
  platform?: NodeJS.Platform;
  pathExists?: typeof fs.existsSync;
  home?: string;
  wait?: (milliseconds: number) => Promise<void>;
  logger?: { warn?: (message: string) => void };
}

const isProfileName = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isMemoryBytes = (value: unknown): value is number => typeof value === 'number' && !(value <= 0);

const isSetupAction = (value: string): value is DockerSetupAction => DOCKER_SETUP_ACTIONS.includes(value);

const COLIMA_MEMORY_GIB = 6;
const MEMORY_ENOUGH_BYTES = 4.5 * 1024 ** 3;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const START_TIMEOUT_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 10_000;
const DESKTOP_START_TIMEOUT_MS = 3 * 60_000;
const DESKTOP_POLL_MS = 3_000;
const OUTPUT_TAIL_CHARS = 4_000;
const COLIMA_MACHINE = /^colima(?:-[A-Za-z0-9._-]+)?$/;

export const DOCKER_SETUP_ACTIONS = ['install_all', 'install_cli', 'start_colima', 'start_desktop'];

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const tailOf = (text: string) => (text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text).trim();

export function createDockerSetup({
  runCommand,
  findProgram,
  dockerPath = 'docker',
  environment = process.env,
  check,
  platform = process.platform,
  pathExists = fs.existsSync,
  home = os.homedir(),
  wait = pause,
  logger = console,
}: DockerSetupOptions) {
  let job: DockerSetupJob | null = null;
  const commandEnvironment = { ...environment, NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1' };

  const hasDockerDesktop = () => platform === 'darwin'
    && [path.join('/Applications', 'Docker.app'), path.join(home, 'Applications', 'Docker.app')].some((candidate) => pathExists(candidate));

  const remedyOf = (checked: DockerCheck) => {
    if (checked.available) return null;
    const colima = findProgram('colima') !== null;
    if (checked.code === 'docker_permission_denied') return 'permission';
    if (checked.code === 'docker_cli_missing') {
      if (platform === 'darwin') {
        if (findProgram('brew') === null) return 'get_brew';
        return colima ? 'install_cli' : 'install_all';
      }
      if (platform === 'linux') return 'linux_install';
      if (platform === 'win32') return 'windows_install';
      return null;
    }
    if (checked.code === 'docker_daemon_unreachable') {
      if (colima && platform !== 'win32') return 'start_colima';
      if (hasDockerDesktop()) return 'start_desktop';
      if (platform === 'linux') return 'linux_start';
      if (platform === 'win32') return 'windows_start';
    }
    return null;
  };

  const readMemory = async () => {
    try {
      const result = await runCommand(dockerPath, ['info', '--format', '[{{json .MemTotal}},{{json .Name}},{{json .OperatingSystem}}]'], { timeoutMs: READ_TIMEOUT_MS, env: commandEnvironment });
      if (result.code !== 0) return null;
      const memory: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(memory)) return null;
      const [bytes, name, system]: unknown[] = memory;
      if (!isMemoryBytes(bytes)) return null;
      const engine = COLIMA_MACHINE.test(String(name)) ? 'colima' : system === 'Docker Desktop' ? 'docker_desktop' : 'other';
      return { bytes, engine, low: bytes < MEMORY_ENOUGH_BYTES };
    } catch {
      return null;
    }
  };

  const describe = async (checked: DockerCheck) => ({
    remedy: remedyOf(checked),
    job,
    memory: checked.available ? await readMemory() : null,
  });

  const run = async (program: string, args: string[], timeoutMs: number) => {
    const result = await runCommand(program, args, { timeoutMs, env: commandEnvironment, keepTail: true, maxOutputBytes: 256 * 1024 });
    if (result.code !== 0) {
      throw new SpaceError('docker_setup_failed', `${path.basename(program)} ${args.join(' ')} exited with code ${result.code}`, { output: tailOf(`${result.stdout}\n${result.stderr}`) });
    }
    return result;
  };

  const requireProgram = (name: string) => {
    const found = findProgram(name);
    if (found === null) throw new SpaceError('docker_setup_failed', `${name} was not found`, { output: '' });
    return found;
  };

  const startColima = async () => {
    const colima = requireProgram('colima');
    const listed = await run(colima, ['list', '--json'], READ_TIMEOUT_MS);
    const profiles = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        const profile: object | null = parsed === null ? null : Object(parsed);
        const name: unknown = profile && 'name' in profile ? profile.name : undefined;
        return isProfileName(name) ? [name] : [];
      } catch {
        return [];
      }
    });
    const profile = profiles.includes('default') ? 'default' : profiles[0] ?? null;
    await run(colima, profile === null ? ['start', '--memory', String(COLIMA_MEMORY_GIB)] : ['start', profile], START_TIMEOUT_MS);
  };

  const startDockerDesktop = async () => {
    await run('/usr/bin/open', ['-a', 'Docker'], READ_TIMEOUT_MS);
    for (let waited = 0; waited < DESKTOP_START_TIMEOUT_MS; waited += DESKTOP_POLL_MS) {
      await wait(DESKTOP_POLL_MS);
      if ((await check()).available) return;
    }
    throw new SpaceError('docker_setup_timeout', 'Docker Desktop did not start within three minutes', { output: '' });
  };

  const steps = {
    install_all: async () => {
      await run(requireProgram('brew'), ['install', 'colima', 'docker'], INSTALL_TIMEOUT_MS);
      await startColima();
    },
    install_cli: async () => {
      await run(requireProgram('brew'), ['install', 'docker'], INSTALL_TIMEOUT_MS);
      if (!(await check()).available) await startColima();
    },
    start_colima: startColima,
    start_desktop: startDockerDesktop,
  };

  const start = async (action: string) => {
    if (job?.running) throw new SpaceError('docker_setup_running', 'Docker is already being set up.');
    if (!isSetupAction(action)) throw new SpaceError('invalid_request_body', `Unknown action '${action}'.`);
    const offered = remedyOf(await check());
    if (offered !== action) throw new SpaceError('docker_setup_not_offered', 'Docker is in another state now. Check again.');
    const current: DockerSetupJob = { action, running: true, failure: null };
    job = current;
    void steps[action]().then(
      () => { if (job === current) job = null; },
      (error) => {
        logger.warn?.(`[spaces] setting up Docker (${action}) failed: ${error.message}`);
        if (job === current) {
          job = { action, running: false, failure: { code: error.code ?? 'docker_setup_failed', message: error.message, output: error.details?.output ?? '' } };
        }
      },
    );
    return job;
  };

  return { describe, start, readJob: () => job };
}
