import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import path from 'node:path';
import { registerOpenCodeProxy } from './lib/opencode/proxy.js';

const servers = [];
const listen = async (app) => {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

const worktree = '/repo/worktree with spaces';
const projectConfig = { mcp: { projectOnly: { type: 'local', command: ['test-mcp'], enabled: false } } };

async function createFixture({ timeoutMs = 1000 } = {}) {
  let bootstrap = { status: 'pending', phase: 'directory-created', error: null };
  let instance;
  const forwarded = [];
  const probed = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.use((req, res) => {
    forwarded.push(req.path);
    if (req.path === '/api/session/ses_1' && req.method === 'GET') {
      return res.json({ data: { id: 'ses_1', location: { directory: worktree } } });
    }
    // Model OpenCode's instance cache: even a GET can permanently capture the
    // empty directory, and a later session inherits that project's identity.
    instance ??= bootstrap.phase === 'directory-created'
      ? { projectID: 'global', config: {} }
      : { projectID: 'project-3464', config: projectConfig };
    if (req.path === '/api/config') return res.json(instance.config);
    if (req.path === '/api/session' && req.method === 'POST') {
      return res.json({ projectID: instance.projectID, directory: req.query.directory, title: req.body.title });
    }
    // v2 pages the session list as `{ data, cursor }`.
    res.json({ data: [], cursor: {} });
  });
  const upstreamUrl = await listen(upstream);
  const app = express();
  app.use(express.json());
  registerOpenCodeProxy(app, {
    fs: {}, os: {}, path,
    OPEN_CODE_READY_GRACE_MS: 0,
    WORKTREE_READY_TIMEOUT_MS: timeoutMs,
    getRuntime: () => ({ openCodePort: new URL(upstreamUrl).port, isOpenCodeReady: true }),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (requestPath) => `${upstreamUrl}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
    readWorktreeBootstrapStatus: async (directory) => {
      probed.push(directory);
      return directory === worktree ? bootstrap : { status: 'ready', phase: 'setup-ready' };
    },
  });
  return {
    url: await listen(app), forwarded, probed,
    setBootstrap: (next) => { bootstrap = next; },
  };
}

describe('issue #3464 worktree OpenCode initialization', () => {
  it('holds config and session creation until Git is ready, while setup remains pending', async () => {
    const fixture = await createFixture();
    const config = fetch(`${fixture.url}/api/config?directory=${encodeURIComponent(worktree)}`);
    const session = fetch(`${fixture.url}/api/session?directory=${encodeURIComponent(worktree)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'First worktree session' }),
    });
    await expect.poll(() => fixture.probed.length).toBeGreaterThanOrEqual(2);
    expect(fixture.forwarded).toEqual([]);
    fixture.setBootstrap({ status: 'pending', phase: 'git-ready', error: null });
    expect(await (await config).json()).toEqual(projectConfig);
    expect(await (await session).json()).toEqual({
      projectID: 'project-3464', directory: worktree, title: 'First worktree session',
    });
  });

  it('gates encoded directory headers and the separately forwarded session list', async () => {
    const fixture = await createFixture();
    const response = fetch(`${fixture.url}/api/session`, { headers: {
      'x-opencode-directory': encodeURIComponent(worktree), 'x-opencode-directory-encoding': 'uri',
    } });
    await expect.poll(() => fixture.probed.length).toBeGreaterThan(0);
    expect(fixture.probed[0]).toBe(worktree);
    expect(fixture.forwarded).toEqual([]);
    fixture.setBootstrap({ status: 'ready', phase: 'setup-ready', error: null });
    expect((await response).status).toBe(200);
    expect(fixture.forwarded).toEqual(['/api/session']);
  });

  it('does not block unrelated directories while a worktree is pending', async () => {
    const fixture = await createFixture();
    expect((await fetch(`${fixture.url}/api/session?directory=/other-project`)).status).toBe(200);
    expect(fixture.probed).toEqual(['/other-project']);
  });

  it('does not forward an abandoned request when checkout later finishes', async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const response = fetch(`${fixture.url}/api/config?directory=${encodeURIComponent(worktree)}`, {
      signal: controller.signal,
    });
    const rejected = expect(response).rejects.toThrow();
    await expect.poll(() => fixture.probed.length).toBeGreaterThan(0);
    controller.abort();
    await rejected;
    // Allow the server to observe the closed client before releasing checkout.
    await new Promise((resolve) => setTimeout(resolve, 100));
    fixture.setBootstrap({ status: 'ready', phase: 'setup-ready', error: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.forwarded).toEqual([]);
  });

  it('fails closed on bootstrap failure or timeout without initializing OpenCode', async () => {
    const fixture = await createFixture({ timeoutMs: 0 });
    const timedOut = await fetch(`${fixture.url}/api/config?directory=${encodeURIComponent(worktree)}`);
    expect(timedOut.status).toBe(503);
    fixture.setBootstrap({ status: 'failed', phase: 'directory-created', error: 'checkout failed' });
    const failed = await fetch(`${fixture.url}/api/session?directory=${encodeURIComponent(worktree)}`, { method: 'POST' });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'checkout failed' });
    expect(fixture.forwarded).toEqual([]);
  });

  it('keeps a failed checkout closed to OpenCode but lists its sessions (#5811)', async () => {
    const fixture = await createFixture();
    fixture.setBootstrap({ status: 'failed', phase: 'directory-created', error: 'checkout failed' });
    const headers = { 'x-opencode-directory': encodeURIComponent(worktree), 'x-opencode-directory-encoding': 'uri' };

    const sessions = await fetch(`${fixture.url}/api/session?limit=50`, { headers });
    const config = await fetch(`${fixture.url}/api/config`, { headers });
    const created = await fetch(`${fixture.url}/api/session`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'After a failed checkout' }),
    });

    // OpenCode starts both folders of a move.
    const moved = await fetch(`${fixture.url}/api/session/ses_1/move`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ directory: '/repo' }),
    });

    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toEqual({ data: [], cursor: {} });
    expect(config.status).toBe(503);
    expect(created.status).toBe(503);
    expect(moved.status).toBe(503);
    // The move gate reads the session's current folder through a global read.
    expect(fixture.forwarded).toEqual(['/api/session', '/api/session/ses_1']);
  });
});

describe('worktree checkout gate for session moves', () => {
  const failedWorktree = '/repo/broken-worktree';
  const healthy = '/repo/healthy';

  async function createMoveFixture() {
    const sessions = { ses_healthy: healthy, ses_broken: failedWorktree };
    const forwarded = [];
    const upstream = express();
    upstream.use(express.json());
    upstream.get('/api/session/:id', (req, res) => {
      const directory = sessions[req.params.id];
      if (!directory) return res.status(404).json({ error: 'not found' });
      return res.json({ data: { id: req.params.id, location: { directory } } });
    });
    upstream.use((req, res) => {
      forwarded.push({ path: req.path, body: req.body });
      res.status(204).end();
    });
    const upstreamUrl = await listen(upstream);
    const app = express();
    // As in the server: OpenCode routes reach the proxy with their body unread.
    registerOpenCodeProxy(app, {
      fs: {}, os: {}, path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: new URL(upstreamUrl).port, isOpenCodeReady: true }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `${upstreamUrl}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      readWorktreeBootstrapStatus: async (directory) => (directory.startsWith(failedWorktree)
        ? { status: 'failed', phase: 'git-ready', error: 'checkout failed' }
        : { status: 'ready', phase: 'setup-ready' }),
    });
    const url = await listen(app);
    const move = (sessionID, body) => fetch(`${url}/api/session/${sessionID}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { move, forwarded };
  }

  it('refuses a move into a worktree whose checkout failed, however the destination is written', async () => {
    const fixture = await createMoveFixture();
    const absolute = await fixture.move('ses_healthy', { directory: failedWorktree });
    expect(absolute.status).toBe(503);
    expect(await absolute.json()).toEqual({ error: 'checkout failed' });
    // Relative to the session's folder, the way OpenCode resolves it.
    expect((await fixture.move('ses_healthy', { directory: '../broken-worktree/src' })).status).toBe(503);
    expect(fixture.forwarded).toEqual([]);
  });

  it('refuses a move out of a worktree whose checkout failed', async () => {
    const fixture = await createMoveFixture();
    expect((await fixture.move('ses_broken', { directory: healthy })).status).toBe(503);
    expect(fixture.forwarded).toEqual([]);
  });

  it('forwards a move between ready folders with its body intact', async () => {
    const fixture = await createMoveFixture();
    const moved = await fixture.move('ses_healthy', { directory: `${healthy}/sub`, delivery: 'queue' });
    expect(moved.status).toBe(204);
    expect(fixture.forwarded).toEqual([
      { path: '/api/session/ses_healthy/move', body: { directory: `${healthy}/sub`, delivery: 'queue' } },
    ]);
  });
});
