import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { agentSubjectConnections, createAgentSubjectSync } from './agent-subject.js';
import { createProtectedSelectionStore } from './selections.js';
import { listSubjects, removeSubject, setSubject } from './service-client.js';
import { createAdminSocketClient } from './test-support/admin-socket-client.js';
import { startService } from './test-support/fixtures.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const f = await startService();
  cleanups.push(f.close);
  const dataDir = path.join(f.root, 'data');
  const clientConfigPath = path.join(f.root, 'client.json');
  await fs.writeFile(clientConfigPath, JSON.stringify({ version: 1, socket: f.engineSocketPath, adminSocket: f.adminSocketPath, relay: ['/relay'] }));
  const admin = createAdminSocketClient(f.adminSocketPath);
  const connections = [];
  for (const name of ['global', 'project', 'other', 'disabled']) {
    const { connection } = await admin.create({ name, transport: 'http', http: { url: 'https://example.test/mcp' } });
    connections.push(connection.id);
  }
  const log = [];
  return { ...f, dataDir, connections, selections: createProtectedSelectionStore({ dataDir }), clientConfigPath, log, sync: createAgentSubjectSync({ dataDir, clientConfigPath: () => clientConfigPath, log: (code) => log.push(code) }) };
}

it('unions enabled selections in global and every project, including unopened projects', async () => {
  // Given duplicate ids, a disabled entry and a project overriding a global name.
  const f = await setup();
  const [global, project, other, disabled] = f.connections;
  const first = path.join(f.root, 'first');
  const second = path.join(f.root, 'second');
  await fs.mkdir(first); await fs.mkdir(second);
  await f.selections.set({ scope: 'global', name: 'shared', connection: global });
  await f.selections.set({ scope: 'global', name: 'off', connection: disabled, disabled: true });
  await f.selections.set({ scope: 'project', directory: first, name: 'shared', connection: project });
  await f.selections.set({ scope: 'project', directory: first, name: 'off', connection: disabled, disabled: true });
  await f.selections.set({ scope: 'project', directory: second, name: 'shared', connection: global, disabled: true });
  await f.selections.set({ scope: 'project', directory: second, name: 'alias', connection: other });
  await f.selections.set({ scope: 'project', directory: second, name: 'duplicate', connection: project });
  // When authority is computed for all common sessions.
  const connections = agentSubjectConnections(f.dataDir);
  // Then each enabled connection appears once; a project's disable cannot revoke global use elsewhere.
  expect(connections).toEqual([global, project, other].sort());
});

it('pushes the persisted union at startup when the service is reachable', async () => {
  // Given a selection saved before this server starts.
  const f = await setup();
  await f.selections.set({ scope: 'global', name: 'selected', connection: f.connections[0] });
  // When startup synchronization runs.
  await f.sync.start();
  // Then the admin socket owns the new agent grant.
  expect(await listSubjects({ clientConfigPath: f.clientConfigPath })).toEqual({ ok: true, answer: { type: 'subjects', subjects: [{ subject: 'agent', connections: [f.connections[0]] }] } });
});

it('preserves existing authority when a selection document is unreadable', async () => {
  // Given an existing grant and a corrupt project document.
  const f = await setup();
  await setSubject('agent', [f.connections[0]], { clientConfigPath: f.clientConfigPath });
  await fs.mkdir(path.join(f.dataDir, 'mcp-protected'), { recursive: true });
  await fs.writeFile(path.join(f.dataDir, 'mcp-protected', `project-${'a'.repeat(64)}.json`), '{corrupt');
  // When a push cannot compute a complete union.
  await f.sync.push();
  // Then failure is logged by code and the previous grant remains valid.
  expect(f.log).toEqual(['selections_unreadable']);
  expect((await listSubjects({ clientConfigPath: f.clientConfigPath })).answer.subjects).toEqual([{ subject: 'agent', connections: [f.connections[0]] }]);
});

it('removes subjects through the bounded client and retains service refusal mapping', async () => {
  // Given one agent grant.
  const f = await setup();
  await setSubject('agent', [], { clientConfigPath: f.clientConfigPath });
  // When removal crosses the client boundary.
  const result = await removeSubject('agent', { clientConfigPath: f.clientConfigPath });
  // Then the typed answer and subsequent unknown-id refusal survive serialization.
  expect(result).toEqual({ ok: true, answer: { type: 'subject-removed', subject: 'agent' } });
  expect(await setSubject('agent', ['pmcp_ffffffffffffffff'], { clientConfigPath: f.clientConfigPath })).toMatchObject({ ok: false, code: 'unknown_connection', status: 404 });
});

it('logs push failure without rejecting the caller when the service is down', async () => {
  // Given a service that has stopped accepting requests.
  const f = await setup();
  cleanups.push(() => f.sync.stop());
  await f.service.close();
  // When a selection change requests a push.
  const answer = await f.sync.push();
  // Then the failed side effect is reported without undoing selections, and to the caller.
  expect(f.log).toEqual(['service_unavailable']);
  expect(answer).toEqual({ ok: false, code: 'service_unavailable' });
});

it('pushes a removal again until the service takes it', async () => {
  // Given the agents allowed one connection, and a service the front door cannot reach for now.
  const f = await setup();
  await setSubject('agent', [f.connections[0]], { clientConfigPath: f.clientConfigPath });
  let reachable = false;
  const sync = createAgentSubjectSync({ dataDir: f.dataDir, clientConfigPath: () => (reachable ? f.clientConfigPath : path.join(f.root, 'missing.json')), log: () => {}, retryMs: 20 });
  cleanups.push(() => sync.stop());
  // When the owner's change, which selects nothing, cannot be pushed.
  expect((await sync.push()).ok).toBe(false);
  // Then once the service is reachable again the agents lose the connection, with no further change.
  reachable = true;
  await expect.poll(async () => (await listSubjects({ clientConfigPath: f.clientConfigPath })).answer.subjects, { timeout: 5000 })
    .toEqual([{ subject: 'agent', connections: [] }]);
});

it('pushes an empty set when no selection files exist', async () => {
  // Given obsolete authority with no saved selections.
  const f = await setup();
  await setSubject('agent', [f.connections[0]], { clientConfigPath: f.clientConfigPath });
  // When the empty authoritative union is pushed.
  await f.sync.push();
  // Then the old authority is revoked.
  expect((await listSubjects({ clientConfigPath: f.clientConfigPath })).answer.subjects).toEqual([{ subject: 'agent', connections: [] }]);
});
