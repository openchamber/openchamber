import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtectedSelectionStore } from './selections.js';
import { startHttpFixture } from './test-support/http-fixture.js';
import { registerProtectedMcpRoutes } from './routes.js';
import { readServiceState } from './service-client.js';
import { createAdminSocketClient } from './test-support/admin-socket-client.js';
import { SENTINEL, startService } from './test-support/fixtures.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function app({ platform = 'linux', supported = true, ordinary = [], clientConfig } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protected-mcp-routes-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const server = express();
  registerCommonRequestMiddleware(server, { express });
  registerProtectedMcpRoutes(server, {
    dataDir: path.join(root, 'data'),
    resolveOptionalProjectDirectory: async (req) => ({ directory: req.query.directory ?? null }),
    isSupported: () => supported,
    listOrdinaryMcpNames: () => ordinary,
    platform,
    env: { OPENCHAMBER_PROTECTED_MCP_CLIENT_CONFIG: clientConfig ?? path.join(root, 'missing.json') },
  });
  return { http: request(server), project, root, dataDir: path.join(root, 'data') };
}

async function runningService() {
  const fixture = await startService();
  cleanups.push(fixture.close);
  const admin = createAdminSocketClient(fixture.adminSocketPath);
  const created = await admin.apply({
    kind: 'create',
    definition: { name: 'remote', transport: 'http', http: { url: 'https://mcp.example.com/mcp?key=x', headers: { Authorization: { secret: 'token', prefix: 'Bearer ' } } } },
    secrets: { token: SENTINEL },
  });
  const clientConfig = path.join(fixture.root, 'client.json');
  await fs.writeFile(clientConfig, JSON.stringify({ version: 1, socket: fixture.engineSocketPath, adminSocket: fixture.adminSocketPath, relay: ['/usr/bin/node', '/relay.js'] }));
  return { fixture, connection: created.connection, clientConfig };
}

describe('protected MCP routes', () => {
  it('tells a missing service, an unsupported platform and an external OpenCode apart', async () => {
    const missing = await app();
    const status = await missing.http.get('/api/protected-mcp/status');
    expect(status.body.service).toEqual({ state: 'not_installed' });
    expect(status.body.host).toEqual({ supported: true, reason: null });

    const mac = await app({ platform: 'darwin' });
    expect((await mac.http.get('/api/protected-mcp/status')).body.service).toEqual({ state: 'unsupported_platform' });
    expect((await mac.http.put('/api/protected-mcp/selections/github').send({ scope: 'global', connection: 'pmcp_0123456789abcdef' })).status).toBe(501);

    const external = await app({ supported: false });
    const refused = await external.http.put('/api/protected-mcp/selections/github').send({ scope: 'global', connection: 'pmcp_0123456789abcdef' });
    expect(refused.status).toBe(501);
    expect(refused.body.code).toBe('external_opencode');
  });

  it('reports redacted connections and saves selections only for connections the service has', async () => {
    const { clientConfig, connection } = await runningService();
    const { http, project } = await app({ clientConfig });
    const status = await http.get('/api/protected-mcp/status');
    expect(status.body.service.state).toBe('available');
    expect(status.body.service.status.connections).toEqual([expect.objectContaining({
      id: connection.id, credential: 'stored', target: { kind: 'url', label: 'https://mcp.example.com/mcp' },
    })]);
    expect(status.text).not.toContain(SENTINEL);
    expect(status.text).not.toContain('key=x');

    const unknown = await http.put('/api/protected-mcp/selections/remote').send({ scope: 'global', connection: 'pmcp_ffffffffffffffff' });
    expect(unknown.status).toBe(404);
    const saved = await http.put(`/api/protected-mcp/selections/remote?directory=${encodeURIComponent(project)}`).send({ scope: 'project', connection: connection.id });
    expect(saved.status).toBe(200);
    expect(saved.body.selections.effective).toEqual({ remote: { connection: connection.id } });
    const removed = await http.delete(`/api/protected-mcp/selections/remote?directory=${encodeURIComponent(project)}`).send({ scope: 'project' });
    expect(removed.body.selections.effective).toEqual({});
  });

  it('refuses a name an ordinary MCP entry already uses and a project selection without a project', async () => {
    const { clientConfig, connection } = await runningService();
    const { http, project } = await app({ clientConfig, ordinary: ['remote'] });
    const taken = await http.put(`/api/protected-mcp/selections/remote?directory=${encodeURIComponent(project)}`).send({ scope: 'project', connection: connection.id });
    expect(taken.status).toBe(409);
    const noProject = await http.put('/api/protected-mcp/selections/other').send({ scope: 'project', connection: connection.id });
    expect(noProject.status).toBe(400);
  });

  it('refuses a selection while the service is down instead of saving a guess', async () => {
    const { clientConfig, connection, fixture } = await runningService();
    const { http } = await app({ clientConfig });
    await fixture.service.close();
    const answer = await http.put('/api/protected-mcp/selections/remote').send({ scope: 'global', connection: connection.id });
    expect(answer.status).toBe(503);
    expect((await readServiceState({ clientConfigPath: clientConfig })).state).toBe('unreachable');
  });
});

const definition = { name: 'created', transport: 'http', http: { url: 'https://example.test/mcp', headers: { Authorization: { secret: 'token' } } } };
const secret = 'pmcp-sentinel-5-never-in-engine';
const createBody = { definition, secrets: { token: secret }, use: { scope: 'project' } };
const endpoint = '/api/protected-mcp/connections';
async function filesBelow(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? filesBelow(path.join(directory, entry.name)) : fs.readFile(path.join(directory, entry.name), 'utf8')))).flat();
}
function captureOutput() {
  const output = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'assert', 'count', 'countReset', 'time', 'timeLog', 'timeEnd', 'group', 'groupCollapsed', 'groupEnd', 'clear']) vi.spyOn(console, method).mockImplementation((...args) => output.push(args));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  cleanups.push(() => vi.restoreAllMocks());
  return output;
}

describe('protected MCP administration boundary', () => {
  it.each([['denied', 400], ['changed', 409], ['exchange', 502], ['unavailable', 503]])('maps OAuth %s to a sanitized HTML callback with status %i', async (kind, status) => {
    // Given an actual pending sign-in and its broker-side failure condition.
    const upstream = await startHttpFixture({ oauth: true }); cleanups.push(upstream.close);
    const { fixture, clientConfig } = await runningService(); const admin = createAdminSocketClient(fixture.adminSocketPath);
    const { connection } = await admin.create({ name: 'oauth', transport: 'http', http: { url: upstream.url, oauth: { scopes: ['read'] } } });
    const { http } = await app({ clientConfig });
    const start = await http.post(`${endpoint}/${connection.id}/oauth`).send({ expectedRevision: connection.revision }).expect(200);
    const authorization = new URL(start.body.authorizationUrl);
    const query = new URLSearchParams({ state: authorization.searchParams.get('state'), code: secret });
    if (kind === 'denied') query.set('error', secret);
    if (kind === 'changed') await admin.apply({ kind: 'set-enabled', id: connection.id, expectedRevision: connection.revision, enabled: false });
    if (kind === 'unavailable') await fixture.service.close();
    // When the provider returns to OpenChamber.
    const answer = await http.get(`/api/protected-mcp/oauth/callback?${query}`);
    // Then the fixed outcome page never reflects a query value or sets a session cookie.
    expect(answer.status).toBe(status); expect(answer.type).toBe('text/html');
    expect(answer.text).not.toContain(secret); expect(answer.headers['set-cookie']).toBeUndefined();
  });
  it.each(['relative', 'https://example.test/no-state', 42])('refuses an invalid pasted address', async (address) => {
    // Given a supported host and an address without the callback capability.
    const { http } = await app();
    // When it is submitted as a fallback.
    const answer = await http.post('/api/protected-mcp/oauth/complete').send({ address });
    // Then it is rejected before any service call.
    expect(answer.status).toBe(400); expect(answer.body.code).toBe('invalid_request');
  });
  it('creates with project use without retaining a credential in answers, output or data files', async () => {
    const { clientConfig } = await runningService();
    const { http, project, dataDir } = await app({ clientConfig });
    const output = captureOutput();
    const answer = await http.post(`${endpoint}?directory=${encodeURIComponent(project)}`).send(createBody);
    expect(answer.status).toBe(201);
    expect(answer.body.selections.effective.created.connection).toBe(answer.body.connection.id);
    expect(JSON.stringify([answer.body, output, await filesBelow(dataDir)])).not.toContain(secret);
  });
  it.each(['ordinary', 'selection'])('refuses a %s name conflict before creating', async (kind) => {
    const { clientConfig, fixture, connection } = await runningService();
    const { http, project, dataDir } = await app({ clientConfig, ordinary: kind === 'ordinary' ? ['created'] : [] });
    if (kind === 'selection') await createProtectedSelectionStore({ dataDir }).set({ scope: 'project', directory: project, name: 'created', connection: connection.id });
    const answer = await http.post(`${endpoint}?directory=${encodeURIComponent(project)}`).send(createBody);
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe(kind === 'ordinary' ? 'name_in_use' : 'selection_name_in_use');
    expect(fixture.service.status().connections).toHaveLength(1);
  });
  it('rolls back creation when selection persistence fails', async () => {
    const { clientConfig, fixture } = await runningService();
    const { http, project, dataDir } = await app({ clientConfig });
    await fs.mkdir(dataDir, { mode: 0o500 });
    const answer = await http.post(`${endpoint}?directory=${encodeURIComponent(project)}`).send(createBody);
    expect(answer.status).toBe(500);
    expect(answer.body).toMatchObject({ code: 'selection_not_saved', connectionRemoved: true });
    expect(fixture.service.status().connections).toHaveLength(1);
  });
  it('requires a directory for project creation', async () => {
    const { clientConfig } = await runningService(); const { http } = await app({ clientConfig });
    const answer = await http.post(endpoint).send(createBody);
    expect(answer.status).toBe(400); expect(answer.body.code).toBe('project_required');
  });
  it.each(['update', 'enabled', 'revoke'])('maps %s to the broker operation', async (kind) => {
    const { clientConfig, connection } = await runningService(); const { http } = await app({ clientConfig });
    const url = `${endpoint}/${connection.id}`;
    const calls = { update: () => http.put(url).send({ expectedRevision: connection.revision, definition: { ...connection.editable, policy: { denyTools: ['blocked'] } } }), enabled: () => http.put(`${url}/enabled`).send({ expectedRevision: connection.revision, enabled: false }), revoke: () => http.post(`${url}/revoke`).send({ expectedRevision: connection.revision }) };
    const answer = await calls[kind]();
    expect(answer.status).toBe(200); expect(answer.body.connection.revision).toBe(connection.revision + 1);
    const read = await http.get(url).expect(200);
    if (kind === 'update') expect(read.body.connection.policy.denyTools).toEqual(['blocked']);
    if (kind === 'enabled') expect(read.body.connection.enabled).toBe(false);
    if (kind === 'revoke') expect(read.body.connection.credential).toBe('missing');
  });
  it('deletes the connection and all readable selections while reporting an unreadable project', async () => {
    const { clientConfig, connection } = await runningService(); const { http, project, dataDir } = await app({ clientConfig });
    const store = createProtectedSelectionStore({ dataDir });
    const second = `${project}-second`; await fs.mkdir(second);
    for (const [scope, directory] of [['global', null], ['project', project], ['project', second]]) await store.set({ scope, directory, name: 'alias', connection: connection.id });
    const bad = `project-${'a'.repeat(64)}.json`; await fs.writeFile(path.join(dataDir, 'mcp-protected', bad), '{bad');
    const answer = await http.delete(`${endpoint}/${connection.id}`).send({ expectedRevision: connection.revision });
    expect(answer.status).toBe(200); expect(answer.body).toMatchObject({ removed: true, selectionsNotUpdated: [bad] });
    expect(answer.body.selectionsRemoved).toHaveLength(3);
    expect(store.read(project).effective).toEqual({}); expect(store.read(second).effective).toEqual({});
    await http.get(`${endpoint}/${connection.id}`).expect(404);
  });
  it.each([endpoint, '/API/protected-mcp/connections'])('handles malformed JSON at %s without returning or logging its secret body', async (url) => {
    const { clientConfig } = await runningService(); const { http, dataDir } = await app({ clientConfig }); const output = captureOutput();
    const answer = await http.post(url).type('json').send(`{bad json ${secret}`);
    expect(answer.status).toBe(400); expect(answer.type).toBe('application/json'); expect(answer.body.code).toBe('invalid_request');
    expect(JSON.stringify([answer.text, output, await filesBelow(dataDir)])).not.toContain(secret);
  });
  it.each([0, 1024 * 1024 + 1])('refuses form OAuth completion with %i bytes of padding before consuming its state', async (size) => {
    // Given a real broker with a pending OAuth attempt.
    const upstream = await startHttpFixture({ oauth: true }); cleanups.push(upstream.close);
    const { fixture, clientConfig } = await runningService(); const admin = createAdminSocketClient(fixture.adminSocketPath);
    const { connection } = await admin.create({ name: 'form-oauth', transport: 'http', http: { url: upstream.url, oauth: { scopes: ['read'] } } });
    const started = await admin.oauthStart(connection.id, connection.revision, 'http://localhost/api/protected-mcp/oauth/callback');
    const address = `http://localhost/api/protected-mcp/oauth/callback?state=${new URL(started.authorizationUrl).searchParams.get('state')}&code=x`;
    const { http } = await app({ clientConfig });
    // When a form body reaches the production parser composition.
    const answer = await http.post('/api/protected-mcp/oauth/complete').type('form').send({ address, padding: 'x'.repeat(size) });
    // Then it is refused and the single-use state remains unconsumed.
    expect(answer.status).toBe(400); expect(answer.body.code).toBe('invalid_request');
    expect(await admin.oauthAttempt(started.attempt)).toEqual({ type: 'oauth-attempt', status: 'pending' });
  });
  it('preserves the project selection and broker list when global selections are unreadable', async () => {
    // Given a valid project selection hidden behind a corrupt global document.
    const { fixture, clientConfig, connection } = await runningService(); const admin = createAdminSocketClient(fixture.adminSocketPath);
    const { http, project, dataDir } = await app({ clientConfig });
    await createProtectedSelectionStore({ dataDir }).set({ scope: 'project', directory: project, name: 'created', connection: connection.id });
    const directory = path.join(dataDir, 'mcp-protected'); const projectFile = path.join(directory, (await fs.readdir(directory)).find((file) => file.startsWith('project-') && file.endsWith('.json')));
    const before = await fs.readFile(projectFile); const connections = (await admin.list()).connections;
    await fs.writeFile(path.join(directory, 'global.json'), '{corrupt');
    // When creation cannot establish whether the selection name is available.
    const answer = await http.post(`${endpoint}?directory=${encodeURIComponent(project)}`).send(createBody);
    // Then it refuses before changing either persisted selections or broker connections.
    expect(answer.status).toBe(500); expect(answer.body).toEqual({ code: 'selections_unreadable', error: 'The protected MCP selections could not be read' });
    expect((await admin.list()).connections).toEqual(connections); expect(await fs.readFile(projectFile)).toEqual(before);
  });
  it('refuses oversized bodies with a sanitized error', async () => {
    const { http } = await app(); const answer = await http.post(endpoint).send({ value: 'x'.repeat(1024 * 1024) });
    expect(answer.status).toBe(413); expect(answer.body.code).toBe('body_too_large');
  });
  it.each(['missing', 'not-listening'])('reports an unavailable %s admin socket', async (kind) => {
    const { clientConfig } = await runningService();
    if (kind === 'not-listening') { const config = JSON.parse(await fs.readFile(clientConfig, 'utf8')); config.adminSocket += '.absent'; await fs.writeFile(clientConfig, JSON.stringify(config)); }
    const { http } = await app({ clientConfig: kind === 'missing' ? undefined : clientConfig });
    const answer = await http.get(`${endpoint}/pmcp_0123456789abcdef`);
    expect(answer.status).toBe(503); expect(answer.body.code).toBe('service_unavailable');
  });
  it('uses the forwarded origin and completes browser and pasted OAuth addresses once', async () => {
    const upstream = await startHttpFixture({ oauth: true }); cleanups.push(upstream.close);
    const { fixture, clientConfig } = await runningService(); const admin = createAdminSocketClient(fixture.adminSocketPath);
    const { connection } = await admin.create({ name: 'oauth', transport: 'http', http: { url: upstream.url, oauth: { scopes: ['read'] } } });
    const { http } = await app({ clientConfig }); const url = `${endpoint}/${connection.id}/oauth`;
    const start = await http.post(url).set('Host', 'example.test:8443').set('x-forwarded-proto', 'https').send({ expectedRevision: connection.revision }).expect(200);
    expect(new URL(start.body.authorizationUrl).searchParams.get('redirect_uri')).toBe('https://example.test:8443/api/protected-mcp/oauth/callback');
    const redirect = await fetch(start.body.authorizationUrl, { redirect: 'manual' }); const address = new URL(redirect.headers.get('location'));
    const callback = await http.get(address.pathname + address.search).expect(200);
    expect(callback.type).toBe('text/html'); expect(callback.text).toContain('Signed in'); expect(callback.headers['cache-control']).toBe('no-store');
    await http.get(`/api/protected-mcp/oauth/attempts/${start.body.attempt}`).expect(200, { status: 'done', outcome: 'authorized' });
    const replay = await http.get(address.pathname + address.search).expect(400); expect(replay.headers['set-cookie']).toBeUndefined();
    const bogus = await http.get('/api/protected-mcp/oauth/callback?state=bogus&code=x').expect(400); expect(bogus.type).toBe('text/html');
    const again = await http.post(url).send({ expectedRevision: connection.revision }).expect(200);
    const next = await fetch(again.body.authorizationUrl, { redirect: 'manual' });
    const pasted = await http.post('/api/protected-mcp/oauth/complete').send({ address: next.headers.get('location') }).expect(200);
    expect(pasted.body.outcome).toBe('authorized');
  });
});
