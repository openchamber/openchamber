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

const worktree = '/repo/worktrees/removal hold';

async function createFixture({ holdMs = 5000 } = {}) {
  let settle;
  const removal = new Promise((resolve) => { settle = resolve; });
  const forwarded = [];
  const asked = [];
  const upstream = express();
  upstream.use((req, res) => {
    forwarded.push(`${req.method} ${req.path}`);
    res.json({ data: [], cursor: {} });
  });
  const upstreamUrl = await listen(upstream);
  const app = express();
  app.use(express.json());
  registerOpenCodeProxy(app, {
    fs: {}, os: {}, path,
    OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({ openCodePort: new URL(upstreamUrl).port, isOpenCodeReady: true }),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (requestPath) => `${upstreamUrl}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
    readWorktreeBootstrapStatus: async () => ({ status: 'ready', phase: 'setup-ready' }),
    waitForWorktreeRemovalToSettle: async (directory) => {
      asked.push(directory);
      if (directory.startsWith(worktree)) await removal;
    },
    WORKTREE_REMOVAL_HOLD_MS: holdMs,
  });
  return { url: await listen(app), forwarded, asked, settle };
}

describe('issue #4111 requests for a worktree being removed', () => {
  it('holds a request whose percent-encoded header names the worktree until the removal settles', async () => {
    const fixture = await createFixture();
    // The UI sends the header encoded without the marker; OpenCode decodes it.
    const response = fetch(`${fixture.url}/api/mcp`, {
      headers: { 'x-opencode-directory': encodeURIComponent(`${worktree}/sub`) },
    });
    await expect.poll(() => fixture.asked).toEqual([`${worktree}/sub`]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.forwarded).toEqual([]);

    fixture.settle();
    expect((await response).status).toBe(200);
    expect(fixture.forwarded).toEqual(['GET /api/mcp']);
  });

  it('holds a request that names the worktree in its location query', async () => {
    const fixture = await createFixture();
    const response = fetch(`${fixture.url}/api/config?location%5Bdirectory%5D=${encodeURIComponent(worktree)}`);
    await expect.poll(() => fixture.asked).toEqual([worktree]);
    expect(fixture.forwarded).toEqual([]);

    fixture.settle();
    expect((await response).status).toBe(200);
    expect(fixture.forwarded).toEqual(['GET /api/config']);
  });

  it('forwards requests for other folders, and requests naming none, at once', async () => {
    const fixture = await createFixture();
    const other = await fetch(`${fixture.url}/api/mcp`, { headers: { 'x-opencode-directory': '/repo' } });
    const global = await fetch(`${fixture.url}/api/session`);
    expect([other.status, global.status]).toEqual([200, 200]);
    expect(fixture.forwarded).toEqual(['GET /api/mcp', 'GET /api/session']);
  });

  it('forwards a held request after the hold limit even when the removal has not settled', async () => {
    const fixture = await createFixture({ holdMs: 100 });
    const response = await fetch(`${fixture.url}/api/mcp`, { headers: { 'x-opencode-directory': worktree } });
    expect(response.status).toBe(200);
    expect(fixture.forwarded).toEqual(['GET /api/mcp']);
  });
});
