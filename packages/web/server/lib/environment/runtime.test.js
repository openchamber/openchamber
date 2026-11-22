import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvironmentRuntime } from './runtime.js';
import { createEnvironmentStore } from './store.js';
import { runAsUserAction } from './refresh-scope.js';

const USER_ACTION = { refresh: true };

const fakeChild = ({ stdout = '', code = 0, hang = false } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('close', null));
  });
  if (!hang) {
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
  }
  return child;
};

describe('environment runtime', () => {
  let root;
  let store;
  let projectPath;
  let clock;
  let logger;

  const createRuntime = (overrides = {}) => createEnvironmentRuntime({
    store,
    listProjects: async () => [{ id: 'path_project', path: projectPath }],
    spawn: vi.fn(() => fakeChild({ stdout: '{"FROM_COMMAND":"1"}' })),
    commandBaseEnv: () => ({ PATH: '/usr/bin' }),
    isEnterpriseMode: () => false,
    now: () => clock,
    logger,
    ...overrides,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-environment-runtime-'));
    projectPath = path.join(root, 'repo');
    fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
    fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
    store = createEnvironmentStore({ filePath: path.join(root, 'environment.json') });
    clock = 1_000;
    logger = { warn: vi.fn() };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('layers user variables, command output and project variables for a project directory', async () => {
    await store.updateUser({ variables: { SHARED: 'user', ONLY_USER: 'u' } });
    await store.updateProject('path_project', { variables: { SHARED: 'project' }, command: 'direnv export json' });
    const spawn = vi.fn(() => fakeChild({ stdout: '{"SHARED":"command","FROM_COMMAND":"1"}' }));
    const runtime = createRuntime({ spawn });

    expect(await runtime.forDirectory(path.join(projectPath, 'src'), USER_ACTION)).toEqual({
      SHARED: 'project',
      ONLY_USER: 'u',
      FROM_COMMAND: '1',
    });
    const [command, options] = spawn.mock.calls[0];
    expect(command).toBe('direnv export json');
    expect(options.cwd).toBe(projectPath);
    expect(options.env).toMatchObject({ PATH: '/usr/bin', SHARED: 'user' });
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'applied', count: 2 });
  });

  it('gives a directory outside every project only the user variables', async () => {
    await store.updateUser({ variables: { A: '1' } });
    await store.updateProject('path_project', { variables: { B: '2' } });
    const runtime = createRuntime();
    expect(await runtime.forDirectory(path.join(root, 'elsewhere'))).toEqual({ A: '1' });
  });

  it('answers null when nothing is configured', async () => {
    const runtime = createRuntime();
    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toBeNull();
  });

  it('applies a project to its linked worktree and runs the command in the worktree', async () => {
    await store.updateProject('path_project', { variables: { B: '2' }, command: 'devenv print-dev-env --json' });
    const worktree = path.join(root, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    const gitDir = path.join(projectPath, '.git', 'worktrees', 'feature');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    const spawn = vi.fn(() => fakeChild({ stdout: 'export FROM_COMMAND=1' }));
    const runtime = createRuntime({ spawn });

    expect(await runtime.forDirectory(worktree, USER_ACTION)).toEqual({ B: '2', FROM_COMMAND: '1' });
    expect(spawn.mock.calls[0][1].cwd).toBe(worktree);
  });

  it('reports a failing command, applies nothing from it and logs no output', async () => {
    await store.updateProject('path_project', { variables: { B: '2' }, command: 'direnv export json' });
    const spawn = vi.fn(() => fakeChild({ stdout: 'SECRET=leaked', code: 1 }));
    const runtime = createRuntime({ spawn });

    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toEqual({ B: '2' });
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'failed', reason: 'exit', exitCode: 1 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('leaked');
  });

  it('reports output it cannot read', async () => {
    await store.updateProject('path_project', { command: 'echo hello' });
    const runtime = createRuntime({ spawn: vi.fn(() => fakeChild({ stdout: 'hello' })) });
    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toBeNull();
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'failed', reason: 'unrecognized-output' });
  });

  it('kills a command that overruns its timeout', async () => {
    await store.updateProject('path_project', { command: 'sleep 100' });
    const child = fakeChild({ hang: true });
    const runtime = createRuntime({ spawn: vi.fn(() => child), commandTimeoutMs: 5 });
    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'failed', reason: 'timeout' });
  });

  it('decodes command output split across chunks inside a multi-byte character', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    const payload = Buffer.from('{"GREETING":"caf\u00e9 \ud83d\udd11 end"}', 'utf8');
    const emojiStart = payload.indexOf(0xf0);
    // The output is scheduled inside the spawn stub, like fakeChild, so the
    // emissions can only fire after runCommand has attached its listeners.
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); });
      queueMicrotask(() => {
        child.stdout.emit('data', payload.subarray(0, emojiStart + 2));
        child.stdout.emit('data', payload.subarray(emojiStart + 2));
        child.emit('close', 0);
      });
      return child;
    });
    const runtime = createRuntime({ spawn });

    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toEqual({ GREETING: 'caf\u00e9 \ud83d\udd11 end' });
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'applied', count: 1 });
  });

  it('judges the output cap in bytes, not decoded characters', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    // 2.2M two-byte characters: decoded length is under the 4 MiB cap, byte count is over it.
    let child;
    const spawn = vi.fn(() => {
      child = fakeChild({ stdout: '\u00e9'.repeat(2_200_000) });
      return child;
    });
    const runtime = createRuntime({ spawn });

    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'failed', reason: 'output-too-large' });
  });

  // The three cases below pin the incremental decoder and the cumulative
  // cap against their specific regressions (#1819): per-chunk decoding
  // (a split two-byte character corrupts), a dropped decoder.end() (a
  // trailing incomplete sequence vanishes instead of surfacing as
  // U+FFFD), and a per-chunk-only cap check (two under-cap chunks whose
  // total is over the cap sail through).
  const chunkedSpawn = (chunks) => vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); });
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.emit('data', chunk);
      child.emit('close', 0);
    });
    return child;
  });

  it('decodes command output split inside a two-byte character', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    const payload = Buffer.from('{"GREETING":"caf\u00e9 end"}', 'utf8');
    const splitAt = payload.indexOf(0xc3) + 1;
    const runtime = createRuntime({
      spawn: chunkedSpawn([payload.subarray(0, splitAt), payload.subarray(splitAt)]),
    });

    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toEqual({ GREETING: 'caf\u00e9 end' });
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'applied', count: 1 });
  });

  it('surfaces a trailing incomplete UTF-8 sequence as U+FFFD', async () => {
    await store.updateProject('path_project', { command: 'direnv export' });
    const runtime = createRuntime({
      spawn: chunkedSpawn([Buffer.from('KEY=abc', 'utf8'), Buffer.from([0xc3])]),
    });

    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toEqual({ KEY: 'abc\ufffd' });
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'applied', count: 1 });
  });

  it('enforces the output cap cumulatively across chunks', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    const chunk = Buffer.alloc(3 * 1024 * 1024, 0x61);
    let child;
    const spawn = chunkedSpawn([chunk, chunk]);
    const trackingSpawn = vi.fn((...args) => { child = spawn(...args); return child; });
    const runtime = createRuntime({ spawn: trackingSpawn });

    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'failed', reason: 'output-too-large' });
  });

  it('runs the command once, then serves the kept result and refreshes in the background', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    let output = '{"VERSION":"1"}';
    const spawn = vi.fn(() => fakeChild({ stdout: output }));
    const runtime = createRuntime({ spawn, commandTtlMs: 100 });

    const [first, second] = await Promise.all([runtime.forDirectory(projectPath, USER_ACTION), runtime.forDirectory(projectPath, USER_ACTION)]);
    expect(first).toEqual({ VERSION: '1' });
    expect(second).toEqual({ VERSION: '1' });
    expect(spawn).toHaveBeenCalledTimes(1);

    output = '{"VERSION":"2"}';
    clock += 200;
    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toEqual({ VERSION: '1' });
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect(await runtime.forDirectory(projectPath, USER_ACTION)).toEqual({ VERSION: '2' }));
  });

  it('never runs the command for a read, and lets a read use what a user action left', async () => {
    await store.updateProject('path_project', { variables: { B: '2' }, command: 'direnv export json' });
    const spawn = vi.fn(() => fakeChild({ stdout: '{"FROM_COMMAND":"1"}' }));
    const runtime = createRuntime({ spawn, commandTtlMs: 100 });

    expect(await runtime.forDirectory(projectPath)).toEqual({ B: '2' });
    expect(spawn).not.toHaveBeenCalled();

    await runtime.forDirectory(projectPath, USER_ACTION);
    expect(spawn).toHaveBeenCalledTimes(1);

    clock += 200;
    expect(await runtime.forDirectory(projectPath)).toEqual({ B: '2', FROM_COMMAND: '1' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('treats work inside runAsUserAction as a user action', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    const spawn = vi.fn(() => fakeChild({ stdout: '{"A":"1"}' }));
    const runtime = createRuntime({ spawn });
    expect(await runAsUserAction(() => runtime.forDirectory(projectPath))).toEqual({ A: '1' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('runs the command again after the project settings change', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    const spawn = vi.fn(() => fakeChild({ stdout: '{"A":"1"}' }));
    const runtime = createRuntime({ spawn });
    await runtime.forDirectory(projectPath, USER_ACTION);
    runtime.invalidateProject('path_project');
    expect(runtime.projectStatus('path_project')).toBeNull();
    await runtime.forDirectory(projectPath, USER_ACTION);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('reloads a project on request and answers its status', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    const runtime = createRuntime();
    expect(await runtime.reloadProject('path_project', projectPath)).toMatchObject({ state: 'applied', count: 1 });
    await store.updateProject('path_project', { command: null });
    expect(await runtime.reloadProject('path_project', projectPath)).toBeNull();
  });

  it('runs a fresh command on reload instead of joining a run started before the invalidation', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    const gated = new EventEmitter();
    gated.stdout = new EventEmitter();
    gated.kill = vi.fn();
    const releaseFirst = () => {
      gated.stdout.emit('data', Buffer.from('{"VERSION":"1"}'));
      gated.emit('close', 0);
    };
    const spawn = vi.fn()
      .mockImplementationOnce(() => gated)
      .mockImplementation(() => fakeChild({ stdout: '{"VERSION":"2"}' }));
    const runtime = createRuntime({ spawn });

    const first = runtime.forDirectory(projectPath, USER_ACTION);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));

    await store.updateProject('path_project', { command: 'new command' });
    const reloading = runtime.reloadProject('path_project', projectPath);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(spawn.mock.calls[1][0]).toBe('new command');

    releaseFirst();
    await expect(reloading).resolves.toMatchObject({ state: 'applied', count: 1 });
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'applied', count: 1 });
    await first;
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'applied', count: 1 });
  });

  it('gives OpenCode the service variables under the user variables, and nothing in enterprise mode', async () => {
    await store.updateUser({ variables: { SHARED: 'user' } });
    const readOpenCodeServiceEnv = () => ({ SHARED: 'service', ONLY_SERVICE: 's' });
    let enterprise = false;
    const runtime = createRuntime({ readOpenCodeServiceEnv, isEnterpriseMode: () => enterprise });
    expect(runtime.forOpenCode()).toEqual({ SHARED: 'user', ONLY_SERVICE: 's' });
    enterprise = true;
    expect(runtime.forOpenCode()).toEqual({});
  });

  it('reads vault references for the OpenCode launch only, and keeps the reference as its fingerprint', async () => {
    await store.updateUser({ variables: { GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential' } });
    const resolve = vi.fn(async (variables) => Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, value.startsWith('op://') ? 'ghp_secret' : value])));
    let enterprise = false;
    const runtime = createRuntime({ isEnterpriseMode: () => enterprise, vault: { resolve, status: () => ({}) } });
    expect(runtime.forOpenCode()).toEqual({ GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential' });
    await expect(runtime.forOpenCodeResolved()).resolves.toEqual({ GITHUB_TOKEN: 'ghp_secret' });
    expect(resolve).toHaveBeenLastCalledWith({ GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential' }, { refresh: true });
    enterprise = true;
    await expect(runtime.forOpenCodeResolved()).resolves.toEqual({});
  });

  it('reads vault references for a directory on a user action, and not on a background read', async () => {
    await store.updateUser({ variables: { GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential' } });
    const resolve = vi.fn(async (variables, { refresh }) => (refresh ? { GITHUB_TOKEN: 'ghp_secret' } : {}));
    const runtime = createRuntime({ vault: { resolve, status: () => ({}) } });
    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toEqual({ GITHUB_TOKEN: 'ghp_secret' });
    expect(await runtime.forDirectory(projectPath, { refresh: false })).toBeNull();
  });

  it('gives the project command the user variables with vault references read, never the reference text', async () => {
    await store.updateUser({ variables: { GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential', PLAIN: 'p' } });
    await store.updateProject('path_project', { command: 'direnv export json' });
    const resolve = vi.fn(async (variables) => Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, value.startsWith('op://') ? 'ghp_secret' : value])));
    const spawn = vi.fn(() => fakeChild({ stdout: '{"FROM_COMMAND":"1"}' }));
    const runtime = createRuntime({ spawn, vault: { resolve, status: () => ({}) } });

    await runtime.forDirectory(projectPath, USER_ACTION);

    const [, options] = spawn.mock.calls[0];
    expect(options.env).toMatchObject({ GITHUB_TOKEN: 'ghp_secret', PLAIN: 'p' });
    expect(JSON.stringify(options.env)).not.toContain('op://');
    expect(resolve).toHaveBeenCalledWith({ GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential', PLAIN: 'p' }, { refresh: true });
  });

  it('leaves a vault reference the resolver cannot read out of the project command environment', async () => {
    await store.updateUser({ variables: { GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential', PLAIN: 'p' } });
    await store.updateProject('path_project', { command: 'direnv export json' });
    const resolve = vi.fn(async (variables) => Object.fromEntries(Object.entries(variables).filter(([, value]) => !value.startsWith('op://'))));
    const spawn = vi.fn(() => fakeChild({ stdout: '{"FROM_COMMAND":"1"}' }));
    const runtime = createRuntime({ spawn, vault: { resolve, status: () => ({}) } });

    await runtime.forDirectory(projectPath, USER_ACTION);

    const [, options] = spawn.mock.calls[0];
    expect(options.env).toMatchObject({ PLAIN: 'p' });
    expect(options.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(JSON.stringify(options.env)).not.toContain('op://');
  });

  it('reads vault references for the project command on a reload', async () => {
    await store.updateUser({ variables: { GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential' } });
    await store.updateProject('path_project', { command: 'direnv export json' });
    const resolve = vi.fn(async (variables) => Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, value.startsWith('op://') ? 'ghp_secret' : value])));
    const spawn = vi.fn(() => fakeChild({ stdout: '{"FROM_COMMAND":"1"}' }));
    const runtime = createRuntime({ spawn, vault: { resolve, status: () => ({}) } });

    await runtime.reloadProject('path_project', projectPath);

    const [, options] = spawn.mock.calls[0];
    expect(options.env).toMatchObject({ GITHUB_TOKEN: 'ghp_secret' });
    expect(resolve).toHaveBeenCalledWith({ GITHUB_TOKEN: 'op://Vertex SRE/github_token/credential' }, { refresh: true });
  });

  it('keeps spawns going when the store is broken, and says so once', async () => {
    fs.writeFileSync(path.join(root, 'environment.json'), 'broken');
    const runtime = createRuntime();
    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toBeNull();
    expect(await runtime.forDirectory(projectPath, USER_ACTION)).toBeNull();
    expect(runtime.forOpenCode()).toEqual({});
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('lays the variables over an environment', async () => {
    await store.updateUser({ variables: { PATH: '/tools/bin', A: '1' } });
    const runtime = createRuntime();
    expect(await runtime.applyToDirectory(projectPath, { PATH: '/usr/bin', B: '2' }))
      .toEqual({ PATH: `/tools/bin${path.delimiter}/usr/bin`, A: '1', B: '2' });
  });
});
