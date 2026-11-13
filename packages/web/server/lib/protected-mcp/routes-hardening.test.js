import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { registerProtectedMcpRoutes } from './routes.js';
import { createProtectedSelectionStore } from './selections.js';
import { createAdminSocketClient } from './test-support/admin-socket-client.js';
import { startService } from './test-support/fixtures.js';

const cleanups = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const endpoint = '/api/protected-mcp/connections';
const callback = '/api/protected-mcp/oauth/callback';
const state = Buffer.alloc(32, 1).toString('base64url');
const definition = { name: 'remote', transport: 'http', http: { url: 'https://example.test/mcp' } };
async function setup(adminSocket) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-routes-hardening-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'client.json');
  await fs.writeFile(config, JSON.stringify({ version: 1, socket: '/unused', adminSocket, relay: ['/relay'] }));
  const app = express();
  const dataDir = path.join(root, 'data');
  registerProtectedMcpRoutes(app, { dataDir, resolveOptionalProjectDirectory: async () => ({ directory: null }), isSupported: () => true, listOrdinaryMcpNames: () => [], env: { OPENCHAMBER_PROTECTED_MCP_CLIENT_CONFIG: config } });
  return { http: request(app), dataDir };
}
async function broker() {
  const fixture = await startService();
  cleanups.push(fixture.close);
  return { ...await setup(fixture.adminSocketPath), admin: createAdminSocketClient(fixture.adminSocketPath) };
}
async function socketFixture(onFrame) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmcp-wire-hardening-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) onFrame(JSON.parse(buffer.split('\n')[0]), socket);
    });
  });
  const socket = path.join(root, 'admin.sock');
  await new Promise((resolve) => server.listen(socket, resolve));
  cleanups.push(() => new Promise((resolve) => { server.close(resolve); for (const peer of sockets) peer.destroy(); }));
  return setup(socket);
}

it('cleans selections when DELETE finds the connection already removed', async () => {
  // Given selections left after a completed broker deletion.
  const { http, dataDir, admin } = await broker();
  const { connection } = await admin.create(definition);
  const selections = createProtectedSelectionStore({ dataDir });
  await selections.set({ scope: 'global', name: 'alias', connection: connection.id });
  await admin.apply({ kind: 'remove', id: connection.id, expectedRevision: 1 });
  // When the original HTTP delete is retried.
  const answer = await http.delete(`${endpoint}/${connection.id}`).send({ expectedRevision: 1 });
  // Then it succeeds and still cleans the orphaned selection.
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({ removed: true, selectionsRemoved: ['global.json'], selectionsNotUpdated: [] });
  expect(selections.read(null).global).toEqual({});
});

it('reports a selection directory failure after a successful DELETE', async () => {
  // Given a path that cannot be read as a selection directory.
  const { http, dataDir, admin } = await broker();
  const { connection } = await admin.create(definition);
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'mcp-protected'), 'not a directory');
  // When the broker deletion succeeds but cleanup cannot enumerate files.
  const answer = await http.delete(`${endpoint}/${connection.id}`).send({ expectedRevision: 1 });
  // Then the partial outcome remains a successful delete with a cleanup warning.
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({ removed: true, selectionsRemoved: [], selectionsNotUpdated: ['mcp-protected'] });
});

it('accepts constructor when no selection owns the name', async () => {
  // Given an empty global selection document.
  const { http } = await broker();
  // When creating a protected server named after an Object prototype property.
  const answer = await http.post(endpoint).send({ definition: { ...definition, name: 'constructor' }, use: { scope: 'global' } });
  // Then it creates and selects the server normally.
  expect(answer.status).toBe(201);
  expect(answer.body.selections.global.constructor.connection).toBe(answer.body.connection.id);
});

it.each(['bogus', 'A'.repeat(42), 'A'.repeat(44), 'z'.repeat(43), `${'A'.repeat(42)}=`])('rejects malformed callback state before contacting the broker: %s', async (invalid) => {
  // Given a broker that would report service overload if contacted.
  let calls = 0;
  const { http } = await socketFixture((_frame, socket) => { calls += 1; socket.end('{"type":"error","status":503,"code":"too_many_requests","message":"too_many_requests"}\n'); });
  // When the public callback receives a state the broker could not issue.
  const answer = await http.get(callback).query({ state: invalid, code: 'synthetic-code' });
  // Then invalid state is rejected locally and no socket capacity is used.
  expect(answer.status).toBe(400);
  expect(calls).toBe(0);
  expect(answer.headers['cache-control']).toBe('no-store');
});

it('caps callbacks at four and releases capacity when a broker request finishes', async () => {
  // Given four callbacks waiting on the broker.
  const peers = [];
  let arrived;
  const four = new Promise((resolve) => { arrived = resolve; });
  const reply = (socket) => socket.end('{"type":"oauth-completed","outcome":"oauth_state_invalid","name":null}\n');
  const { http } = await socketFixture((_frame, socket) => {
    peers.push(socket);
    if (peers.length === 4) arrived();
    if (peers.length > 4) reply(socket);
  });
  const pending = Array.from({ length: 4 }, () => http.get(callback).query({ state }).then((answer) => answer));
  await four;
  try {
    // When an anonymous fifth request arrives.
    const answer = await http.get(callback).query({ state });
    // Then it is refused without another broker connection.
    expect(answer.status).toBe(503);
    expect(peers).toHaveLength(4);
  } finally { for (const peer of peers) reply(peer); await Promise.all(pending); }
  const after = await http.get(callback).query({ state });
  expect(after.status).toBe(400);
  expect(peers).toHaveLength(5);
});

it.each(['start', 'paste', 'callback'])('allows the full OAuth network budget for %s', async (kind) => {
  // Given a real socket whose answer is held until the network budget has elapsed.
  let arrived;
  const reached = new Promise((resolve) => { arrived = resolve; });
  const { http } = await socketFixture((frame, socket) => arrived({ frame, socket }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const id = 'pmcp_0123456789abcdef';
  const call = kind === 'start'
    ? http.post(`${endpoint}/${id}/oauth`).send({ expectedRevision: 1 })
    : kind === 'paste'
      ? http.post('/api/protected-mcp/oauth/complete').send({ address: `https://example.test/callback?state=${state}&code=synthetic` })
      : http.get(callback).query({ state, code: 'synthetic' });
  const pending = call.then((answer) => answer);
  const { socket } = await reached;
  // When discovery plus registration takes 75 seconds, or exchange takes 15 seconds.
  await vi.advanceTimersByTimeAsync(kind === 'start' ? 75_001 : 15_001);
  socket.end(`${JSON.stringify(kind === 'start' ? { type: 'oauth-started', attempt: 'synthetic', authorizationUrl: 'https://example.test/authorize' } : { type: 'oauth-completed', outcome: 'authorized', name: 'remote' })}\n`);
  // Then the route still receives the broker's success.
  expect((await pending).status).toBe(200);
});
