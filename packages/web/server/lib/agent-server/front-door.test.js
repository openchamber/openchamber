import http from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentUpstream } from './agent-upstream.js';
import { createFrontDoor, frontDoorRequestGate } from './front-door.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(handle, { spaces = null } = {}) {
  const agent = http.createServer((req, res) => {
    if (req.url === '/auth/session') {
      req.resume();
      res.setHeader('set-cookie', 'oc_ui_session=test-agent-cookie; Max-Age=3600');
      res.end('{}');
    } else handle(req, res);
  });
  const agentUrl = await listen(agent);
  const upstream = createAgentUpstream({ url: agentUrl, token: 'disposable-test' });
  const app = express();
  const server = http.createServer(app);
  const door = createFrontDoor({
    upstream, getSpacesHost: () => spaces, hub: {},
    uiAuthController: { enabled: true, ensureSessionToken: async (req) => req.headers.cookie === 'owner=authorized' ? 'owner' : null },
    isRequestOriginAllowed: (req) => req.headers.origin === 'http://owner.test',
  });
  cleanup.push(() => door.close());
  app.use(frontDoorRequestGate);
  app.use((req, res, next) => req.headers.authorization === 'Bearer owner-only' ? next() : res.status(401).end());
  app.use(door.middleware);
  app.use((_req, res) => res.status(418).end('owner local route'));
  server.on('upgrade', door.upgradeHandler);
  const url = await listen(server);
  const fetchDoor = (path, options = {}) => fetch(`${url}${path}`, { ...options, headers: { authorization: 'Bearer owner-only', ...options.headers } });
  return { agent, upstream, url, fetchDoor };
}

describe('agent forwarding through the space dispatcher', () => {
  it('keeps owner authentication ahead of forwarding', async () => {
    // Given an authenticated front door and an uncalled agent.
    const handle = vi.fn((_req, res) => res.end('{}'));
    const { url } = await fixture(handle);
    // When a browser has no owner credential.
    const response = await fetch(`${url}/api/session`);
    // Then the agent is never contacted.
    expect(response.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });
  it('strips owner credentials and streams the body to the exact agent route', async () => {
    // Given a body that must not be consumed by an owner parser.
    const { fetchDoor, agent } = await fixture(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }));
    });
    // When credentials are present in headers and the query.
    const response = await fetchDoor('/api/Echo?oc_url_token=owner-url&oc_client_token=owner-token&keep=yes', {
      method: 'POST', body: 'payload', headers: { cookie: 'owner-secret=value', origin: 'http://owner.test', 'x-forwarded-host': 'owner.test' },
    });
    const result = await response.json();
    // Then only the agent cookie and host cross the boundary, and parameter case survives.
    expect(result.path).toBe('/api/Echo?keep=yes');
    expect(result.body).toBe('payload');
    expect(result.headers).toMatchObject({ cookie: 'oc_ui_session=test-agent-cookie', host: `127.0.0.1:${agent.address().port}` });
    for (const header of ['authorization', 'origin', 'x-forwarded-host']) expect(result.headers[header]).toBeUndefined();
  });
  it.each([
    ['/api/page', 'text/html', undefined, 'text/plain; charset=utf-8', null],
    ['/api/fs/raw', 'image/svg+xml', undefined, 'application/octet-stream', 'attachment'],
    ['/api/fs/raw', 'image/png', undefined, 'image/png', null],
    ['/api/fs/preview/file', 'text/html', 'sandbox allow-same-origin', 'text/html', null],
  ])('owns response policy for %s %s', async (route, type, csp, expected, disposition) => {
    // Given hostile response headers, and an already-sandboxed preview positive control.
    const { fetchDoor } = await fixture((_req, res) => {
      res.setHeader('content-type', type);
      res.setHeader('set-cookie', 'owner=compromised');
      res.setHeader('access-control-allow-origin', '*');
      if (csp) res.setHeader('content-security-policy', csp);
      res.end('file bytes');
    });
    // When forwarded through the dispatcher.
    const response = await fetchDoor(route);
    // Then the owner defines sniffing, rendering and cookie behavior.
    expect(response.headers.get('content-type')).toBe(expected);
    expect(response.headers.get('content-disposition')).toBe(disposition);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe(csp ? 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads' : null);
    expect(await response.text()).toBe('file bytes');
  });
  it('refuses redirects with an agent-specific error', async () => {
    // Given an agent trying to redirect the browser to an owner action.
    const { fetchDoor } = await fixture((_req, res) => res.writeHead(307, { location: '/api/protected-mcp' }).end());
    // When forwarded, then there is no Location to follow.
    const response = await fetchDoor('/api/file');
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toMatchObject({ code: 'agent_redirected' });
  });
  it('merges a sanitized agent list with spaces using the existing host', async () => {
    // Given a paged agent list with fabricated provenance and a real merge owner.
    const mergeSessionList = vi.fn((list) => ({ ...list, mergedByOwner: true }));
    const { fetchDoor } = await fixture((_req, res) => res.end(JSON.stringify({ data: [
      { id: 'ses_agent', title: 'Agent', spaceId: 'fake' },
      { id: 'ses_spoof', location: { directory: '/spaces/012345abcdef/repo' } },
      { id: 'ses_space', location: { directory: '/work' } },
    ], cursor: { next: null } })), { spaces: { mergeSessionList, index: { claimedBy: (id) => id === 'ses_space' ? '012345abcdef' : null } } });
    // When the global, unscoped list is requested.
    const response = await fetchDoor('/api/session');
    // Then only sanitized records reach the existing merge function.
    expect(await response.json()).toEqual({ data: [{ id: 'ses_agent', title: 'Agent' }], cursor: { next: null }, mergedByOwner: true });
    expect(mergeSessionList).toHaveBeenCalledOnce();
  });
  it('fails unreachable agent requests rather than using a local route', async () => {
    // Given an agent that has stopped after the fixture was created.
    const { agent, fetchDoor } = await fixture((_req, res) => res.end('{}'));
    await new Promise((resolve) => agent.close(resolve));
    // When a project route is requested, then no owner execution occurs.
    const response = await fetchDoor('/api/git/status');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'agent_unreachable' });
  });
  it('checks scoped and paged lists and detail responses without merging them with Spaces', async () => {
    const mergeSessionList = vi.fn();
    const seen = [];
    const { fetchDoor } = await fixture((req, res) => {
      seen.push({ path: req.url, directory: req.headers['x-opencode-directory'] });
      const valid = { id: 'ses_agent', location: { directory: '/work' } };
      const forged = { id: 'ses_fake', location: { directory: '/spaces/012345abcdef/repo' } };
      res.end(JSON.stringify(req.url.startsWith('/api/session/ses_fake') ? forged : { data: [valid, forged], cursor: { next: 'next-page' } }));
    }, { spaces: { mergeSessionList } });
    const response = await fetchDoor('/api/session?cursor=page-2', { headers: { 'x-opencode-directory': '/work' } });
    expect((await response.json()).data).toHaveLength(1);
    expect(seen[0]).toEqual({ path: '/api/session?cursor=page-2', directory: '/work' });
    expect(mergeSessionList).not.toHaveBeenCalled();
    const detail = await fetchDoor('/api/session/ses_fake');
    expect(detail.status).toBe(502);
    expect(await detail.json()).toMatchObject({ code: 'agent_session_refused' });
  });
  it('forwards terminal frames both ways only after owner auth and origin checks', async () => {
    // Given an agent socket endpoint that echoes frames.
    const { agent, url } = await fixture((_req, res) => res.end('{}'));
    const wsServer = new WebSocketServer({ noServer: true });
    let upgrades = 0;
    agent.on('upgrade', (req, socket, head) => {
      upgrades += 1;
      expect(req.headers.cookie).toBe('oc_ui_session=test-agent-cookie');
      expect(req.headers.origin).toBe(`http://127.0.0.1:${agent.address().port}`);
      wsServer.handleUpgrade(req, socket, head, (ws) => ws.on('message', (bytes) => ws.send(bytes)));
    });
    cleanup.push(() => { for (const ws of wsServer.clients) ws.terminate(); wsServer.close(); });
    const denied = (headers) => new Promise((resolve) => {
      const ws = new WebSocket(`${url.replace('http:', 'ws:')}/api/terminal/ws`, { headers });
      ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
      ws.on('error', () => {});
    });
    // When owner auth or origin is missing, then the upstream sees no handshake.
    expect(await denied({ origin: 'http://owner.test' })).toBe(401);
    expect(await denied({ cookie: 'owner=authorized', origin: 'http://evil.test' })).toBe(403);
    expect(upgrades).toBe(0);
    const ws = new WebSocket(`${url.replace('http:', 'ws:')}/api/terminal/ws`, { headers: { cookie: 'owner=authorized', origin: 'http://owner.test' } });
    cleanup.push(() => ws.terminate());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const echoed = new Promise((resolve) => ws.once('message', (bytes) => resolve(bytes.toString())));
    ws.send('terminal-input');
    expect(await echoed).toBe('terminal-input');
    expect(upgrades).toBe(1);
  });
});
