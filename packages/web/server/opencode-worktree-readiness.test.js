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
    // Model OpenCode's instance cache: even a GET can permanently capture the
    // empty directory, and a later session inherits that project's identity.
    instance ??= bootstrap.phase === 'directory-created'
      ? { projectID: 'global', config: {} }
      : { projectID: 'project-3464', config: projectConfig };
    if (req.path === '/config') return res.json(instance.config);
    if (req.path === '/session' && req.method === 'POST') {
      return res.json({ projectID: instance.projectID, directory: req.query.directory, title: req.body.title });
    }
    res.json([]);
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
    expect(fixture.forwarded).toEqual(['/session']);
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
});
