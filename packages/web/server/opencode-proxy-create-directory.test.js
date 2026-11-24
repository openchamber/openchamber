import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { registerOpenCodeProxy } from './lib/opencode/proxy.js';
import { createSessionDirectoryCanonicalizer } from './lib/opencode/directory-canonicalization.js';

const servers = [];
const roots = [];

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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const aliasRealpath = async (value) => (value === '/link/project' ? '/real/project' : value);

// Like the real server, nothing parses /api/session before the proxy: the proxy reads the body itself.
const createFixture = async ({ sessionDirectory = '/real/worktree', sharesFilesystem = true, realpath: resolve = aliasRealpath } = {}) => {
  const received = [];
  const upstream = express();
  upstream.use(express.text({ type: '*/*' }));
  upstream.use((req, res) => {
    received.push({ path: req.path, contentType: req.headers['content-type'], raw: typeof req.body === 'string' ? req.body : '' });
    if (req.method === 'GET' && /^\/api\/session\/[^/]+$/.test(req.path)) {
      res.json({ data: { location: { directory: sessionDirectory } } });
      return;
    }
    res.json({ data: { id: 'ses_created' }, cursor: {} });
  });

  const upstreamUrl = await listen(upstream);
  const app = express();
  registerOpenCodeProxy(app, {
    fs: { promises: { realpath: resolve } },
    os: {},
    path,
    chatsRoot: '/link/chats',
    getSessionDirectoryCanonicalizer: createSessionDirectoryCanonicalizer({ sharesFilesystem: () => sharesFilesystem, realpath: resolve }),
    OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({ openCodePort: new URL(upstreamUrl).port, isOpenCodeReady: true }),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (requestPath) => `${upstreamUrl}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
    readWorktreeBootstrapStatus: async () => ({ status: 'ready', phase: 'setup-ready' }),
  });

  const forwardedBody = (index = -1) => JSON.parse(received.at(index).raw);
  return { url: await listen(app), received, forwardedBody };
};

const post = (url, route, body, contentType = 'application/json') => fetch(`${url}${route}`, {
  method: 'POST',
  headers: { 'content-type': contentType },
  body,
});

const create = (url, directory) => post(url, '/api/session', JSON.stringify({ title: 'New session', location: { directory } }));
const move = (url, directory) => post(url, '/api/session/ses_move/move', JSON.stringify({ directory }));

describe('session create at a symlinked spelling', () => {
  it('hands OpenCode the resolved directory', async () => {
    const fixture = await createFixture();

    const response = await create(fixture.url, '/link/project');
    expect(response.status).toBe(200);

    expect(fixture.received).toHaveLength(1);
    expect(fixture.forwardedBody().location.directory).toBe('/real/project');
  });

  it('leaves a chats directory addressed by its configured spelling', async () => {
    const fixture = await createFixture();

    const response = await create(fixture.url, '/link/chats/2026-11-19/session-a');
    expect(response.status).toBe(200);

    expect(fixture.forwardedBody().location.directory).toBe('/link/chats/2026-11-19/session-a');
  });

  it('sends the directory unchanged to an OpenCode on another filesystem', async () => {
    const fixture = await createFixture({ sharesFilesystem: false });
    const body = JSON.stringify({ title: 'New session', location: { directory: '/link/project' } });

    const response = await post(fixture.url, '/api/session', body);
    expect(response.status).toBe(200);

    expect(fixture.received.at(-1).raw).toBe(body);
  });

  it('resolves the exact name when two directories differ only by trailing whitespace', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'proxy-create-')));
    roots.push(root);
    const linked = path.join(root, 'linked-target');
    const spaced = path.join(root, 'project ');
    await mkdir(linked);
    await mkdir(spaced);
    await symlink(linked, path.join(root, 'project'), process.platform === 'win32' ? 'junction' : undefined);
    const fixture = await createFixture({ realpath: (value) => realpath(value) });

    expect((await create(fixture.url, spaced)).status).toBe(200);
    expect((await create(fixture.url, path.join(root, 'project'))).status).toBe(200);

    expect(fixture.forwardedBody(0).location.directory).toBe(spaced);
    expect(fixture.forwardedBody(1).location.directory).toBe(linked);
  });

  it('forwards a body it does not parse as it arrived', async () => {
    const fixture = await createFixture();
    const body = 'location.directory=/link/project';

    const response = await post(fixture.url, '/api/session', body, 'text/plain');
    expect(response.status).toBe(200);

    expect(fixture.received.at(-1)).toMatchObject({ contentType: 'text/plain', raw: body });
  });

  it('replays a chunked empty JSON object it read', async () => {
    const fixture = await createFixture();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
    });

    const response = await fetch(`${fixture.url}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' });
    expect(response.status).toBe(200);

    expect(fixture.received.at(-1).raw).toBe('{}');
  });

  it('forwards a gzipped body it read as plain JSON without the gzip label', async () => {
    const fixture = await createFixture();

    const response = await fetch(`${fixture.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify({ location: { directory: '/link/project' } })),
    });
    expect(response.status).toBe(200);

    expect(fixture.forwardedBody().location.directory).toBe('/real/project');
  });

  it('answers invalid JSON itself and forwards nothing', async () => {
    const fixture = await createFixture();

    const response = await post(fixture.url, '/api/session', '{"location":');
    expect(response.status).toBe(400);
    expect(fixture.received).toHaveLength(0);
  });

  it('answers an oversized body itself and forwards nothing', async () => {
    const fixture = await createFixture();
    const body = JSON.stringify({ title: 'x'.repeat(70 * 1024), location: { directory: '/link/project' } });

    const response = await post(fixture.url, '/api/session', body);
    expect(response.status).toBe(413);
    expect(fixture.received).toHaveLength(0);
  });
});

describe('session move to a symlinked spelling', () => {
  it('hands OpenCode the resolved destination directory', async () => {
    const fixture = await createFixture();

    const response = await move(fixture.url, '/link/project');
    expect(response.status).toBe(200);

    const forwarded = fixture.received.at(-1);
    expect(forwarded.path).toBe('/api/session/ses_move/move');
    expect(fixture.forwardedBody().directory).toBe('/real/project');
  });

  it('sends the destination unchanged to an OpenCode on another filesystem', async () => {
    const fixture = await createFixture({ sharesFilesystem: false });

    const response = await move(fixture.url, '/link/project');
    expect(response.status).toBe(200);

    expect(fixture.forwardedBody().directory).toBe('/link/project');
  });
});
