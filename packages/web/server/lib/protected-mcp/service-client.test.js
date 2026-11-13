import fs from 'node:fs/promises';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { requestAdmin } from './service-client.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function peer(reply) {
  const root = await fs.mkdtemp('/tmp/pmcp-client-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const socketPath = `${root}/admin.sock`;
  const sockets = new Set();
  const received = [];
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.once('data', (chunk) => { received.push(JSON.parse(chunk.toString())); reply(socket); });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  const clientConfigPath = `${root}/client.json`;
  await fs.writeFile(clientConfigPath, JSON.stringify({ version: 1, socket: `${root}/engine.sock`, adminSocket: socketPath, relay: ['/relay'] }));
  return { clientConfigPath, socketPath, received };
}
describe('requestAdmin', () => {
  it('reads one answer line without waiting for a peer to close', async () => {
    // Given a socket which leaves the connection open after its first answer.
    const frame = { type: 'oauth-attempt', attempt: 'a'.repeat(22) };
    const fixture = await peer((socket) => socket.write('{"type":"oauth-attempt","status":"pending"}\nignored'));
    // When the caller sends an administration request.
    const result = await requestAdmin({ clientConfigPath: fixture.clientConfigPath, frame });
    // Then only the first answer is returned and the request has retained its fields.
    expect(result).toEqual({ ok: true, answer: { type: 'oauth-attempt', status: 'pending' } });
    expect(fixture.received).toEqual([frame]);
  });
  it('preserves broker refusal status, code and field-only message', async () => {
    // Given a broker refusing a stale revision.
    const fixture = await peer((socket) => socket.end('{"type":"error","status":409,"code":"revision_conflict","message":"revision_conflict"}\n'));
    // When its answer crosses the socket boundary.
    const result = await requestAdmin({ clientConfigPath: fixture.clientConfigPath, frame: { type: 'get' } });
    // Then the refusal remains distinct from a transport failure.
    expect(result).toEqual({ ok: false, status: 409, code: 'revision_conflict', message: 'revision_conflict' });
  });
  it.each(['not json\n', '{}\n', '{"type":"oauth-attempt","status":"pending"}', `${'x'.repeat(1024 * 1024 + 1)}\n`])('refuses malformed, incomplete or oversized socket answers', async (answer) => {
    // Given bytes outside the answer contract.
    const fixture = await peer((socket) => socket.end(answer));
    // When an administration answer is read.
    const result = await requestAdmin({ clientConfigPath: fixture.clientConfigPath, frame: { type: 'list' } });
    // Then no malformed data reaches the route.
    expect(result).toEqual({ ok: false, status: 502, code: 'invalid_response', message: 'invalid_response' });
  });
  it('bounds a silent peer by the requested timeout', async () => {
    // Given a peer that never answers.
    const fixture = await peer(() => {});
    // When its deadline expires.
    const result = await requestAdmin({ clientConfigPath: fixture.clientConfigPath, frame: { type: 'list' }, timeoutMs: 20 });
    // Then the route can report a gateway timeout.
    expect(result).toMatchObject({ ok: false, status: 504, code: 'service_timeout' });
  });
  it('distinguishes socket permissions from unavailable service', async () => {
    // Given a socket without connect permission for this user.
    const fixture = await peer(() => {});
    await fs.chmod(fixture.socketPath, 0);
    // When the client attempts administration.
    const result = await requestAdmin({ clientConfigPath: fixture.clientConfigPath, frame: { type: 'list' } });
    // Then permissions have a stable, separate refusal.
    expect(result).toMatchObject({ ok: false, status: 503, code: 'service_permission_denied' });
  });
  it.each(['missing', 'invalid'])('refuses %s client configuration', async (kind) => {
    // Given a missing or invalid configuration.
    const fixture = await peer(() => {});
    if (kind === 'missing') await fs.unlink(fixture.clientConfigPath);
    else await fs.writeFile(fixture.clientConfigPath, '{"version":1}');
    // When the endpoint is resolved.
    const result = await requestAdmin({ clientConfigPath: fixture.clientConfigPath, frame: { type: 'list' } });
    // Then neither case becomes successful empty data.
    expect(result).toMatchObject({ ok: false, status: 503, code: 'service_unavailable' });
  });
});
