import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { registerProtectedMcpRoutes } from './routes.js';
import { createProtectedMcpMirror } from '../agent-server/protected-mcp.js';
import { createAdminSocketClient } from './test-support/admin-socket-client.js';
import { startService } from './test-support/fixtures.js';
import { agentSubjectConnections } from './agent-subject.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture({ names = async () => [] } = {}) {
  const f = await startService();
  cleanups.push(f.close);
  const admin = createAdminSocketClient(f.adminSocketPath);
  const { connection } = await admin.create({ name: 'selected', transport: 'http', http: { url: 'https://example.test/mcp' } });
  const { connection: other } = await admin.create({ name: 'other', transport: 'http', http: { url: 'https://example.test/mcp' } });
  const dataDir = path.join(f.root, 'front');
  const config = path.join(f.root, 'client.json');
  await fs.writeFile(config, JSON.stringify({ version: 1, socket: f.engineSocketPath, adminSocket: f.adminSocketPath, relay: ['/synthetic'] }));
  const sent = [];
  const mirror = createProtectedMcpMirror({ dataDir, upstream: { json: async (_route, { body }) => {
    sent.push(JSON.parse(body));
    return { subject: 'agent', connections: ['pmcp_aaaaaaaaaaaaaaaa'] };
  } } });
  const push = vi.spyOn(mirror, 'push');
  const app = express();
  registerProtectedMcpRoutes(app, {
    dataDir, isSupported: () => true, env: { OPENCHAMBER_PROTECTED_MCP_CLIENT_CONFIG: config },
    resolveOptionalProjectDirectory: async (req) => ({ directory: req.query.directory ?? null }),
    resolveProjectIdentity: async () => 'directory:/agent-only/project',
    listOrdinaryMcpNames: names, selectionMirror: mirror,
  });
  await mirror.flush();
  return { ...f, http: request(app), dataDir, config, connection, other, sent, mirror, push };
}

it('pushes the initial complete owner snapshot at route registration', async () => {
  // Given front-door routes with no prior selections.
  const f = await fixture();
  // When route startup has flushed its initial mirror.
  const snapshots = f.sent;
  // Then the empty authoritative snapshot clears stale agent files.
  expect(snapshots).toEqual([{ version: 1, documents: [] }]);
});

it('saves global and async project selections and mirrors their service-owned union', async () => {
  // Given two synthetic service connections and a project absent on the front door.
  const f = await fixture();
  await f.http.put('/api/protected-mcp/selections/global').send({ scope: 'global', connection: f.connection.id }).expect(200);
  // When a project selection is made through the same HTTP routes.
  const result = await f.http.put('/api/protected-mcp/selections/project?directory=%2Fagent-only%2Fproject').send({ scope: 'project', connection: f.other.id });
  await f.mirror.flush();
  // Then the response and mirror contain both entries and hostile mirror answers grant nothing.
  expect(result.status).toBe(200);
  expect(Object.keys(result.body.selections.effective).sort()).toEqual(['global', 'project']);
  expect(f.sent.at(-1).documents).toHaveLength(2);
  expect(agentSubjectConnections(f.dataDir)).toEqual([f.connection.id, f.other.id].sort());
});

it('reports ordinary-name conflicts returned asynchronously by the agent', async () => {
  // Given an existing selection whose ordinary name later appears in agent configuration.
  let names = [];
  const f = await fixture({ names: async () => names });
  await f.http.put('/api/protected-mcp/selections/shared').send({ scope: 'global', connection: f.connection.id }).expect(200);
  names = ['shared'];
  // When status is read for the project.
  const result = await f.http.get('/api/protected-mcp/status?directory=%2Fagent-only%2Fproject');
  // Then the conflict is visible.
  expect(result.body.conflicts).toEqual(['shared']);
});

it('refuses a project selection colliding with an asynchronous ordinary name', async () => {
  // Given an agent ordinary entry named shared.
  const f = await fixture({ names: async () => ['shared'] });
  // When the front door tries to select that name for the project.
  const result = await f.http.put('/api/protected-mcp/selections/shared?directory=%2Fagent-only%2Fproject').send({ scope: 'project', connection: f.connection.id });
  // Then no conflicting protected selection is persisted.
  expect(result.status).toBe(409);
  expect(result.body.code).toBe('name_in_use');
});

it('keeps conflicts unknown when the agent configuration read fails', async () => {
  // Given unavailable agent configuration.
  const f = await fixture({ names: async () => { throw new Error('unavailable'); } });
  // When the owner reads status.
  const result = await f.http.get('/api/protected-mcp/status?directory=%2Fagent-only%2Fproject');
  // Then failure stays distinct from an empty ordinary configuration.
  expect(result.body.conflicts).toBeNull();
});

it.each(['remove-selection', 'create', 'remove-connection'])('mirrors documents after %s', async (operation) => {
  // Given one owner-selected connection.
  const f = await fixture();
  await f.http.put('/api/protected-mcp/selections/selected').send({ scope: 'global', connection: f.connection.id }).expect(200);
  await f.mirror.flush();
  const before = f.push.mock.calls.length;
  // When another supported mutation changes the selection documents.
  const operations = {
    'remove-selection': () => f.http.delete('/api/protected-mcp/selections/selected').send({ scope: 'global' }),
    create: () => f.http.post('/api/protected-mcp/connections').send({ definition: { name: 'created', transport: 'http', http: { url: 'https://example.test/mcp' } }, use: { scope: 'global' } }),
    'remove-connection': () => f.http.delete(`/api/protected-mcp/connections/${f.connection.id}`).send({ expectedRevision: 1 }),
  };
  const result = await operations[operation]();
  await f.mirror.flush();
  // Then exactly one additional mirror is requested and contains the resulting selection.
  expect(result.status).toBe(operation === 'create' ? 201 : 200);
  expect(f.push.mock.calls.length).toBe(before + 1);
  const names = Object.keys(f.sent.at(-1).documents[0].servers);
  expect(names).toEqual(operation === 'create' ? ['selected', 'created'] : []);
});
