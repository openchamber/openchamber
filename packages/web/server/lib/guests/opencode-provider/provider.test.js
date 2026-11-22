import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

import { OpenCode } from '@opencode/client';
import { GUEST_REQUEST_RESPONSE_MAX } from '@openchamber/sdk';

import { createGuestOpenCodeProvider } from './index.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listen = async (handler) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
};

const fixture = async (handler) => {
  const requests = [];
  const source = await listen(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: text });
    if (handler) return handler(req, res);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { id: 'ses_test' } }));
  });
  let selected = source;
  let guest = { service: { provides: ['opencode'] }, capabilityGrants: ['service', 'opencode'] };
  const provider = createGuestOpenCodeProvider({
    currentGuest: async () => guest,
    buildOpenCodeUrl: (path) => `${selected}${path}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic host-secret' }),
  });
  cleanups.push(() => provider.stop());
  const env = await provider.environmentFor({ guestId: 'reader', token: 'service-token' });
  const headers = { Authorization: 'Bearer service-token' };
  return { provider, requests, baseUrl: env.OPENCHAMBER_OPENCODE_URL, headers,
    client: OpenCode.make({ baseUrl: env.OPENCHAMBER_OPENCODE_URL, headers }),
    select: (value) => { selected = value; },
    withdraw: () => { guest = { ...guest, capabilityGrants: ['service'] }; },
  };
};

describe('host-selected OpenCode provider', () => {
  test('uses the standard client for listed reads with one upstream call each', async () => {
    const f = await fixture();
    expect(await f.client.session.get({ sessionID: 'ses_test' })).toEqual({ id: 'ses_test' });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].headers.authorization).toBe('Basic host-secret');
    for (const path of ['/api/session?parentID=ses_test', '/api/session/active', '/api/session/ses_test/message?limit=5', '/api/session/ses_test/message/msg_test', '/api/project']) {
      expect((await fetch(`${f.baseUrl}${path}`, { headers: f.headers })).status).toBe(200);
    }
    expect(f.requests.map((request) => request.path).slice(1)).toEqual(['/api/session?parentID=ses_test', '/api/session/active', '/api/session/ses_test/message?limit=5', '/api/session/ses_test/message/msg_test', '/api/project']);
  });

  test('passes on nothing of the caller but what it accepts', async () => {
    const f = await fixture();
    await fetch(`${f.baseUrl}/api/session`, { headers: { ...f.headers, accept: 'application/json', cookie: 'a=b', 'x-opencode-directory': '%2Ftmp', 'x-http-method-override': 'DELETE' } });
    expect(f.requests[0].headers.accept).toBe('application/json');
    for (const name of ['cookie', 'x-opencode-directory', 'x-http-method-override']) expect(f.requests[0].headers[name]).toBeUndefined();
  });

  test('refuses every write, every unlisted route and every path it cannot read, with no upstream call', async () => {
    const f = await fixture();
    const raw = (method, path) => new Promise((resolve, reject) => {
      const { port } = new URL(f.baseUrl);
      http.request({ port, method, path, headers: f.headers }, (response) => { response.resume(); resolve(response.statusCode); }).once('error', reject).end();
    });
    for (const [method, path] of [
      ['POST', '/api/session'],
      ['DELETE', '/api/session/ses_test'],
      ['PATCH', '/api/session/ses_test'],
      ['POST', '/api/session/ses_test/prompt'],
      ['POST', '/api/session/ses_test/interrupt'],
      ['PATCH', '/api/config'],
      ['PATCH', '/api/experimental/config?revision=7'],
      ['POST', '/api/rpc/another-plugin/new-method'],
      ['POST', '/api/credential'],
      ['POST', '/api/integration/openai/connect/key'],
      ['HEAD', '/api/session'],
      ['GET', '/api/rpc/another-plugin/new-method'],
      ['GET', '/api/credential'],
      ['GET', '/api//%63redential;ignored'],
      ['GET', '/api/config'],
      ['GET', '/api/info'],
      ['GET', '/api/agent'],
      ['GET', '/api/fs/list'],
      ['GET', '/api/session/ses_test/diff'],
      ['GET', '/api/session/stats'],
      ['GET', '/api/experimental/session/stats'],
      ['GET', '/api/some/future/route'],
      ['GET', '/health'],
      ['GET', '/api/../health'],
      ['GET', '/api/session/../credential'],
      ['GET', '/api/session/ses_test/../../credential'],
      ['GET', '/api/session/ses_test%2F..%2F..%2Fcredential'],
      ['GET', '/api/session\\active'],
      ['GET', 'http://example.com/api/session'],
    ]) {
      expect(await raw(method, path), `${method} ${path}`).toBe(403);
    }
    expect(f.requests).toEqual([]);
  });

  test('refuses a caller with no live token or from a browser', async () => {
    const f = await fixture();
    expect((await fetch(`${f.baseUrl}/api/session`)).status).toBe(403);
    expect((await fetch(`${f.baseUrl}/api/session`, { headers: { ...f.headers, origin: 'https://example.com' } })).status).toBe(403);
    expect(f.requests).toEqual([]);
  });

  test('drops a request body and sends only a GET', async () => {
    const f = await fixture();
    await new Promise((resolve, reject) => {
      const { port } = new URL(f.baseUrl);
      const body = '{"ignored":true}';
      http.request({ port, method: 'GET', path: '/api/session', headers: { ...f.headers, 'content-length': body.length } }, (response) => { response.resume(); response.once('end', resolve); })
        .once('error', reject).end(body);
    });
    expect(f.requests).toMatchObject([{ method: 'GET', body: '' }]);
  });

  test('uses the selected source for each call and never falls back after source failure', async () => {
    const f = await fixture();
    const other = await listen((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"id":"ses_other"}}'));
    f.select(other);
    expect(await f.client.session.get({ sessionID: 'ses_other' })).toEqual({ id: 'ses_other' });
    expect(f.requests).toEqual([]);
    const gone = http.createServer();
    gone.listen(0, '127.0.0.1');
    await once(gone, 'listening');
    const port = gone.address().port;
    await new Promise((resolve) => gone.close(resolve));
    f.select(`http://127.0.0.1:${port}`);
    expect((await fetch(`${f.baseUrl}/api/session`, { headers: f.headers })).status).toBe(502);
    expect(f.requests).toEqual([]);
  });

  test('withdrawal refuses a live service token and revocation aborts an active stream', async () => {
    let ended;
    const disconnected = new Promise((resolve) => { ended = resolve; });
    const f = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"ready":true}\n\n');
      res.once('close', ended);
    });
    const stream = await fetch(`${f.baseUrl}/api/event`, { headers: f.headers });
    const reader = stream.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
    f.provider.revokeGuest('reader');
    await expect(reader.read()).rejects.toThrow();
    await disconnected;
    expect((await fetch(`${f.baseUrl}/api/event`, { headers: f.headers })).status).toBe(403);
    await f.provider.environmentFor({ guestId: 'reader', token: 'new-token' });
    f.withdraw();
    expect((await fetch(`${f.baseUrl}/api/session`, { headers: { Authorization: 'Bearer new-token' } })).status).toBe(403);
    expect(f.requests).toHaveLength(1);
  });

  test('revocation during authorization cannot dispatch a late upstream request', async () => {
    let lookupStarted;
    let finishLookup;
    const started = new Promise((resolve) => { lookupStarted = resolve; });
    const lookup = new Promise((resolve) => { finishLookup = resolve; });
    const guest = { service: { provides: ['opencode'] }, capabilityGrants: ['service', 'opencode'] };
    let first = true;
    let calls = 0;
    const source = await listen((_req, res) => { calls += 1; res.end('{}'); });
    const provider = createGuestOpenCodeProvider({
      currentGuest: async () => {
        if (first) { first = false; return guest; }
        lookupStarted();
        return lookup;
      },
      buildOpenCodeUrl: (path) => `${source}${path}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
    cleanups.push(() => provider.stop());
    const env = await provider.environmentFor({ guestId: 'reader', token: 'token' });
    const request = fetch(`${env.OPENCHAMBER_OPENCODE_URL}/api/session`, { headers: { Authorization: 'Bearer token' } });
    await started;
    provider.revokeGuest('reader');
    finishLookup(guest);
    expect((await request).status).toBe(403);
    expect(calls).toBe(0);
  });

  test('a client closing its SSE stream cancels the upstream stream', async () => {
    let ended;
    const disconnected = new Promise((resolve) => { ended = resolve; });
    const f = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {}\n\n');
      res.once('close', ended);
    });
    const response = await fetch(`${f.baseUrl}/api/event`, { headers: f.headers });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await disconnected;
    expect(f.requests).toHaveLength(1);
  });

  test('moving to another OpenCode ends a live stream before the old one sends anything more', async () => {
    let write;
    const f = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"ready":true}\n\n');
      write = (text) => res.write(text);
    });
    const stream = await fetch(`${f.baseUrl}/api/event`, { headers: f.headers });
    const reader = stream.body.getReader();
    await reader.read();
    f.select(await listen((_req, res) => res.end()));
    write('data: {"after":"the switch"}\n\n');
    await expect(reader.read()).rejects.toThrow();
  });

  test('losing approval ends a live stream before it delivers anything more', async () => {
    let write;
    const f = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"ready":true}\n\n');
      write = (text) => res.write(text);
    });
    const stream = await fetch(`${f.baseUrl}/api/event`, { headers: f.headers });
    const reader = stream.body.getReader();
    await reader.read();
    write('data: {"still":"approved"}\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('still');
    // Nothing revokes the lease here: a policy change only alters the catalog row.
    f.withdraw();
    write('data: {"after":"the withdrawal"}\n\n');
    await expect(reader.read()).rejects.toThrow();
  });

  test('keeps OpenCode error bodies and compressed bytes, and follows no redirect', async () => {
    const f = await fixture((req, res) => {
      if (req.url === '/api/session/ses_moved') return res.writeHead(302, { location: 'http://example.com/' }).end();
      if (req.url === '/api/session/ses_missing') return res.writeHead(404, { 'content-type': 'application/json' }).end('{"_tag":"SessionNotFoundError"}');
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync('{"data":[]}'));
    });
    const missing = await fetch(`${f.baseUrl}/api/session/ses_missing`, { headers: f.headers });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ _tag: 'SessionNotFoundError' });
    expect(await (await fetch(`${f.baseUrl}/api/session`, { headers: f.headers })).json()).toEqual({ data: [] });
    expect((await fetch(`${f.baseUrl}/api/session/ses_moved`, { headers: f.headers })).status).toBe(502);
  });

  test('an oversized streamed body terminates instead of becoming a truncated successful payload', async () => {
    const f = await fixture((_req, res) => res.end(Buffer.alloc(GUEST_REQUEST_RESPONSE_MAX + 1)));
    const response = await fetch(`${f.baseUrl}/api/session`, { headers: f.headers });
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});
