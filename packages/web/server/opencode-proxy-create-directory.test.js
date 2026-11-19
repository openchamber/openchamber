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

const createFixture = async () => {
  const received = [];
  const upstream = express();
  upstream.use(express.json());
  upstream.use((req, res) => {
    received.push({ path: req.path, body: req.body });
    res.json({ data: { id: 'ses_created' }, cursor: {} });
  });

  const upstreamUrl = await listen(upstream);
  const app = express();
  app.use(express.json());
  registerOpenCodeProxy(app, {
    fs: { promises: { realpath: async (value) => (value === '/link/project' ? '/real/project' : value) } },
    os: {},
    path,
    chatsRoot: '/link/chats',
    OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({ openCodePort: new URL(upstreamUrl).port, isOpenCodeReady: true }),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (requestPath) => `${upstreamUrl}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
    readWorktreeBootstrapStatus: async () => ({ status: 'ready', phase: 'setup-ready' }),
  });

  return { url: await listen(app), received };
};

const create = (url, directory) => fetch(`${url}/api/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'New session', location: { directory } }),
});

describe('session create at a symlinked spelling', () => {
  it('hands OpenCode the resolved directory', async () => {
    const fixture = await createFixture();

    const response = await create(fixture.url, '/link/project');
    expect(response.status).toBe(200);

    expect(fixture.received).toHaveLength(1);
    expect(fixture.received[0].body.location.directory).toBe('/real/project');
  });

  it('leaves a chats directory addressed by its configured spelling', async () => {
    const fixture = await createFixture();

    const response = await create(fixture.url, '/link/chats/2026-11-19/session-a');
    expect(response.status).toBe(200);

    expect(fixture.received[0].body.location.directory).toBe('/link/chats/2026-11-19/session-a');
  });
});
