import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvironmentRuntime } from './runtime.js';
import { createEnvironmentStore } from './store.js';

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

    expect(await runtime.forDirectory(path.join(projectPath, 'src'))).toEqual({
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
    expect(await runtime.forDirectory(projectPath)).toBeNull();
  });

  it('applies a project to its linked worktree and runs the command in the worktree', async () => {
    await store.updateProject('path_project', { variables: { B: '2' }, command: 'devenv print-dev-env --json' });
    const worktree = path.join(root, 'worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });
    const gitDir = path.join(projectPath, '.git', 'worktrees', 'feature');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    const spawn = vi.fn(() => fakeChild({ stdout: 'export FROM_COMMAND=1' }));
    const runtime = createRuntime({ spawn });

    expect(await runtime.forDirectory(worktree)).toEqual({ B: '2', FROM_COMMAND: '1' });
    expect(spawn.mock.calls[0][1].cwd).toBe(worktree);
  });

  it('reports a failing command, applies nothing from it and logs no output', async () => {
    await store.updateProject('path_project', { variables: { B: '2' }, command: 'direnv export json' });
    const spawn = vi.fn(() => fakeChild({ stdout: 'SECRET=leaked', code: 1 }));
    const runtime = createRuntime({ spawn });

    expect(await runtime.forDirectory(projectPath)).toEqual({ B: '2' });
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'failed', reason: 'exit', exitCode: 1 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('leaked');
  });

  it('reports output it cannot read', async () => {
    await store.updateProject('path_project', { command: 'echo hello' });
    const runtime = createRuntime({ spawn: vi.fn(() => fakeChild({ stdout: 'hello' })) });
    expect(await runtime.forDirectory(projectPath)).toBeNull();
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'failed', reason: 'unrecognized-output' });
  });

  it('kills a command that overruns its timeout', async () => {
    await store.updateProject('path_project', { command: 'sleep 100' });
    const child = fakeChild({ hang: true });
    const runtime = createRuntime({ spawn: vi.fn(() => child), commandTimeoutMs: 5 });
    expect(await runtime.forDirectory(projectPath)).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(runtime.projectStatus('path_project')).toMatchObject({ state: 'failed', reason: 'timeout' });
  });

  it('runs the command once, then serves the kept result and refreshes in the background', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    let output = '{"VERSION":"1"}';
    const spawn = vi.fn(() => fakeChild({ stdout: output }));
    const runtime = createRuntime({ spawn, commandTtlMs: 100 });

    const [first, second] = await Promise.all([runtime.forDirectory(projectPath), runtime.forDirectory(projectPath)]);
    expect(first).toEqual({ VERSION: '1' });
    expect(second).toEqual({ VERSION: '1' });
    expect(spawn).toHaveBeenCalledTimes(1);

    output = '{"VERSION":"2"}';
    clock += 200;
    expect(await runtime.forDirectory(projectPath)).toEqual({ VERSION: '1' });
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => expect(await runtime.forDirectory(projectPath)).toEqual({ VERSION: '2' }));
  });

  it('runs the command again after the project settings change', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    const spawn = vi.fn(() => fakeChild({ stdout: '{"A":"1"}' }));
    const runtime = createRuntime({ spawn });
    await runtime.forDirectory(projectPath);
    runtime.invalidateProject('path_project');
    expect(runtime.projectStatus('path_project')).toBeNull();
    await runtime.forDirectory(projectPath);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('reloads a project on request and answers its status', async () => {
    await store.updateProject('path_project', { command: 'direnv export json' });
    const runtime = createRuntime();
    expect(await runtime.reloadProject('path_project', projectPath)).toMatchObject({ state: 'applied', count: 1 });
    await store.updateProject('path_project', { command: null });
    expect(await runtime.reloadProject('path_project', projectPath)).toBeNull();
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

  it('keeps spawns going when the store is broken, and says so once', async () => {
    fs.writeFileSync(path.join(root, 'environment.json'), 'broken');
    const runtime = createRuntime();
    expect(await runtime.forDirectory(projectPath)).toBeNull();
    expect(await runtime.forDirectory(projectPath)).toBeNull();
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
