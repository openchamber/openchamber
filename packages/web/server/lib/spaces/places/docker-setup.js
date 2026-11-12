import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SpaceError } from '../errors.js';

/**
 * Getting Docker ready on this computer, for the local Docker place: what is missing or stopped,
 * in words the screens turn into one action, and that action run in the background. The Docker
 * over SSH place has none of this; its machine is the user's to set up.
 *
 * The maintainer's calls of 2026-10-15: on a Mac with Homebrew one button installs Colima and the
 * docker CLI and starts Colima, or starts the Colima or Docker Desktop already there; a Mac
 * without Homebrew is sent to brew.sh; Linux and Windows get the exact step to take themselves,
 * because there it needs an administrator. A Colima the user already has is started as it is and
 * never reconfigured: when its memory is too small for a space, the screen says how to raise it.
 */

// What a Colima machine created here gets: a space takes up to 4 GiB, its gatekeeper and the
// machine's own system the rest.
const COLIMA_MEMORY_GIB = 6;
// Below this the engine cannot hold one space at its limit next to its gatekeeper.
const MEMORY_ENOUGH_BYTES = 4.5 * 1024 ** 3;
// Homebrew can update itself first and download bottles; a first Colima start downloads its machine image.
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const START_TIMEOUT_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 10_000;
const DESKTOP_START_TIMEOUT_MS = 3 * 60_000;
const DESKTOP_POLL_MS = 3_000;
// The end of a failed command's output kept for the screen: enough for Homebrew's or Colima's reason.
const OUTPUT_TAIL_CHARS = 4_000;
// Colima names its Docker machine `colima`, or `colima-<profile>` for another profile.
const COLIMA_MACHINE = /^colima(?:-[A-Za-z0-9._-]+)?$/;

/** The actions a user can start; each remedy below offers at most one of them. */
export const DOCKER_SETUP_ACTIONS = ['install_all', 'install_cli', 'start_colima', 'start_desktop'];

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const tailOf = (text) => (text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text).trim();

/**
 * `runCommand` starts a program as `run-command.js` does, `findProgram(name)` answers its path or
 * null and is asked at every look, so a program installed meanwhile is found, `dockerPath` is the
 * CLI the place runs, `environment` the environment of every command here, `check()` the local
 * place's own check, and `platform`, `pathExists`, `home` and `wait` are injectable for the tests.
 */
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
}) {
  // The one action under way or the last one that failed; a success clears it, the place then answers.
  let job = null;
  const commandEnvironment = { ...environment, NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1' };

  const hasDockerDesktop = () => platform === 'darwin'
    && [path.join('/Applications', 'Docker.app'), path.join(home, 'Applications', 'Docker.app')].some((candidate) => pathExists(candidate));

  /** Which one action, or which instruction, gets Docker going from what the check said; null when nothing does. */
  const remedyOf = (checked) => {
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

  /** How much memory the running engine has and what it is; null when it does not say. */
  const readMemory = async () => {
    try {
      const result = await runCommand(dockerPath, ['info', '--format', '[{{json .MemTotal}},{{json .Name}},{{json .OperatingSystem}}]'], { timeoutMs: READ_TIMEOUT_MS, env: commandEnvironment });
      if (result.code !== 0) return null;
      const [bytes, name, system] = JSON.parse(result.stdout);
      if (typeof bytes !== 'number' || bytes <= 0) return null;
      const engine = COLIMA_MACHINE.test(String(name)) ? 'colima' : system === 'Docker Desktop' ? 'docker_desktop' : 'other';
      return { bytes, engine, low: bytes < MEMORY_ENOUGH_BYTES };
    } catch {
      return null;
    }
  };

  /**
   * What the places page and the create dialog show for this computer, from the place's own check:
   * the remedy while Docker cannot take a space, the action under way or the last one that failed,
   * and the engine's memory while it answers.
   */
  const describe = async (checked) => ({
    remedy: remedyOf(checked),
    job,
    memory: checked.available ? await readMemory() : null,
  });

  const run = async (program, args, timeoutMs) => {
    const result = await runCommand(program, args, { timeoutMs, env: commandEnvironment, keepTail: true, maxOutputBytes: 256 * 1024 });
    if (result.code !== 0) {
      throw new SpaceError('docker_setup_failed', `${path.basename(program)} ${args.join(' ')} exited with code ${result.code}`, { output: tailOf(`${result.stdout}\n${result.stderr}`) });
    }
    return result;
  };

  const requireProgram = (name) => {
    const found = findProgram(name);
    if (found === null) throw new SpaceError('docker_setup_failed', `${name} was not found`, { output: '' });
    return found;
  };

  /**
   * Starts Colima: the user's own machine as it is, the first one listed, or a new one with the
   * memory a space needs when there is none.
   */
  const startColima = async () => {
    const colima = requireProgram('colima');
    const listed = await run(colima, ['list', '--json'], READ_TIMEOUT_MS);
    const profiles = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try {
        const name = JSON.parse(line)?.name;
        return typeof name === 'string' && name !== '' ? [name] : [];
      } catch {
        return [];
      }
    });
    const profile = profiles.includes('default') ? 'default' : profiles[0] ?? null;
    await run(colima, profile === null ? ['start', '--memory', String(COLIMA_MEMORY_GIB)] : ['start', profile], START_TIMEOUT_MS);
  };

  /** Opens Docker Desktop and waits until its engine answers. */
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
      // The CLI may have been all that was missing; Colima is started only when Docker still does not answer.
      if (!(await check()).available) await startColima();
    },
    start_colima: startColima,
    start_desktop: startDockerDesktop,
  };

  /**
   * Starts `action` in the background and answers the job at once. Only the action the place's
   * state offers now runs, so nothing is installed or started that the screen did not show; one
   * action at a time.
   */
  const start = async (action) => {
    if (job?.running) throw new SpaceError('docker_setup_running', 'Docker is already being set up.');
    if (!DOCKER_SETUP_ACTIONS.includes(action)) throw new SpaceError('invalid_request_body', `Unknown action '${action}'.`);
    const offered = remedyOf(await check());
    if (offered !== action) throw new SpaceError('docker_setup_not_offered', 'Docker is in another state now. Check again.');
    const current = { action, running: true, failure: null };
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
