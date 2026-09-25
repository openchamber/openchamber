// The dispatcher against a stand-in for the server inside a space: an Express app with the real
// UI auth of the host, so the login, the cookie and the refusal of a bad token are the real ones.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import {
  classifySpacePath,
  createSpaceDispatcher,
  isDirectoryOfSpace,
  isSpaceDirectory,
  isSpaceRequestPath,
  parseSpaceRoute,
} from './dispatcher.js';

// The UI auth keeps its signing secret in the data directory, and reads that path when it loads.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-dispatcher-test-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;

const ID = 'a1b2c3d4e5f6';
const OTHER = '0f0f0f0f0f0f';
const TOKEN = 'tok_' + 'a'.repeat(40);

const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

/** The stand-in for the server inside: the host's own UI auth in front of a few routes that tell what they saw. */
const startInside = async ({ password = TOKEN } = {}) => {
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  const auth = createUiAuth({ password, readSettingsFromDiskMigrated: async () => ({}) });
  const seen = [];
  const state = { logins: 0, refuseNext: 0, sseClosed: 0, sseRequests: [] };
  const app = express();
  app.post('/auth/session', express.json(), (req, res) => {
    state.logins += 1;
    return auth.handleSessionCreate(req, res);
  });
  app.use('/api', (req, res, next) => {
    if (state.refuseNext > 0) {
      state.refuseNext -= 1;
      res.status(401).json({ error: 'UI authentication required', locked: true });
      return;
    }
    next();
  });
  app.use('/api', auth.requireAuth);
  app.use('/api', (req, _res, next) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    next();
  });
  app.all('/api/echo', (req, res) => {
    let bytes = 0;
    req.on('data', (chunk) => { bytes += chunk.length; });
    req.on('end', () => res.json({ method: req.method, url: req.url, bytes, contentType: req.headers['content-type'] ?? null }));
  });
  app.post('/api/form', (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => res.json({ raw: Buffer.concat(chunks).toString('utf8') }));
  });
  app.get('/api/event', (req, res) => {
    state.sseRequests.push(req);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'private, max-age=0');
    res.flushHeaders();
    res.write('data: first\n\n');
    req.on('close', () => { state.sseClosed += 1; });
  });
  app.get('/api/big-event', (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    for (let index = 0; index < 4096; index += 1) res.write(`data: ${'x'.repeat(1000)}\n\n`);
    res.end();
  });
  app.get('/api/fs/raw', (req, res) => {
    res.setHeader('content-type', String(req.query.type));
    res.end('file');
  });
  app.get('/api/page', (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send('<script>alert(1)</script>');
  });
  app.get('/api/cookie', (_req, res) => {
    res.setHeader('set-cookie', 'planted=1; Path=/');
    res.json({ ok: true });
  });
  app.get('/api/session/:id', (req, res) => res.json({ id: req.params.id }));
  app.all('/api/redirect', (_req, res) => {
    res.setHeader('location', '/api/session/host-session');
    res.setHeader('clear-site-data', '"*"');
    res.status(307).end();
  });
  app.get('/api/wipe', (_req, res) => {
    res.setHeader('clear-site-data', '"*"');
    res.setHeader('refresh', '0; url=/api/session');
    res.setHeader('x-next-cursor', 'abc');
    res.json({ ok: true });
  });
  app.get('/api/untyped', (_req, res) => {
    res.removeHeader('content-type');
    res.end('<script>alert(1)</script>');
  });
  app.all('/api/Config/settings', (_req, res) => res.json({ reached: 'inside' }));
  const server = await listen(app);
  return { server, port: server.address().port, seen, state, stop: () => close(server) };
};

/** A transport over a plain socket to the stand-in, with the calls counted. */
const transportTo = (currentInside, { ids = [ID], token = TOKEN } = {}) => {
  const calls = { connect: 0, readToken: 0, list: 0 };
  return {
    calls,
    ids,
    listSpaceIds: async () => { calls.list += 1; return ids; },
    connect: async (spaceId) => {
      calls.connect += 1;
      if (!ids.includes(spaceId)) throw new SpaceError('space_not_found', `Space ${spaceId} has no container`);
      return net.connect({ host: '127.0.0.1', port: currentInside().port });
    },
    readToken: async () => { calls.readToken += 1; return token; },
  };
};

/** The host: the dispatcher after a stand-in for the auth gate, and one host route that reads a directory. */
const startHost = async (dispatcher, { commonMiddleware = false } = {}) => {
  const app = express();
  if (commonMiddleware) {
    registerCommonRequestMiddleware(app, { express, skipBodyParsing: (req) => isSpaceRequestPath(req.path) });
  }
  app.use('/api', (req, _res, next) => { req.authenticatedByHost = true; next(); });
  app.use(dispatcher.middleware);
  app.all('/api/host', (req, res) => res.json({ host: true, directory: req.query.directory ?? null, body: req.body ?? null }));
  app.use((_req, res) => res.status(404).json({ error: 'not found on host' }));
  const server = await listen(app);
  return { server, port: server.address().port, url: (suffix) => `http://127.0.0.1:${server.address().port}${suffix}`, stop: () => close(server) };
};

const logs = [];
const logger = { warn: (line) => logs.push(line), error: (line) => logs.push(line) };

describe('space routes and directories', () => {
  it('parses the prefix and the space id, and nothing shorter', () => {
    expect(parseSpaceRoute(`/api/spaces/${ID}/session`)).toEqual({ spaceId: ID, path: '/api/session' });
    expect(parseSpaceRoute(`/api/spaces/${ID}/fs/raw`)).toEqual({ spaceId: ID, path: '/api/fs/raw' });
    expect(parseSpaceRoute(`/api/spaces/${ID}`)).toBeNull();
    expect(parseSpaceRoute(`/api/spaces/${ID}/`)).toEqual({ spaceId: ID, path: '/api/' });
    expect(parseSpaceRoute('/api/spaces//x')).toBeNull();
    expect(parseSpaceRoute('/api/session')).toBeNull();
    expect(isSpaceRequestPath(`/api/spaces/${ID}/x`)).toBe(true);
  });

  it('knows which directories belong to spaces, and to which space', () => {
    expect(isSpaceDirectory(`/spaces/${ID}/repo`)).toBe(true);
    expect(isSpaceDirectory('/spaces')).toBe(true);
    expect(isSpaceDirectory('/spaces/')).toBe(true);
    expect(isSpaceDirectory('//spaces//x')).toBe(true);
    expect(isSpaceDirectory('/home/me/spaces/x')).toBe(false);
    expect(isSpaceDirectory('/spacesx')).toBe(false);
    expect(isSpaceDirectory('')).toBe(false);
    expect(isDirectoryOfSpace(`/spaces/${ID}`, ID)).toBe(true);
    expect(isDirectoryOfSpace(`/spaces/${ID}/repo/src`, ID)).toBe(true);
    expect(isDirectoryOfSpace(`/spaces/${OTHER}/repo`, ID)).toBe(false);
    expect(isDirectoryOfSpace(`/spaces/${ID}/../${OTHER}`, ID)).toBe(false);
    expect(isDirectoryOfSpace(`/spaces/${ID}x`, ID)).toBe(false);
    expect(isDirectoryOfSpace('/home/me', ID)).toBe(false);
  });

  it('sorts the paths inside by rule', () => {
    expect(classifySpacePath('/api/config/settings')).toBe('host_only');
    expect(classifySpacePath('/api/provider')).toBe('host_only');
    expect(classifySpacePath('/api/projects/abc/icon')).toBe('host_only');
    expect(classifySpacePath('/api/fs/serve/index.html')).toBe('refused_across_boundary');
    expect(classifySpacePath('/api/preview/proxy/3000/')).toBe('refused_across_boundary');
    expect(classifySpacePath('/api/git/worktrees')).toBe('refused_across_boundary');
    expect(classifySpacePath('/api/git/integrate/merge')).toBe('refused_across_boundary');
    expect(classifySpacePath('/api/session/ses_1/move')).toBe('refused_across_boundary');
    // Express inside routes without regard to case.
    expect(classifySpacePath('/api/Config/Settings')).toBe('host_only');
    expect(classifySpacePath('/api/FS/serve/x')).toBe('refused_across_boundary');
    expect(classifySpacePath('/api/Session/ses_1/Move')).toBe('refused_across_boundary');
    expect(classifySpacePath('/api/session')).toBeNull();
    expect(classifySpacePath('/api/git/status')).toBeNull();
    expect(classifySpacePath('/api/fs/raw')).toBeNull();
    expect(classifySpacePath('/api/config/agents')).toBeNull();
  });
});

describe('space dispatcher', () => {
  let inside;
  let host;
  let dispatcher;
  let transport;

  const start = async (options = {}) => {
    inside = await startInside(options.inside);
    transport = transportTo(() => inside, options.transport);
    dispatcher = createSpaceDispatcher({ transport, logger, now: options.now });
    host = await startHost(dispatcher, options.host);
  };

  afterEach(async () => {
    dispatcher?.close();
    await host?.stop();
    await inside?.stop();
    inside = host = dispatcher = transport = undefined;
    logs.length = 0;
  });

  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('forwards a prefixed request with the prefix and the user\'s credentials removed, and the space session added', async () => {
    await start();
    const response = await fetch(host.url(`/api/spaces/${ID}/echo?a=1&oc_url_token=secret-url&b=2&oc_client_token=secret-client`), {
      headers: { cookie: 'oc_ui_session_3000=user-cookie', authorization: 'Bearer user-bearer', 'x-custom': 'kept', origin: 'https://app.example' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ method: 'GET', url: '/api/echo?a=1&b=2', bytes: 0 });
    expect(inside.seen).toHaveLength(1);
    const [request] = inside.seen;
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.origin).toBeUndefined();
    expect(request.headers.cookie).toMatch(/^oc_ui_session_27600=[^;]+$/);
    expect(request.headers.cookie).not.toContain('user-cookie');
    expect(request.headers.host).toBe('127.0.0.1:27600');
    expect(request.headers['x-custom']).toBe('kept');
    expect(request.url).not.toContain('secret');
    expect(inside.state.logins).toBe(1);
    expect(transport.calls.readToken).toBe(1);
  });

  it('logs in once per space and reuses the session and the connection', async () => {
    await start();
    const answers = await Promise.all(Array.from({ length: 6 }, (_, index) => fetch(host.url(`/api/spaces/${ID}/echo?n=${index}`))));
    for (const answer of answers) expect(answer.status).toBe(200);
    await Promise.all(answers.map((answer) => answer.text()));
    const again = await fetch(host.url(`/api/spaces/${ID}/echo?n=again`));
    expect(again.status).toBe(200);
    await again.text();

    expect(inside.state.logins).toBe(1);
    expect(transport.calls.readToken).toBe(1);
    // Fewer connections than requests: the agent keeps them.
    expect(transport.calls.connect).toBeLessThan(8);
  });

  it('streams a request body into the space without buffering it', async () => {
    await start();
    const size = 3 * 1024 * 1024;
    const response = await fetch(host.url(`/api/spaces/${ID}/echo`), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(size, 7),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ method: 'POST', bytes: size, contentType: 'application/octet-stream' });
  });

  it('lets a form-encoded body reach the space untouched when the host parsers are told to leave it alone', async () => {
    await start({ host: { commonMiddleware: true } });
    const response = await fetch(host.url(`/api/spaces/${ID}/form`), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=two%20words',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ raw: 'a=1&b=two%20words' });
  });

  it('streams an event stream as it arrives, and closes the stream inside when the client leaves', async () => {
    await start();
    const controller = new AbortController();
    const response = await fetch(host.url(`/api/spaces/${ID}/event`), { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('data: first\n\n');
    // The stream inside is still open: the second event has not been sent yet.
    const [request] = inside.state.sseRequests;
    request.res.write('data: second\n\n');
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe('data: second\n\n');

    controller.abort();
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(inside.state.sseClosed).toBe(1);
  });

  it('carries a large event stream whole', async () => {
    await start();
    const response = await fetch(host.url(`/api/spaces/${ID}/big-event`));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.length).toBe(4096 * ('data: '.length + 1000 + 2));
    expect(text.endsWith('\n\n')).toBe(true);
  });

  // Guard one.
  it('refuses a prefixed request that names a directory outside the space', async () => {
    await start();
    for (const suffix of [
      '/echo?directory=/home/me/project',
      `/echo?directory=/spaces/${OTHER}/repo`,
      `/echo?directory=/spaces/${ID}/../${OTHER}/repo`,
      `/echo?location%5Bdirectory%5D=/home/me`,
      `/echo?directory=/spaces/${ID}/repo&directory=/home/me`,
    ]) {
      const response = await fetch(host.url(`/api/spaces/${ID}${suffix}`));
      expect(response.status, suffix).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'directory_outside_space' });
    }
    const byHeader = await fetch(host.url(`/api/spaces/${ID}/echo`), { headers: { 'x-opencode-directory': '/home/me' } });
    expect(byHeader.status).toBe(400);
    const encoded = await fetch(host.url(`/api/spaces/${ID}/echo`), { headers: { 'x-opencode-directory': encodeURIComponent('/home/me'), 'x-opencode-directory-encoding': 'uri' } });
    expect(encoded.status).toBe(400);
    expect(inside.seen).toHaveLength(0);

    const inside_ok = await fetch(host.url(`/api/spaces/${ID}/echo?directory=${encodeURIComponent(`/spaces/${ID}/repo`)}`), { headers: { 'x-opencode-directory': `/spaces/${ID}/repo/src` } });
    expect(inside_ok.status).toBe(200);
    expect(inside.seen).toHaveLength(1);
  });

  // Guard two.
  it('refuses an unprefixed request that names a space directory, before any host route runs', async () => {
    await start();
    for (const suffix of [`/api/host?directory=/spaces/${ID}/repo`, '/api/host?directory=/spaces', `/api/host?location%5Bdirectory%5D=/spaces/${ID}`]) {
      const response = await fetch(host.url(suffix), { method: 'POST' });
      expect(response.status, suffix).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'space_directory_needs_prefix' });
    }
    const byHeader = await fetch(host.url('/api/host'), { headers: { 'x-opencode-directory': `/spaces/${ID}/repo` } });
    expect(byHeader.status).toBe(400);

    const ordinary = await fetch(host.url('/api/host?directory=/home/me/spaces/project'));
    expect(ordinary.status).toBe(200);
    expect(await ordinary.json()).toMatchObject({ host: true, directory: '/home/me/spaces/project' });
    expect(inside.seen).toHaveLength(0);
  });

  it('refuses host-only routes and the routes that do not cross the boundary, without asking the space', async () => {
    await start();
    const cases = [
      ['/config/settings', 'host_only_route'],
      ['/provider', 'host_only_route'],
      ['/github/repos', 'host_only_route'],
      ['/projects/p1/icon', 'host_only_route'],
      ['/fs/serve/index.html', 'refused_across_boundary'],
      ['/preview/proxy/3000/', 'refused_across_boundary'],
      ['/git/worktrees', 'refused_across_boundary'],
      ['/git/integrate/merge', 'refused_across_boundary'],
      ['/session/ses_1/move', 'refused_across_boundary'],
      ['/Config/settings', 'host_only_route'],
      ['/Preview/proxy/3000/', 'refused_across_boundary'],
    ];
    for (const [suffix, code] of cases) {
      const response = await fetch(host.url(`/api/spaces/${ID}${suffix}`), { method: 'POST' });
      expect(response.status, suffix).toBe(403);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(inside.seen).toHaveLength(0);
    expect(transport.calls.connect).toBe(0);
    // Its neighbours are forwarded.
    expect((await fetch(host.url(`/api/spaces/${ID}/session/ses_1`))).status).toBe(200);
  });

  it('answers 404 for a space the runtime does not list, and finds one that appears', async () => {
    await start();
    for (const spaceId of [OTHER, 'not-an-id', 'A1B2C3D4E5F6']) {
      const response = await fetch(host.url(`/api/spaces/${spaceId}/echo`));
      expect(response.status, spaceId).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'space_not_found' });
    }
    expect(transport.calls.connect).toBe(0);

    transport.ids.push(OTHER);
    await new Promise((resolve) => { setTimeout(resolve, 600); });
    const found = await fetch(host.url(`/api/spaces/${OTHER}/echo`));
    expect(found.status).toBe(200);
  });

  it('lets no cookie through from a space, marks every answer nosniff, and serves a page as text', async () => {
    await start();
    const cookie = await fetch(host.url(`/api/spaces/${ID}/cookie`));
    expect(cookie.status).toBe(200);
    expect(cookie.headers.get('set-cookie')).toBeNull();
    expect(cookie.headers.get('x-content-type-options')).toBe('nosniff');

    const page = await fetch(host.url(`/api/spaces/${ID}/page`));
    expect(page.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await page.text()).toBe('<script>alert(1)</script>');
  });

  it('lets no redirect and no origin-acting header out of a space', async () => {
    await start();
    for (const method of ['GET', 'POST', 'DELETE']) {
      const redirected = await fetch(host.url(`/api/spaces/${ID}/redirect`), { method, redirect: 'manual', ...(method === 'POST' ? { body: 'x' } : {}) });
      expect(redirected.status, method).toBe(502);
      expect(redirected.headers.get('location')).toBeNull();
      expect(redirected.headers.get('clear-site-data')).toBeNull();
      expect(await redirected.json()).toMatchObject({ code: 'space_redirected' });
    }
    const wiped = await fetch(host.url(`/api/spaces/${ID}/wipe`));
    expect(wiped.status).toBe(200);
    expect(wiped.headers.get('clear-site-data')).toBeNull();
    expect(wiped.headers.get('refresh')).toBeNull();
    expect(wiped.headers.get('x-next-cursor')).toBe('abc');
    expect(wiped.headers.get('content-type')).toContain('application/json');

    const untyped = await fetch(host.url(`/api/spaces/${ID}/untyped`));
    expect(untyped.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await untyped.text()).toBe('<script>alert(1)</script>');
  });

  it('answers a stopped space with its code while a large body is still on its way in', async () => {
    await start();
    transport.connect = async () => { throw new SpaceError('space_not_running', `Space ${ID} is stopped. Start it, then try again.`); };
    // A client that has sent a third of its body and is still sending when the space refuses.
    const answer = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: host.port, method: 'POST', path: `/api/spaces/${ID}/echo`, headers: { 'content-type': 'application/octet-stream', 'content-length': String(3 * 1024 * 1024) } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.on('error', reject);
      request.write(Buffer.alloc(1024 * 1024, 5));
    });
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: 'space_not_running' });
  });

  it('serves a raw file from a space as an image or as a download, never as a page', async () => {
    await start();
    const image = await fetch(host.url(`/api/spaces/${ID}/fs/raw?type=${encodeURIComponent('image/png')}`));
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('content-disposition')).toBeNull();

    for (const type of ['text/html', 'image/svg+xml', 'application/javascript', 'application/pdf', 'text/plain']) {
      const other = await fetch(host.url(`/api/spaces/${ID}/fs/raw?type=${encodeURIComponent(type)}`));
      expect(other.headers.get('content-type'), type).toBe('application/octet-stream');
      expect(other.headers.get('content-disposition'), type).toBe('attachment');
      expect(other.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('logs in again when the server inside refuses the session, and repeats a request that has no body', async () => {
    await start();
    expect((await fetch(host.url(`/api/spaces/${ID}/echo`))).status).toBe(200);
    inside.state.refuseNext = 1;
    const repeated = await fetch(host.url(`/api/spaces/${ID}/echo?second=1`));
    expect(repeated.status).toBe(200);
    expect(inside.state.logins).toBe(2);
    // The token is read again for that login: the space may have been made again.
    expect(transport.calls.readToken).toBe(2);
  });

  it('does not repeat a request with a body after a refused session, and says so with a code', async () => {
    await start();
    expect((await fetch(host.url(`/api/spaces/${ID}/echo`))).status).toBe(200);
    inside.state.refuseNext = 1;
    const refused = await fetch(host.url(`/api/spaces/${ID}/echo`), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'once' });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: 'space_session_expired' });
    // The next request works without another refusal.
    const next = await fetch(host.url(`/api/spaces/${ID}/echo`), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'twice' });
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ bytes: 5 });
  });

  it('reads the token again when a login with the remembered one is refused', async () => {
    let clock = 1_000_000;
    await start({ now: () => clock });
    expect((await fetch(host.url(`/api/spaces/${ID}/echo`))).status).toBe(200);
    expect(transport.calls.readToken).toBe(1);
    // The server inside comes back with a new token, as after the agent rewrote the file and the
    // server restarted on it; the host still remembers the old one and has no session left.
    const previous = inside;
    const rotated = 'tok_' + 'c'.repeat(40);
    inside = await startInside({ password: rotated });
    await previous.stop();
    transport.readToken = async () => { transport.calls.readToken += 1; return rotated; };
    // The pooled connections to the old server are gone; the remembered token is not.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    clock += 11 * 60 * 60 * 1000;

    const response = await fetch(host.url(`/api/spaces/${ID}/echo?rotated=1`));
    expect(response.status).toBe(200);
    expect(transport.calls.readToken).toBe(2);
    expect(inside.state.logins).toBe(2);
  });

  it('renews the session before it expires', async () => {
    let clock = 1_000_000;
    await start({ now: () => clock });
    expect((await fetch(host.url(`/api/spaces/${ID}/echo`))).status).toBe(200);
    clock += 11 * 60 * 60 * 1000;
    expect((await fetch(host.url(`/api/spaces/${ID}/echo`))).status).toBe(200);
    expect(inside.state.logins).toBe(2);
  });

  it('turns a refusal of the place into a stable answer', async () => {
    await start();
    transport.connect = async () => { throw new SpaceError('space_not_running', `Space ${ID} is stopped. Start it, then try again.`); };
    const stopped = await fetch(host.url(`/api/spaces/${ID}/echo`));
    expect(stopped.status).toBe(503);
    expect(await stopped.json()).toMatchObject({ code: 'space_not_running', error: expect.stringMatching(/stopped/) });

    transport.connect = async () => net.connect({ host: '127.0.0.1', port: 1 });
    const unreachable = await fetch(host.url(`/api/spaces/${ID}/echo`));
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toMatchObject({ code: 'space_unreachable' });
  });

  it('sends a request without a body once more when a pooled stream has died under it', async () => {
    await start();
    expect((await fetch(host.url(`/api/spaces/${ID}/echo`))).status).toBe(200);
    // The stand-in closes its side of the pooled connection, as the server inside does when it is
    // stopped or when its keep-alive runs out; the next request meets the dead stream first.
    inside.server.closeAllConnections();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    const again = await fetch(host.url(`/api/spaces/${ID}/echo?again=1`));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ url: '/api/echo?again=1' });
  });

  it('keeps the space token out of every answer and every log line when the login fails', async () => {
    await start({ transport: { token: 'wrong_' + 'b'.repeat(40) } });
    const response = await fetch(host.url(`/api/spaces/${ID}/echo`));
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'space_login_failed' });
    expect(body).not.toContain('wrong_');
    expect(logs.join('\n')).not.toContain('wrong_');
    expect(logs.join('\n')).toContain('space_login_failed');

    transport.readToken = async () => { throw new SpaceError('space_token_unreadable', 'The token file of the server inside the space is empty. Something inside the space changed it.'); };
    dispatcher.close();
    const unreadable = await fetch(host.url(`/api/spaces/${ID}/echo`));
    expect(unreadable.status).toBe(502);
    expect(await unreadable.json()).toMatchObject({ code: 'space_token_unreadable' });
  });
});
