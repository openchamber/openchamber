import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTerminalRuntime } from '../terminal/runtime.js';
import { createProjectActionsTool, fillOpenUrlTemplate } from './project-actions.js';
import http from 'node:http';
import { extractRunUrl, probeUrl } from './action-readiness.js';

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
          exit(exitCode) { for (const handler of exitHandlers) handler({ exitCode, signal: 0 }); },
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

// Every address answers 200 unless a test scripts its answers.
const createTool = ({ settings = { agentActionsToolEnabled: true, projects: PROJECTS }, trusted = false, probeUrl = async () => 200 } = {}) => {
  terminals = createTerminals();
  const tool = createProjectActionsTool({
    readSettings: async () => settings,
    getTerminalRuntime: () => terminals.runtime,
    projectPathFor: async (directory) => (directory.startsWith('/repo') ? '/repo' : directory),
    readProjectSetup: async () => ({ projectActions: ACTIONS, trust: { trusted } }),
    readCheckout: async (directory) => (directory === '/repo' ? { branch: 'main', linkedWorktree: false } : { branch: 'feature/auth', linkedWorktree: true }),
    platform: 'darwin',
    probeUrl,
    readyWait: { limitMs: 200, pollMs: 5 },
  });
  const call = (action, input = {}, sessionId = 'ses_a', directory = '/repo/.worktrees/feature', signal) => tool.execute(action, input, { directory, sessionId, signal });
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

  it('answers once the app behind the address is up, through the 404 of a proxy that is up first', async () => {
    const answers = [null, 404, 502, 200];
    const probed = [];
    const { call } = createTool({ probeUrl: async (url) => { probed.push(url); return answers.shift(); } });
    expect(await call('actions.run', { name: 'site' })).toMatchObject({ started: true, ready: true, url: 'https://auth.myapp.localhost', note: expect.stringContaining('answered HTTP 200') });
    expect(probed).toEqual(Array(4).fill('https://auth.myapp.localhost'));
  });

  it('waits on the address the run prints when the action names none', async () => {
    const { call } = createTool();
    const pending = call('actions.run', { name: 'docs' });
    await vi.waitFor(() => expect(terminals.processes).toHaveLength(1));
    terminals.processes[0].emitData('  ➜  Local:   http://localhost:4321/\r\n');
    expect(await pending).toMatchObject({ ready: true, url: 'http://localhost:4321/' });
  });

  it('says why it is not ready: the run failed, or the app still is not up', async () => {
    const { call } = createTool({ probeUrl: async () => 404 });
    const failing = call('actions.run', { name: 'dev' });
    await vi.waitFor(() => expect(terminals.processes).toHaveLength(1));
    terminals.processes[0].emitData('Error: port 5173 is taken\r\n');
    terminals.processes[0].exit(1);
    expect(await failing).toMatchObject({ ready: false, exitCode: 1, output: expect.stringContaining('port 5173 is taken'), note: expect.stringContaining('exit code 1') });
    expect((await failing).note).not.toContain('runs in the background');

    expect(await call('actions.run', { name: 'site' })).toMatchObject({ ready: false, note: expect.stringMatching(/Still starting .* still answers HTTP 404\. .*actions\.run again/) });
  });

  it('waits for a command without an address to finish, and not for a run someone else started', async () => {
    const { call } = createTool();
    const pending = call('actions.run', { name: 'docs' });
    await vi.waitFor(() => expect(terminals.processes).toHaveLength(1));
    terminals.processes[0].exit(0);
    expect(await pending).toMatchObject({ ready: false, exitCode: 0, note: expect.stringContaining('finished with exit code 0') });

    await terminals.userRun('/repo', 'docs');
    expect(await call('actions.run', { name: 'docs' })).toMatchObject({ started: false, startedBy: 'the user', note: expect.stringContaining('cannot tell whether it is ready') });
  });

  it('keeps waiting on its own run when called again', async () => {
    const { call } = createTool();
    expect(await call('actions.run', { name: 'docs' })).toMatchObject({ ready: false, note: expect.stringContaining('Still running') });
    expect(await call('actions.run', { name: 'docs' })).toMatchObject({ started: false, startedBy: 'you', note: expect.stringContaining('Still running') });
  });

  it('probes a saved address typed without its scheme, as the actions menu opens it', async () => {
    const probed = [];
    const { call } = createTool({ probeUrl: async (url) => { probed.push(url); return 200; } });
    ACTIONS.push({ id: 'bare', name: 'Bare', command: 'bun run dev', icon: null, openUrl: 'localhost:5173', source: 'personal' });
    try {
      expect(await call('actions.run', { name: 'bare' })).toMatchObject({ ready: true });
      expect(probed).toEqual(['http://localhost:5173']);
    } finally {
      ACTIONS.pop();
    }
  });

  it('stops waiting when the turn is stopped and leaves the run going', async () => {
    const { call } = createTool({ probeUrl: async () => null });
    const controller = new AbortController();
    const pending = call('actions.run', { name: 'dev' }, 'ses_a', '/repo/.worktrees/feature', controller.signal);
    await vi.waitFor(() => expect(terminals.processes).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ statusCode: 499 });
    expect(terminals.runtime.listTerminals()[0].status).toBe('running');
  });

  it('judges the page a same-origin redirect lands on', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/' ? 302 : 404, req.url === '/' ? { location: '/app' } : {});
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      expect(await probeUrl(`http://127.0.0.1:${server.address().port}/`, undefined)).toBe(404);
    } finally {
      server.close();
    }
  });

  it('accepts a self-signed certificate on a loopback address, as the desktop browser does', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const https = await import('node:https');
    const dir = mkdtempSync(path.join(tmpdir(), 'probe-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const server = https.createServer({ key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) }, (_req, res) => { res.writeHead(200); res.end(); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      expect(await probeUrl(`https://127.0.0.1:${server.address().port}/`, undefined)).toBe(200);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the app address portless prints, past the port it proxies', () => {
    expect(extractRunUrl('-- Using port 4123\nVITE ready\n  ➜  Local:   http://localhost:4123/\n  -> http://athena.localhost:1355\n')).toBe('http://athena.localhost:1355');
  });
});
