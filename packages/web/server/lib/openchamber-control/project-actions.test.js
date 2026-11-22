import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTerminalRuntime } from '../terminal/runtime.js';
import { createProjectActionsTool, fillOpenUrlTemplate } from './project-actions.js';

// A real terminal runtime over a stand-in PTY, so runs, dedupe and ownership
// are the runtime's own.
const createTerminals = () => {
  const processes = [];
  const spawning = { gate: null, calls: 0 };
  const routes = { get: new Map(), post: new Map(), delete: new Map() };
  const runtime = createTerminalRuntime({
    app: {
      post(route, handler) { routes.post.set(route, handler); },
      get(route, handler) { routes.get.set(route, handler); },
      delete(route, handler) { routes.delete.set(route, handler); },
    },
    server: new EventEmitter(),
    fs: { promises: { stat: async () => ({ isDirectory: () => true }) } },
    path,
    uiAuthController: null,
    buildAugmentedPath: () => process.env.PATH || '',
    searchPathFor: () => '/bin/sh',
    isExecutable: () => true,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {},
    shutdownProcesses: async () => {},
    terminalTerminationGraceMs: 10,
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
    loadPtyProvider: async () => ({
      backend: 'fake-pty',
      spawn: async (shell, args, options) => {
        spawning.calls += 1;
        await spawning.gate;
        const dataHandlers = new Set();
        const exitHandlers = new Set();
        const pty = {
          pid: 900 + processes.length,
          shell, args, options,
          write() {},
          resize() {},
          kill() { for (const handler of exitHandlers) handler({ exitCode: 0, signal: 15 }); },
          onData(handler) { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
          onExit(handler) { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
          emitData(data) { for (const handler of dataHandlers) handler(data); },
        };
        processes.push(pty);
        return pty;
      },
    }),
  });
  const userRun = async (cwd, actionId) => {
    const response = { status() { return this; }, json(body) { this.body = body; return this; } };
    await routes.post.get('/api/terminal/create')({ body: {
      sessionId: `user-${actionId}`, cwd, mode: 'command', command: 'bun run dev',
      purpose: { type: 'project-action', actionId, executionId: `user-${actionId}`, agentSessionId: 'ses_forged' },
    } }, response);
    return response.body;
  };
  return { runtime, processes, userRun, spawning };
};

const ACTIONS = [
  { id: 'dev', name: 'Dev server', command: 'bun run dev', icon: null, openUrl: 'http://localhost:5173', source: 'personal' },
  { id: 'docs', name: 'Docs', command: 'bun run docs', icon: null, runIn: 'parent', source: 'personal' },
  { id: 'win', name: 'Windows only', command: 'run.cmd', icon: null, platforms: ['windows'], source: 'personal' },
  { id: 'seed', name: 'Seed', command: 'bun run seed', icon: null, source: 'shared' },
  { id: 'site', name: 'Site', command: 'portless myapp bun run dev', icon: null, openUrl: 'https://{worktree}.myapp.localhost', source: 'personal' },
];

let terminals;
afterEach(async () => { await terminals?.runtime.shutdown(); terminals = null; });

const PROJECTS = [{ id: 'proj', path: '/repo' }];

const createTool = ({ settings = { agentActionsToolEnabled: true, projects: PROJECTS }, trusted = false } = {}) => {
  terminals = createTerminals();
  const tool = createProjectActionsTool({
    readSettings: async () => settings,
    getTerminalRuntime: () => terminals.runtime,
    projectPathFor: async (directory) => (directory.startsWith('/repo') ? '/repo' : directory),
    readProjectSetup: async () => ({ projectActions: ACTIONS, trust: { trusted } }),
    readCheckout: async (directory) => (directory === '/repo' ? { branch: 'main', linkedWorktree: false } : { branch: 'feature/auth', linkedWorktree: true }),
    platform: 'darwin',
  });
  const call = (action, input = {}, sessionId = 'ses_a', directory = '/repo/.worktrees/feature') => tool.execute(action, input, { directory, sessionId });
  return { tool, call };
};

describe('project actions tool', () => {
  it('lists the actions for this platform with the folder each runs in', async () => {
    const { call } = createTool();
    const listed = await call('actions.list');
    expect(listed.platform).toBe('macos');
    expect(listed.actions).toEqual([
      { id: 'dev', name: 'Dev server', command: 'bun run dev', directory: '/repo/.worktrees/feature', url: 'http://localhost:5173', needsTrust: false, run: null },
      { id: 'docs', name: 'Docs', command: 'bun run docs', directory: '/repo', needsTrust: false, run: null },
      { id: 'seed', name: 'Seed', command: 'bun run seed', directory: '/repo/.worktrees/feature', needsTrust: true, run: null },
      // The address the actions menu would open in this checkout, never its placeholders.
      { id: 'site', name: 'Site', command: 'portless myapp bun run dev', directory: '/repo/.worktrees/feature', url: 'https://auth.myapp.localhost', needsTrust: false, run: null },
    ]);
  });

  it('fills an address template the way the actions menu does', () => {
    expect(fillOpenUrlTemplate('https://{worktree}.myapp.localhost', { branch: 'main', linkedWorktree: false })).toBe('https://myapp.localhost');
    expect(fillOpenUrlTemplate('http://{branch}.localhost:3000/x', { branch: 'Fix/Login_Timeout', linkedWorktree: false })).toBe('http://fix-login-timeout.localhost:3000/x');
    expect(fillOpenUrlTemplate('https://{worktree}.app.localhost', { branch: `feature/${'a'.repeat(70)}`, linkedWorktree: true }))
      .toMatch(/^https:\/\/a{56}-[0-9a-f]{6}\.app\.localhost$/);
  });

  it('starts a run the user sees as the agent\'s, and a second run returns it without a copy', async () => {
    const { call } = createTool();
    const started = await call('actions.run', { name: 'Dev server' });
    expect(started).toMatchObject({ started: true, id: 'dev', directory: '/repo/.worktrees/feature', url: 'http://localhost:5173' });
    expect(terminals.runtime.listTerminals({ directory: '/repo/.worktrees/feature' })).toEqual([
      expect.objectContaining({ status: 'running', mode: 'command', purpose: expect.objectContaining({ type: 'project-action', actionId: 'dev', agentSessionId: 'ses_a' }) }),
    ]);

    expect(await call('actions.run', { name: 'dev' })).toMatchObject({ started: false, startedBy: 'you' });
    expect(terminals.processes).toHaveLength(1);
  });

  it('leaves the user\'s own run alone: no second copy, no stop', async () => {
    const { call } = createTool();
    const created = await terminals.userRun('/repo/.worktrees/feature', 'dev');
    // A client cannot claim a run for an agent.
    expect(created.purpose).not.toHaveProperty('agentSessionId');

    const answer = await call('actions.run', { name: 'dev' });
    expect(answer).toMatchObject({ started: false, startedBy: 'the user', url: 'http://localhost:5173' });
    expect(terminals.processes).toHaveLength(1);

    await expect(call('actions.stop', { name: 'dev' })).rejects.toMatchObject({ statusCode: 403 });
    expect(terminals.runtime.listTerminals()[0].status).toBe('running');

    terminals.processes[0].emitData('ready on http://localhost:5173\r\n');
    expect(await call('actions.logs', { name: 'dev' })).toMatchObject({ status: 'running', startedBy: 'the user', text: 'ready on http://localhost:5173\n' });
  });

  it('does not leave a run behind when its session ends while it starts', async () => {
    const { tool, call } = createTool();
    let release;
    terminals.spawning.gate = new Promise((resolve) => { release = resolve; });
    const pending = call('actions.run', { name: 'dev' });
    await vi.waitFor(() => expect(terminals.spawning.calls).toBe(1));

    await tool.stopSessionRuns('ses_a');
    release();
    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(terminals.runtime.listTerminals()).toEqual([]);
  });

  it('lets only the session that started a run stop it', async () => {
    const { call } = createTool();
    await call('actions.run', { name: 'docs' });
    expect(terminals.runtime.listTerminals({ directory: '/repo' })).toHaveLength(1);

    await expect(call('actions.stop', { name: 'docs' }, 'ses_b')).rejects.toMatchObject({ statusCode: 403 });
    expect(await call('actions.run', { name: 'docs' }, 'ses_b')).toMatchObject({ started: false, startedBy: 'another session' });

    expect(await call('actions.stop', { name: 'docs' })).toEqual({ stopped: true, id: 'docs' });
    expect(terminals.runtime.listTerminals({ directory: '/repo' })).toEqual([]);
  });

  it('stops a session\'s runs when the session ends, and nobody else\'s', async () => {
    const { tool, call } = createTool();
    await call('actions.run', { name: 'dev' });
    await call('actions.run', { name: 'docs' }, 'ses_b');
    await terminals.userRun('/repo/.worktrees/other', 'dev');

    expect(await tool.stopSessionRuns('ses_a')).toBe(1);
    expect(terminals.runtime.listTerminals().map((run) => run.purpose.agentSessionId ?? 'user').sort()).toEqual(['ses_b', 'user']);
  });

  it('refuses what it must not run', async () => {
    const { call } = createTool();
    await expect(call('actions.run', { name: 'seed' })).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('not trusted') });
    await expect(call('actions.run', { name: 'win' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(call('actions.list', {}, 'ses_a', '/spaces/0123456789ab/project')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('isolated space') });
    await expect(call('actions.list', {}, 'ses_a', '/elsewhere')).rejects.toMatchObject({ statusCode: 404 });
    await expect(call('actions.logs', { name: 'dev' })).rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining('actions.run starts it') });
    expect(terminals.processes).toHaveLength(0);
  });

  it('runs a shared action once the user trusted the setup', async () => {
    const { call } = createTool({ trusted: true });
    expect(await call('actions.run', { name: 'seed' })).toMatchObject({ started: true });
  });

  it('is off until the setting is on, and says so in the guidance check too', async () => {
    const off = createTool({ settings: { projects: PROJECTS } });
    await expect(off.call('actions.list')).rejects.toMatchObject({ statusCode: 403 });
    expect(await off.tool.hasActions('/repo')).toBe(false);
    await terminals.runtime.shutdown();

    const on = createTool();
    expect(await on.tool.hasActions('/repo')).toBe(true);
    expect(await on.tool.hasActions('/elsewhere')).toBe(false);
    expect(await on.tool.hasActions('/spaces/0123456789ab/project')).toBe(false);
  });

  it('keeps an agent run alive past the idle sweep that ends an unattended terminal', async () => {
    vi.useFakeTimers();
    try {
      const { call } = createTool();
      await call('actions.run', { name: 'dev' });
      await terminals.userRun('/repo/.worktrees/feature', 'docs');
      await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
      expect(terminals.runtime.listTerminals().map((run) => run.purpose.actionId)).toEqual(['dev']);
    } finally {
      vi.useRealTimers();
    }
  });
});
