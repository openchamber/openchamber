import { describe, expect, it } from 'vitest';

import { SpaceError } from '../errors.js';
import { createDockerSetup } from './docker-setup.js';

const MISSING = { available: false, code: 'docker_cli_missing', message: '' };
const DOWN = { available: false, code: 'docker_daemon_unreachable', message: '' };
const DENIED = { available: false, code: 'docker_permission_denied', message: '' };
const UP = { available: true, version: '29.1.0', os: 'linux', arch: 'arm64', hostIsolation: true };

/**
 * A setup over recorded commands. `programs` are the programs `findProgram` finds, `answer(file,
 * args)` answers a command, and `checks` are what the place's check says, one per call, the last
 * one repeated.
 */
const makeSetup = ({ platform = 'darwin', programs = [], answer = () => ({ code: 0, stdout: '', stderr: '' }), checks = [DOWN], pathExists = () => false } = {}) => {
  const commands = [];
  let checkCalls = 0;
  const setup = createDockerSetup({
    platform,
    pathExists,
    home: '/Users/me',
    dockerPath: '/opt/homebrew/bin/docker',
    findProgram: (name) => (programs.includes(name) ? `/opt/homebrew/bin/${name}` : null),
    runCommand: async (file, args, options) => {
      commands.push({ file, args, env: options.env });
      return answer(file, args);
    },
    check: async () => checks[Math.min(checkCalls++, checks.length - 1)],
    wait: async () => {},
    logger: { warn: () => {} },
  });
  return { setup, commands };
};

/** Waits until the background action settled, as the screen's poll does. */
const settle = async (setup) => {
  for (let turn = 0; turn < 50 && setup.readJob()?.running; turn += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
  return setup.readJob();
};

describe('docker setup: what gets Docker going', () => {
  it.each([
    ['a Mac with Homebrew and nothing else', { programs: ['brew'] }, MISSING, 'install_all'],
    ['a Mac with Colima but no docker CLI', { programs: ['brew', 'colima'] }, MISSING, 'install_cli'],
    ['a Mac without Homebrew', { programs: [] }, MISSING, 'get_brew'],
    ['a Mac whose Colima is stopped', { programs: ['colima'] }, DOWN, 'start_colima'],
    ['a Mac whose Docker Desktop is closed', { pathExists: (candidate) => candidate === '/Applications/Docker.app' }, DOWN, 'start_desktop'],
    ['Docker Desktop in the home Applications folder', { pathExists: (candidate) => candidate === '/Users/me/Applications/Docker.app' }, DOWN, 'start_desktop'],
    ['a Mac with neither running nor installed engine to start', {}, DOWN, null],
    ['Linux without Docker', { platform: 'linux' }, MISSING, 'linux_install'],
    ['Linux with the daemon down', { platform: 'linux' }, DOWN, 'linux_start'],
    ['Linux where the user may not use the socket', { platform: 'linux' }, DENIED, 'permission'],
    ['Windows without Docker', { platform: 'win32' }, MISSING, 'windows_install'],
    ['Windows with Docker Desktop closed', { platform: 'win32', programs: ['colima'] }, DOWN, 'windows_start'],
  ])('%s', async (_name, options, checked, remedy) => {
    const { setup } = makeSetup(options);
    expect((await setup.describe(checked)).remedy).toBe(remedy);
  });

  it('offers nothing and reads the memory while Docker answers', async () => {
    const { setup, commands } = makeSetup({ answer: () => ({ code: 0, stdout: JSON.stringify([2 * 1024 ** 3, 'colima', 'Ubuntu 24.04']), stderr: '' }) });
    expect(await setup.describe(UP)).toEqual({ remedy: null, job: null, memory: { bytes: 2 * 1024 ** 3, engine: 'colima', low: true } });
    expect(commands[0].args[0]).toBe('info');
  });

  it('calls a large engine enough and names Docker Desktop', async () => {
    const { setup } = makeSetup({ answer: () => ({ code: 0, stdout: JSON.stringify([8 * 1024 ** 3, 'docker-desktop', 'Docker Desktop']), stderr: '' }) });
    expect((await setup.describe(UP)).memory).toEqual({ bytes: 8 * 1024 ** 3, engine: 'docker_desktop', low: false });
  });

  it('has no memory to show when the engine does not say', async () => {
    const { setup } = makeSetup({ answer: () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    expect((await setup.describe(UP)).memory).toBeNull();
  });

  it('reads no memory while Docker cannot take a space', async () => {
    const { setup, commands } = makeSetup({ programs: ['colima'] });
    expect((await setup.describe(DOWN)).memory).toBeNull();
    expect(commands).toEqual([]);
  });
});

describe('docker setup: the action', () => {
  it('installs Colima and docker with Homebrew, then finds Colima and starts it with room for a space', async () => {
    const programs = ['brew'];
    const answer = (_file, args) => {
      // Like Homebrew: the programs are on the PATH once it installed them.
      if (args[0] === 'install') programs.push('colima', 'docker');
      return { code: 0, stdout: '', stderr: '' };
    };
    const { setup, commands } = makeSetup({ programs, checks: [MISSING], answer });
    await setup.start('install_all');
    expect(await settle(setup)).toBeNull();
    expect(commands.map(({ file, args }) => [file, ...args])).toEqual([
      ['/opt/homebrew/bin/brew', 'install', 'colima', 'docker'],
      ['/opt/homebrew/bin/colima', 'list', '--json'],
      ['/opt/homebrew/bin/colima', 'start', '--memory', '6'],
    ]);
  });

  it('says so when Homebrew could not install', async () => {
    const { setup } = makeSetup({ programs: ['brew'], checks: [MISSING], answer: () => ({ code: 1, stdout: '', stderr: 'Error: No such file or directory' }) });
    await setup.start('install_all');
    expect(await settle(setup)).toMatchObject({ action: 'install_all', running: false, failure: { code: 'docker_setup_failed', output: 'Error: No such file or directory' } });
  });

  it('starts a new Colima machine with 6 GB when the user has none', async () => {
    const { setup, commands } = makeSetup({ programs: ['brew', 'colima'], checks: [DOWN] });
    await setup.start('start_colima');
    expect(await settle(setup)).toBeNull();
    expect(commands.map(({ args }) => args)).toEqual([['list', '--json'], ['start', '--memory', '6']]);
    expect(commands[1].env.NONINTERACTIVE).toBe('1');
  });

  it('starts the user\'s own Colima as it is', async () => {
    const answer = (_file, args) => (args[0] === 'list'
      ? { code: 0, stdout: `${JSON.stringify({ name: 'work', status: 'Stopped' })}\n${JSON.stringify({ name: 'default', status: 'Stopped' })}\n`, stderr: '' }
      : { code: 0, stdout: '', stderr: '' });
    const { setup, commands } = makeSetup({ programs: ['colima'], checks: [DOWN], answer });
    await setup.start('start_colima');
    await settle(setup);
    expect(commands.map(({ args }) => args)).toEqual([['list', '--json'], ['start', 'default']]);
  });

  it('starts another profile when the user has no default one', async () => {
    const answer = (_file, args) => (args[0] === 'list' ? { code: 0, stdout: `${JSON.stringify({ name: 'work' })}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' });
    const { setup, commands } = makeSetup({ programs: ['colima'], checks: [DOWN], answer });
    await setup.start('start_colima');
    await settle(setup);
    expect(commands[1].args).toEqual(['start', 'work']);
  });

  it('installs only the CLI, and starts Colima only when Docker still does not answer', async () => {
    const running = makeSetup({ programs: ['brew', 'colima'], checks: [MISSING, UP] });
    await running.setup.start('install_cli');
    expect(await settle(running.setup)).toBeNull();
    expect(running.commands.map(({ args }) => args)).toEqual([['install', 'docker']]);

    const stopped = makeSetup({ programs: ['brew', 'colima'], checks: [MISSING, DOWN] });
    await stopped.setup.start('install_cli');
    await settle(stopped.setup);
    expect(stopped.commands.map(({ args }) => args)).toEqual([['install', 'docker'], ['list', '--json'], ['start', '--memory', '6']]);
  });

  it('keeps the end of the output of a command that failed', async () => {
    const answer = (_file, args) => (args[0] === 'start' ? { code: 1, stdout: 'starting', stderr: 'vz: not enough memory' } : { code: 0, stdout: '', stderr: '' });
    const { setup } = makeSetup({ programs: ['colima'], checks: [DOWN], answer });
    await setup.start('start_colima');
    const job = await settle(setup);
    expect(job).toMatchObject({ action: 'start_colima', running: false, failure: { code: 'docker_setup_failed' } });
    expect(job.failure.output).toContain('vz: not enough memory');
  });

  it('opens Docker Desktop and waits until it answers', async () => {
    const { setup, commands } = makeSetup({ pathExists: (candidate) => candidate === '/Applications/Docker.app', checks: [DOWN, DOWN, DOWN, UP] });
    await setup.start('start_desktop');
    expect(await settle(setup)).toBeNull();
    expect(commands.map(({ file, args }) => [file, ...args])).toEqual([['/usr/bin/open', '-a', 'Docker']]);
  });

  it('gives up on Docker Desktop that never answers', async () => {
    const { setup } = makeSetup({ pathExists: () => true, checks: [DOWN] });
    await setup.start('start_desktop');
    expect(await settle(setup)).toMatchObject({ running: false, failure: { code: 'docker_setup_timeout' } });
  });

  it('runs only what the place offers now', async () => {
    const { setup, commands } = makeSetup({ programs: ['brew', 'colima'], checks: [UP] });
    await expect(setup.start('start_colima')).rejects.toMatchObject({ code: 'docker_setup_not_offered' });
    await expect(setup.start('rm -rf')).rejects.toMatchObject({ code: 'invalid_request_body' });
    expect(commands).toEqual([]);
  });

  it('runs one action at a time', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const answer = async (_file, args) => {
      if (args[0] === 'start') await gate;
      return { code: 0, stdout: '', stderr: '' };
    };
    const { setup } = makeSetup({ programs: ['colima'], checks: [DOWN], answer });
    expect(await setup.start('start_colima')).toMatchObject({ action: 'start_colima', running: true });
    await expect(setup.start('start_colima')).rejects.toBeInstanceOf(SpaceError);
    await expect(setup.start('start_colima')).rejects.toMatchObject({ code: 'docker_setup_running' });
    release();
    expect(await settle(setup)).toBeNull();
  });
});
