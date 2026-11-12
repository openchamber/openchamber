import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createProtectedMcpMirror } from './protected-mcp.js';
import { createProtectedSelectionStore } from '../protected-mcp/selections.js';
import { agentSubjectConnections } from '../protected-mcp/agent-subject.js';
import { readSelectionMirror } from '../protected-mcp/selection-mirror-documents.js';
import * as documents from '../protected-mcp/selection-mirror-documents.js';

const roots = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const dataDir = await fs.mkdtemp('/tmp/opencode/mcp-push-');
  roots.push(dataDir);
  const identity = 'directory:/agent/project';
  const store = createProtectedSelectionStore({ dataDir, resolveProjectIdentity: async () => identity });
  return { dataDir, identity, store };
}
const first = 'pmcp_0123456789abcdef';
const second = 'pmcp_fedcba9876543210';

it('resolves project scope asynchronously without accessing a project on the front door', async () => {
  // Given an agent identity for a directory absent on the front door.
  const f = await fixture();
  // When a project selection is saved through the injected resolver.
  await f.store.set({ scope: 'project', directory: '/absent-on-front-door', name: 'project', connection: first });
  // Then subsequent reads and the owner subject union use that selection.
  expect((await f.store.read('/absent-on-front-door')).effective).toEqual({ project: { connection: first } });
  expect(agentSubjectConnections(f.dataDir)).toEqual([first]);
});

it('keeps the single-account read synchronous', async () => {
  // Given an ordinary local selection store.
  const f = await fixture();
  const store = createProtectedSelectionStore({ dataDir: f.dataDir });
  await store.set({ scope: 'project', directory: f.dataDir, name: 'local', connection: first });
  // When the existing read API is called.
  const result = store.read(f.dataDir);
  // Then it still returns the document directly.
  expect(result.effective).toEqual({ local: { connection: first } });
});

it.each(['git:relative', 'directory:/bad\npath', 'unknown:/project'])('refuses invalid asynchronous identities before writes %#', async (identity) => {
  // Given an untrusted invalid resolver answer.
  const f = await fixture();
  const store = createProtectedSelectionStore({ dataDir: f.dataDir, resolveProjectIdentity: async () => identity });
  // When project persistence is requested.
  await expect(store.set({ scope: 'project', directory: '/project', name: 'project', connection: first })).rejects.toThrow();
  // Then no document is written.
  expect(await readSelectionMirror(f.dataDir)).toEqual({ version: 1, documents: [] });
});

it('serializes pushes and sends the latest owner snapshot after a slow older push', async () => {
  // Given a held first send and a newer owner selection.
  const f = await fixture();
  await f.store.set({ scope: 'global', name: 'global', connection: first });
  // Real file content with immediate completion makes overlapping sends observable
  // at a microtask checkpoint, independently of filesystem scheduling.
  vi.spyOn(documents, 'readSelectionMirror').mockImplementation(async () => ({
    version: 1, documents: [JSON.parse(fsSync.readFileSync(path.join(f.dataDir, 'mcp-protected/global.json'), 'utf8'))],
  }));
  const sent = [];
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const mirror = createProtectedMcpMirror({ dataDir: f.dataDir, upstream: { json: async (_route, { body }) => {
    sent.push(JSON.parse(body));
    if (sent.length === 1) { entered(); await held; }
    return { documents: [{ servers: { injected: { connection: second } } }] };
  } } });
  const older = mirror.push();
  await started;
  await f.store.set({ scope: 'global', name: 'global', connection: second });
  // When another push queues while the older send is held.
  const newer = mirror.push();
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  release();
  await Promise.all([older, newer]);
  // Then the final send has the current selection and cannot be overtaken by the old one.
  expect(sent.map((value) => value.documents[0].servers.global.connection)).toEqual([first, second]);
});

it('logs only a fixed code after failure and retries current selections on the next push', async () => {
  // Given a transport that fails once with agent-controlled error text.
  const f = await fixture();
  await f.store.set({ scope: 'global', name: 'global', connection: first });
  const logs = [];
  const sent = [];
  let fail = true;
  const mirror = createProtectedMcpMirror({ dataDir: f.dataDir, log: (code) => logs.push(code), upstream: { json: async (_route, { body }) => {
    if (fail) { fail = false; throw new Error('agent-controlled text'); }
    sent.push(JSON.parse(body));
  } } });
  await mirror.push();
  // When the next selection change asks for synchronization.
  await f.store.set({ scope: 'global', name: 'new', connection: second });
  await mirror.push();
  // Then the owner save survived and the retry sends its current complete state.
  expect(logs).toEqual(['selection_mirror_unavailable']);
  expect(sent[0]).toEqual(await readSelectionMirror(f.dataDir));
});

it('ignores hostile agent answers when computing the service subject', async () => {
  // Given one owner-selected id and an agent answer claiming another.
  const f = await fixture();
  await f.store.set({ scope: 'global', name: 'global', connection: first });
  const mirror = createProtectedMcpMirror({ dataDir: f.dataDir, upstream: { json: async () => ({ connections: [second], subject: 'agent' }) } });
  // When the mirror completes.
  await mirror.push();
  // Then authority still comes exclusively from the owner document.
  expect(agentSubjectConnections(f.dataDir)).toEqual([first]);
});

it('does not send a destructive empty snapshot when an owner document is malformed', async () => {
  // Given a corrupt persisted selection.
  const f = await fixture();
  await fs.mkdir(path.join(f.dataDir, 'mcp-protected'));
  await fs.writeFile(path.join(f.dataDir, 'mcp-protected/global.json'), '{invalid');
  const sent = [];
  const mirror = createProtectedMcpMirror({ dataDir: f.dataDir, log: () => {}, upstream: { json: async (...args) => sent.push(args) } });
  // When a mirror is requested.
  await mirror.push();
  // Then the previous agent snapshot is left untouched.
  expect(sent).toEqual([]);
});
