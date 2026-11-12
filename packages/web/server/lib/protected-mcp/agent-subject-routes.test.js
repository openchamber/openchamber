import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { registerProtectedMcpRoutes } from './routes.js';
import { createProtectedSelectionStore } from './selections.js';
import { createAdminSocketClient } from './test-support/admin-socket-client.js';
import { startService } from './test-support/fixtures.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

it.each(['put', 'delete-selection', 'create', 'delete-connection'])('keeps %s successful when the agent push fails', async (operation) => {
  // Given a healthy connection service with an occupied subject socket path.
  const f = await startService();
  cleanups.push(f.close);
  const admin = createAdminSocketClient(f.adminSocketPath);
  const { connection } = await admin.create({ name: 'existing', transport: 'http', http: { url: 'https://example.test/mcp' } });
  const directory = path.join(path.dirname(f.engineSocketPath), 'subjects', 'agent');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'engine.sock'), 'occupied');
  const dataDir = path.join(f.root, 'data');
  const selections = createProtectedSelectionStore({ dataDir });
  await selections.set({ scope: 'global', name: 'existing', connection: connection.id });
  const clientConfigPath = path.join(f.root, 'client.json');
  await fs.writeFile(clientConfigPath, JSON.stringify({ version: 1, socket: f.engineSocketPath, adminSocket: f.adminSocketPath, relay: ['/relay'] }));
  let warned;
  const warning = () => new Promise((resolve) => { warned = resolve; });
  const startupWarning = warning();
  const logs = [];
  vi.spyOn(console, 'warn').mockImplementation((...args) => { logs.push(args); warned(); });
  const app = express();
  registerProtectedMcpRoutes(app, { dataDir, resolveOptionalProjectDirectory: async () => ({ directory: null }), isSupported: () => true, listOrdinaryMcpNames: () => [], env: { OPENCHAMBER_PROTECTED_MCP_CLIENT_CONFIG: clientConfigPath } });
  await startupWarning;
  const pushed = warning();
  const http = request(app);
  // When a real HTTP selection mutation succeeds before its subject push fails.
  const changes = {
    put: () => http.put('/api/protected-mcp/selections/alias').send({ scope: 'global', connection: connection.id }),
    'delete-selection': () => http.delete('/api/protected-mcp/selections/existing').send({ scope: 'global' }),
    create: () => http.post('/api/protected-mcp/connections').send({ definition: { name: 'new', transport: 'http', http: { url: 'https://example.test/mcp' } }, use: { scope: 'global' } }),
    'delete-connection': () => http.delete(`/api/protected-mcp/connections/${connection.id}`).send({ expectedRevision: 1 }),
  };
  const answer = await changes[operation]();
  await pushed;
  // Then the response and stored selection reflect the successful mutation; only a code is logged.
  expect(answer.status).toBe(operation === 'create' ? 201 : 200);
  const global = selections.read(null).global;
  if (operation === 'put') expect(global.alias).toEqual({ connection: connection.id });
  if (operation === 'create') expect(global.new).toEqual({ connection: answer.body.connection.id });
  if (operation.startsWith('delete')) expect(global).toEqual({});
  expect(logs).toEqual(Array.from({ length: 2 }, () => ['[protected-mcp] agent_subject_sync_failed', { code: 'internal_error' }]));
});
