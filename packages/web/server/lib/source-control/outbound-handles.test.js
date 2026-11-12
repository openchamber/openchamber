import http from 'node:http';
import { SOURCE_CONTROL_OUTBOUND_METHODS } from '@openchamber/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOutboundHandles } from './outbound-handles.js';

let forge;
let origin;
const seen = [];

beforeAll(async () => {
  forge = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (request.url.startsWith('/big')) {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('x'.repeat(8_000_001));
        return;
      }
      if (request.url.startsWith('/redirect')) {
        response.writeHead(302, { location: 'https://elsewhere.example/' });
        response.end();
        return;
      }
      const status = request.url.startsWith('/refused') ? 401 : 200;
      response.writeHead(status, {
        'content-type': 'application/json', 'x-total-count': '3', 'x-ratelimit-remaining': '9', 'set-cookie': 'a=b', server: 'forge',
      });
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => forge.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${forge.address().port}`;
});
afterAll(() => new Promise((resolve) => forge.close(resolve)));

const credential = { token: 'secret-token', header: 'authorization', scheme: 'token' };

describe('outbound handles', () => {
  it('relays a request on the bound origin with the token, allowed headers only, and records it', async () => {
    const handles = createOutboundHandles();
    const grant = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin, credential, deadline: Date.now() + 5_000 });
    const answer = await handles.serve({ bearer: grant.handle, body: {
      method: 'POST', path: '/api/v1/repos', query: { page: '2' }, headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{"a":1}',
    } });
    expect(answer).toEqual({ status: 200, body: {
      status: 200, headers: { 'content-type': 'application/json', 'x-total-count': '3', 'x-ratelimit-remaining': '9' }, body: '{"ok":true}',
    } });
    const request = seen.at(-1);
    expect(request).toMatchObject({ method: 'POST', url: '/api/v1/repos?page=2', body: '{"a":1}' });
    expect(request.headers.authorization).toBe('token secret-token');
    expect(grant.outbound).toEqual([{ method: 'POST', status: 200 }]);
  });

  it.each([
    [{ header: 'authorization', scheme: 'bearer' }, 'authorization', 'Bearer secret-token'],
    [{ header: 'private-token', scheme: 'none' }, 'private-token', 'secret-token'],
  ])('sends the token as the extension declared (%o)', async (format, header, value) => {
    const handles = createOutboundHandles();
    const grant = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin, credential: { token: 'secret-token', ...format }, deadline: Date.now() + 5_000 });
    await handles.serve({ bearer: grant.handle, body: { method: 'GET', path: '/x' } });
    expect(seen.at(-1).headers[header]).toBe(value);
  });

  it('sends a basic token as Basic base64(login:token)', async () => {
    const handles = createOutboundHandles();
    const grant = handles.mint({
      guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin,
      credential: { token: 'http-pass/word', header: 'authorization', scheme: 'basic', login: 'mona' }, deadline: Date.now() + 5_000,
    });
    await handles.serve({ bearer: grant.handle, body: { method: 'GET', path: '/a/accounts/self' } });
    expect(seen.at(-1).headers.authorization).toBe(`Basic ${Buffer.from('mona:http-pass/word').toString('base64')}`);
  });

  it.each([undefined, '', 'mo:na', 'mo\nna'])('refuses a basic credential without a login it can send (%j)', (login) => {
    const handles = createOutboundHandles();
    expect(() => handles.mint({
      guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin,
      credential: { token: 't', header: 'authorization', scheme: 'basic', login }, deadline: Date.now() + 5_000,
    })).toThrow(expect.objectContaining({ status: 400, code: 'SOURCE_CONTROL_USERNAME_REQUIRED' }));
  });

  it('sends no token for a handle without one, and records a 401 the forge gave', async () => {
    const handles = createOutboundHandles();
    const grant = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin, credential: null, deadline: Date.now() + 5_000 });
    const answer = await handles.serve({ bearer: grant.handle, body: { method: 'GET', path: '/refused' } });
    expect(answer.body.status).toBe(401);
    expect(seen.at(-1).headers.authorization).toBeUndefined();
    expect(grant.outbound).toEqual([{ method: 'GET', status: 401 }]);
  });

  it('refuses unknown, revoked and expired handles, foreign origins, bad methods and headers', async () => {
    let now = 1_000;
    const handles = createOutboundHandles({ now: () => now });
    const grant = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin, credential, deadline: 2_000 });
    const count = seen.length;
    const serve = (body, bearer = grant.handle) => handles.serve({ bearer, body });
    expect(await serve({ method: 'GET', path: '/x' }, 'unknown')).toMatchObject({ status: 403, body: { error: { code: 'HANDLE_UNKNOWN' } } });
    expect(await serve({ method: 'GET', path: '//evil.example/x' })).toMatchObject({ status: 400 });
    expect(await serve({ method: 'GET', path: '/x/../../y' })).toMatchObject({ status: 403, body: { error: { code: 'OFF_ORIGIN' } } });
    expect(await serve({ method: 'TRACE', path: '/x' })).toMatchObject({ status: 400 });
    expect(await serve({ method: 'GET', path: '/x', headers: { cookie: 'a=b' } })).toMatchObject({ status: 400 });
    expect(await serve({ method: 'GET', path: '/x', headers: { authorization: 'token other' } })).toMatchObject({ status: 400 });
    expect(await serve({ method: 'POST', path: '/x', body: 'x'.repeat(1_000_001) })).toMatchObject({ status: 400 });
    now = 2_001;
    expect(await serve({ method: 'GET', path: '/x' })).toMatchObject({ status: 403, body: { error: { code: 'HANDLE_EXPIRED' } } });
    expect(seen.length).toBe(count);
    expect(grant.outbound).toEqual([]);

    const live = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin, credential, deadline: now + 5_000 });
    live.revoke();
    expect(await serve({ method: 'GET', path: '/x' }, live.handle)).toMatchObject({ body: { error: { code: 'HANDLE_UNKNOWN' } } });
    const other = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin, credential, deadline: now + 5_000 });
    handles.revokeGuest('forge');
    expect(await serve({ method: 'GET', path: '/x' }, other.handle)).toMatchObject({ body: { error: { code: 'HANDLE_UNKNOWN' } } });
  });

  it('a read-only handle refuses a write before it is sent or recorded', async () => {
    const handles = createOutboundHandles();
    const grant = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: ['GET'], origin, credential, deadline: Date.now() + 5_000 });
    const count = seen.length;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await handles.serve({ bearer: grant.handle, body: { method, path: '/x', body: '{}' } }))
        .toMatchObject({ status: 403, body: { error: { code: 'METHOD_NOT_ALLOWED' } } });
    }
    expect(seen.length).toBe(count);
    expect(grant.outbound).toEqual([]);
    expect((await handles.serve({ bearer: grant.handle, body: { method: 'GET', path: '/x' } })).status).toBe(200);
    expect(grant.outbound).toEqual([{ method: 'GET', status: 200 }]);
  });

  it('admits only live handles, before any body is read', () => {
    let now = 1_000;
    const handles = createOutboundHandles({ now: () => now });
    const grant = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: ['GET'], origin, credential, deadline: 2_000 });
    expect(handles.refusal(grant.handle)).toBeNull();
    expect(handles.refusal('unknown')).toMatchObject({ status: 403, body: { error: { code: 'HANDLE_UNKNOWN' } } });
    now = 2_001;
    expect(handles.refusal(grant.handle)).toMatchObject({ status: 403, body: { error: { code: 'HANDLE_EXPIRED' } } });
    const other = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: ['GET'], origin, credential, deadline: 5_000 });
    other.revoke();
    expect(handles.refusal(other.handle)).toMatchObject({ body: { error: { code: 'HANDLE_UNKNOWN' } } });
  });

  it('does not follow redirects and refuses an answer over the cap', async () => {
    const handles = createOutboundHandles();
    const grant = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin, credential, deadline: Date.now() + 10_000 });
    expect((await handles.serve({ bearer: grant.handle, body: { method: 'GET', path: '/redirect' } })).body.status).toBe(302);
    expect(await handles.serve({ bearer: grant.handle, body: { method: 'GET', path: '/big' } }))
      .toMatchObject({ status: 502, body: { error: { code: 'RESPONSE_TOO_LARGE' } } });
  });

  it('records a write it could not deliver as sent with no answer', async () => {
    const handles = createOutboundHandles({ fetch: async () => { throw new Error('reset'); } });
    const grant = handles.mint({ guestId: 'forge', providerId: 'ext-forge', methods: SOURCE_CONTROL_OUTBOUND_METHODS, origin, credential, deadline: Date.now() + 5_000 });
    expect(await handles.serve({ bearer: grant.handle, body: { method: 'POST', path: '/x', body: '{}' } }))
      .toMatchObject({ status: 502, body: { error: { code: 'FORGE_UNREACHABLE' } } });
    expect(grant.outbound).toEqual([{ method: 'POST', status: 0 }]);
  });
});
