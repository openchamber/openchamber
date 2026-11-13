import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { createProtectedSelectionStore } from './selections.js';
import { registerProtectedMcpRoutes } from './routes.js';
import { assertSelectionMirrorWriteFits, MAX_SELECTION_MIRROR_BYTES, readSelectionMirror, replaceSelectionMirror, selectionDocumentName } from './selection-mirror-documents.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const connection = 'pmcp_0123456789abcdef';
const servers = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`server${index}`, { connection }]));
const snapshot = (documents) => ({ version: 1, documents });
async function fixture() {
  const dataDir = await fs.mkdtemp('/tmp/opencode/mcp-capacity-');
  roots.push(dataDir);
  const store = createProtectedSelectionStore({ dataDir, enforceMirrorCapacity: true, resolveProjectIdentity: async (directory) => `directory:${directory}` });
  return { dataDir, store };
}

it('refuses a 257th front-door selection before changing the saved document', async () => {
  // Given a full valid global document.
  const f = await fixture();
  await replaceSelectionMirror(f.dataDir, snapshot([{ version: 1, servers }]));
  // When another entry would exceed the mirror contract.
  const result = f.store.set({ scope: 'global', name: 'extra', connection });
  // Then the save fails and the previously mirrored document remains intact.
  await expect(result).rejects.toMatchObject({ code: 'PROTECTED_SELECTION_CAPACITY' });
  expect(await readSelectionMirror(f.dataDir)).toEqual(snapshot([{ version: 1, servers }]));
});

it('keeps the single-account store free of front-door snapshot limits', async () => {
  // Given a single-account store with 256 entries.
  const f = await fixture();
  await replaceSelectionMirror(f.dataDir, snapshot([{ version: 1, servers }]));
  const local = createProtectedSelectionStore({ dataDir: f.dataDir });
  // When the existing API saves another selection.
  await local.set({ scope: 'global', name: 'extra', connection });
  // Then the single-account format and behavior remain unchanged.
  expect(Object.keys(local.read(null).global)).toHaveLength(257);
});

it('serializes capacity checks across different project writes', async () => {
  // Given room for one more nonempty project document.
  const f = await fixture();
  await replaceSelectionMirror(f.dataDir, snapshot(Array.from({ length: 1023 }, (_, index) => ({ version: 1, identity: `directory:/project${index}`, servers: { selected: { connection } } }))));
  // When two projects concurrently try to consume the last slot.
  const results = await Promise.allSettled(['/next-one', '/next-two'].map((directory) => f.store.set({ scope: 'project', directory, name: 'selected', connection })));
  // Then exactly one save succeeds and every successful save still fits the mirror.
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect((await readSelectionMirror(f.dataDir)).documents).toHaveLength(1024);
});

it('omits empty project documents from capacity and authoritative snapshots', async () => {
  // Given accumulated empty project documents left by ordinary removals.
  const f = await fixture();
  await replaceSelectionMirror(f.dataDir, snapshot(Array.from({ length: 1024 }, (_, index) => ({ version: 1, identity: `directory:/empty${index}`, servers: {} }))));
  // When a real global selection is saved.
  await f.store.set({ scope: 'global', name: 'selected', connection });
  // Then empty project documents do not exhaust document slots or reach the agent.
  expect(await readSelectionMirror(f.dataDir)).toEqual(snapshot([{ version: 1, servers: { selected: { connection } } }]));
});

it('refuses a projected snapshot exceeding the transport byte limit', async () => {
  // Given the largest whole-document fixture that fits on the wire.
  const f = await fixture();
  const largeServers = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`${'a'.repeat(55)}${index}`, { connection }]));
  const documents = [];
  let extra;
  for (let index = 0; index < 1024; index += 1) {
    const document = { version: 1, identity: `directory:/large${index}`, servers: largeServers };
    if (Buffer.byteLength(JSON.stringify(snapshot([...documents, document]))) > MAX_SELECTION_MIRROR_BYTES) { extra = document; break; }
    documents.push(document);
  }
  await replaceSelectionMirror(f.dataDir, snapshot(documents));
  // When the next projected write would exceed 1 MiB.
  const result = assertSelectionMirrorWriteFits(f.dataDir, extra);
  // Then it fails before any new file can be committed.
  await expect(result).rejects.toMatchObject({ code: 'PROTECTED_SELECTION_CAPACITY' });
  await expect(fs.stat(path.join(f.dataDir, 'mcp-protected', selectionDocumentName(extra)))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('returns a capacity refusal through front-door HTTP without changing owner selections', async () => {
  // Given front-door routes and a full global document, with the service absent.
  const f = await fixture();
  await replaceSelectionMirror(f.dataDir, snapshot([{ version: 1, servers }]));
  const app = express();
  registerProtectedMcpRoutes(app, {
    dataDir: f.dataDir, isSupported: () => true, listOrdinaryMcpNames: () => [],
    resolveOptionalProjectDirectory: async () => ({ directory: null }),
    selectionMirror: { push: async () => {} },
    env: { OPENCHAMBER_PROTECTED_MCP_CLIENT_CONFIG: path.join(f.dataDir, 'missing.json') },
  });
  // When a disabled selection would overfill the document without needing a service read.
  const result = await request(app).put('/api/protected-mcp/selections/extra').send({ scope: 'global', connection, disabled: true });
  // Then the route refuses the save and preserves the previous selection set.
  expect(result.status).toBe(413);
  expect(await readSelectionMirror(f.dataDir)).toEqual(snapshot([{ version: 1, servers }]));
});
