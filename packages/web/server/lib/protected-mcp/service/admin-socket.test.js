import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdminSocketServer } from './admin-socket.js';
import { openStore, parseOperation } from './store.js';
import { SENTINEL } from '../test-support/fixtures.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const definition = { name: 'remote', transport: 'http', http: { url: 'https://mcp.example/mcp', headers: { Authorization: { secret: 'token' } } } };

async function setup(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-admin-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const store = await openStore({ stateDir: path.join(root, 'state') });
  cleanups.push(store.close);
  const { connection } = await store.apply(parseOperation({ kind: 'create', definition, secrets: { token: SENTINEL } }));
  const socketPath = path.join(root, 'admin.sock');
  const logs = [];
  const server = createAdminSocketServer({ path: socketPath, store, status: () => ({ administration: 'shared' }), views: async () => store.adminViews(), log: (...entry) => logs.push(entry), ...options });
  await server.listen();
  cleanups.push(server.close);
  return { socketPath, connection, store, server, logs };
}

function wire(socketPath, text) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('socket did not close')); }, 5000);
    socket.once('connect', () => socket.write(text));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', reject);
    const finish = () => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      // Scan the wire before parsing, for every answer including errors.
      try {
        expect(bytes.includes(Buffer.from(SENTINEL))).toBe(false);
        resolve(bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
      } catch (error) { reject(error); }
    };
    socket.once('close', finish);
  });
}
const request = async (fixture, frame) => (await wire(fixture.socketPath, `${JSON.stringify(frame)}\n`))[0];

describe('admin socket contract', () => {
  it('sets mode 0660 and the requested group when listening', async () => {
    // Given / When
    const fixture = await setup({ group: process.getgid() });
    // Then
    const stats = await fs.stat(fixture.socketPath);
    expect(stats.mode & 0o777).toBe(0o660);
    expect(stats.gid).toBe(process.getgid());
  });

  it('returns only redacted views for list, get and apply when credentials are stored', async () => {
    // Given
    const fixture = await setup();
    // When
    const answers = [await request(fixture, { type: 'list' }), await request(fixture, { type: 'get', id: fixture.connection.id }), await request(fixture, { type: 'apply', operation: { kind: 'set-enabled', id: fixture.connection.id, expectedRevision: 1, enabled: false } })];
    // Then
    expect(answers[0]).toMatchObject({ type: 'connections', status: { administration: 'shared' }, connections: [{ secrets: { token: { set: true } } }] });
    expect(answers.slice(1).map((answer) => answer.connection.secrets)).toEqual([{ token: { set: true } }, { token: { set: true } }]);
    expect(fixture.logs).toContainEqual(['connection_changed', { kind: 'set-enabled', connection: fixture.connection.id }]);
  });

  it('returns the runtime view when a stdio connection is created', async () => {
    // Given
    const fixture = await setup();
    // Use a separate listener with the real store views augmented as service.js does.
    await fixture.server.close();
    const server = createAdminSocketServer({ path: fixture.socketPath, store: fixture.store, status: () => ({}), views: async () => fixture.store.adminViews().map((view) => ({ ...view, runtime: 'ready' })) });
    await server.listen();
    cleanups.push(server.close);
    // When
    const answer = await request(fixture, { type: 'apply', operation: { kind: 'create', definition: { name: 'stdio', transport: 'stdio', stdio: { command: '/usr/bin/node' } } } });
    // Then
    expect(answer.connection.runtime).toBe('ready');
  });

  it.each([
    ['not json\n', 'malformed_frame'], ['[]\n', 'malformed_frame'],
    ['{"type":"unknown"}\n', 'unsupported_request'], ['{"type":4}\n', 'invalid_request'],
    ['{"type":"get","id":4}\n', 'invalid_request'], ['{"type":"apply","operation":[]}\n', 'invalid_request'],
    ['{"type":"get"}\n', 'invalid_request'],
    [`${'x'.repeat(1024 * 1024 + 1)}\n`, 'frame_too_large'],
    ['{"type":"list"}', 'request_timeout'],
    ['{"type":"oauth-start","id":"pmcp_0123456789abcdef","expectedRevision":"1","redirectUri":"https://app.example/callback"}\n', 'invalid_request'],
    [`{"type":"oauth-complete","state":"${'x'.repeat(4097)}"}\n`, 'invalid_request'],
    ['{"type":"oauth-complete","state":"x","code":4}\n', 'invalid_request'],
    ['{"type":"oauth-complete","state":"x","error":4}\n', 'invalid_request'],
    [`{"type":"oauth-complete","state":"x","code":"${'x'.repeat(4097)}"}\n`, 'invalid_request'],
    [`{"type":"oauth-complete","state":"x","error":"${'x'.repeat(4097)}"}\n`, 'invalid_request'],
    [`{"type":"oauth-start","id":"pmcp_0123456789abcdef","expectedRevision":1,"redirectUri":"${'x'.repeat(2049)}"}\n`, 'invalid_request'],
    ['{"type":"oauth-attempt","attempt":"bad"}\n', 'invalid_request'],
    ['{"type":"oauth-attempt","attempt":4}\n', 'invalid_request'],
  ])('refuses invalid input case %#', async (text, code) => {
    // Given
    const fixture = await setup(code === 'request_timeout' ? { requestTimeoutMs: 100 } : {});
    // When
    const answers = await wire(fixture.socketPath, text);
    // Then
    expect(answers).toEqual([{ type: 'error', code, status: 400, message: expect.any(String) }]);
  });

  it('ignores every frame after the first line', async () => {
    // Given
    const fixture = await setup();
    // When
    const answers = await wire(fixture.socketPath, '{"type":"list"}\n{"type":"remove"}\n');
    // Then
    expect(answers).toHaveLength(1);
    expect(answers[0].type).toBe('connections');
  });

  it('accepts exactly 1 MiB when the first line reaches the byte limit', async () => {
    // Given
    const fixture = await setup();
    const frame = '{"type":"list","padding":"';
    const text = `${frame}${'x'.repeat(1024 * 1024 - Buffer.byteLength(frame) - 2)}"}\n`;
    // When
    const answers = await wire(fixture.socketPath, text);
    // Then
    expect(answers[0].type).toBe('connections');
  });

  it('returns a 404 when an id has no connection', async () => {
    // Given
    const fixture = await setup();
    // When
    const answer = await request(fixture, { type: 'get', id: 'pmcp_ffffffffffffffff' });
    // Then
    expect(answer).toMatchObject({ type: 'error', code: 'connection_not_found', status: 404 });
  });

  it('redacts unexpected failures when a dependency throws sensitive text', async () => {
    // Given
    const fixture = await setup({ views: async () => { throw new Error(SENTINEL); } });
    // When
    const answer = await request(fixture, { type: 'list' });
    // Then
    expect(answer).toEqual({ type: 'error', code: 'internal_error', status: 500, message: 'internal_error' });
    expect(fixture.logs).toEqual([['admin_request_failed', { name: 'Error' }]]);
  });

  it('revokes upstream after local apply and keeps removal successful when upstream fails', async () => {
    // Given
    const revoked = [];
    const fixture = await setup({ oauth: { revokeUpstream: async (previous, record) => { revoked.push([previous.id, record.oauth.tokens]); throw new Error(SENTINEL); } } });
    const { destinationFingerprint } = await import('./definitions.js');
    await fixture.store.updateOAuth(fixture.connection.id, destinationFingerprint(fixture.store.get(fixture.connection.id)), () => ({ tokens: { accessToken: SENTINEL } }));
    // When
    const answer = await request(fixture, { type: 'apply', operation: { kind: 'remove', id: fixture.connection.id, expectedRevision: 1 } });
    // Then
    expect(answer).toEqual({ type: 'applied', connection: null });
    expect(revoked).toEqual([[fixture.connection.id, { accessToken: SENTINEL }]]);
    expect(fixture.logs).toContainEqual(['oauth_revocation_failed', { connection: fixture.connection.id }]);
    expect(JSON.stringify(fixture.logs)).not.toContain(SENTINEL);
  });

  it('refuses a seventeenth simultaneous connection', async () => {
    // Given
    const fixture = await setup({ requestTimeoutMs: 4000 });
    const peers = await Promise.all(Array.from({ length: 16 }, () => new Promise((resolve) => {
      const socket = net.createConnection(fixture.socketPath);
      socket.on('error', () => {});
      socket.once('connect', () => resolve(socket));
    })));
    cleanups.push(async () => { for (const peer of peers) peer.destroy(); });
    // When
    const answer = await request(fixture, { type: 'list' });
    // Then
    expect(answer).toMatchObject({ type: 'error', code: 'too_many_requests', status: 503 });
  });

  it('destroys a peer that keeps its half open after the answer', async () => {
    // Given
    const fixture = await setup();
    const peer = net.createConnection({ path: fixture.socketPath, allowHalfOpen: true });
    cleanups.push(async () => peer.destroy());
    const chunks = [];
    peer.on('data', (chunk) => chunks.push(chunk));
    peer.write('{"type":"list"}\n');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('answer did not end')), 5000);
      peer.once('end', () => { clearTimeout(timer); resolve(); });
    });
    // When
    await Promise.race([fixture.server.close(), new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('half-open peer held shutdown')), 4000);
      timer.unref();
    })]);
    // Then
    const bytes = Buffer.concat(chunks);
    expect(bytes.includes(Buffer.from(SENTINEL))).toBe(false);
    expect(JSON.parse(bytes.toString()).type).toBe('connections');
  });

  it('closes incomplete connections and remains usable after a disconnected request', async () => {
    // Given
    const fixture = await setup();
    const peer = net.createConnection(fixture.socketPath);
    await new Promise((resolve) => peer.once('connect', resolve));
    peer.write('{"type":');
    peer.destroy();
    const open = net.createConnection(fixture.socketPath);
    await new Promise((resolve) => open.once('connect', resolve));
    open.resume();
    const ended = new Promise((resolve) => open.once('close', resolve));
    // When
    await fixture.server.close();
    await ended;
    // Then
    expect(open.destroyed).toBe(true);
  });

  it('finishes an accepted request after its peer disconnects and serves a later request', async () => {
    // Given
    let arrived;
    const reached = new Promise((resolve) => { arrived = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let first = true;
    const fixture = await setup({ views: async () => {
      if (first) { first = false; arrived(); await gate; }
      return [];
    } });
    cleanups.push(async () => release());
    const peer = net.createConnection(fixture.socketPath);
    peer.on('error', () => {});
    peer.write('{"type":"list"}\n');
    await Promise.race([reached, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('request did not arrive')), 4000);
      timer.unref();
    })]);
    // When
    peer.destroy();
    release();
    const answer = await request(fixture, { type: 'list' });
    // Then
    expect(answer).toMatchObject({ type: 'connections', connections: [] });
  });
});
