import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readSelectionMirror, replaceSelectionMirror, selectionDocumentName } from './selection-mirror-documents.js';

const roots = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.promises.mkdtemp('/tmp/opencode/mcp-documents-');
  roots.push(root);
  return root;
}
const global = { version: 1, servers: { shared: { connection: 'pmcp_0123456789abcdef' } } };
const project = { version: 1, identity: 'git:/work/project/.git', servers: { specific: { connection: 'pmcp_fedcba9876543210', disabled: true } } };
const snapshot = (documents) => ({ version: 1, documents });

it('round-trips global and project documents and removes stale documents without replacing the watched directory', async () => {
  // Given an existing project file and an unrelated local file.
  const root = await fixture();
  await replaceSelectionMirror(root, snapshot([project]));
  const directory = path.join(root, 'mcp-protected');
  const inode = fs.statSync(directory).ino;
  await fs.promises.writeFile(path.join(directory, 'keep.txt'), 'unrelated');
  // When the complete replacement contains only the global selection.
  await replaceSelectionMirror(root, snapshot([global]));
  // Then stale project entries disappear and the watcher directory stays stable.
  expect(await readSelectionMirror(root)).toEqual(snapshot([global]));
  expect(fs.existsSync(path.join(directory, selectionDocumentName(project)))).toBe(false);
  expect(fs.statSync(directory).ino).toBe(inode);
  expect(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8')).toBe('unrelated');
  expect(fs.statSync(path.join(directory, 'global.json')).mode & 0o777).toBe(0o600);
});

it.each([
  { version: 1, servers: { 'bad/name': global.servers.shared } },
  { version: 1, servers: { ['a'.repeat(65)]: global.servers.shared } },
  { version: 1, servers: { bad: { connection: 'pmcp_0123456789abcdeF' } } },
  { version: 1, servers: { bad: { connection: 'pmcp_0123456789abcdef', secret: 'refused' } } },
  { ...project, identity: 'directory:relative' },
  { ...project, identity: 'git:/bad\nidentity' },
  { ...project, identity: 'directory:/bad\u0085identity' },
  { ...project, identity: `directory:/${'a'.repeat(4096)}` },
  { ...project, identity: 'unknown:/project' },
  { ...global, version: 2 },
])('refuses invalid documents before any persisted mutation %#', async (invalid) => {
  // Given a valid existing snapshot.
  const root = await fixture();
  await replaceSelectionMirror(root, snapshot([global]));
  // When any document in a replacement is invalid.
  await expect(replaceSelectionMirror(root, snapshot([project, invalid]))).rejects.toThrow();
  // Then the complete previous snapshot remains valid.
  expect(await readSelectionMirror(root)).toEqual(snapshot([global]));
});

it('refuses duplicate identities before removing existing documents', async () => {
  // Given a project document already mirrored.
  const root = await fixture();
  await replaceSelectionMirror(root, snapshot([project]));
  // When replacement ambiguously names a global document twice.
  await expect(replaceSelectionMirror(root, snapshot([global, global]))).rejects.toThrow();
  // Then the existing project selection remains.
  expect(await readSelectionMirror(root)).toEqual(snapshot([project]));
});

it('preserves the old file and stale documents when atomic rename fails and removes temporary files', async () => {
  // Given two valid documents and a failing filesystem commit.
  const root = await fixture();
  await replaceSelectionMirror(root, snapshot([global, project]));
  vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('synthetic'), { code: 'EIO' }));
  // When replacing the global file fails before the stale-removal phase.
  await expect(replaceSelectionMirror(root, snapshot([{ ...global, servers: {} }]))).rejects.toThrow();
  // Then readers still see complete old documents and no temporary write.
  expect(await readSelectionMirror(root)).toEqual(snapshot([global, project]));
  expect(fs.readdirSync(path.join(root, 'mcp-protected')).sort()).toEqual(['global.json', selectionDocumentName(project)]);
});

it('refuses a project file whose filename does not match its identity', async () => {
  // Given a corrupt owner document under the wrong hashed name.
  const root = await fixture();
  const directory = path.join(root, 'mcp-protected');
  await fs.promises.mkdir(directory);
  await fs.promises.writeFile(path.join(directory, `project-${'a'.repeat(64)}.json`), JSON.stringify(project));
  // When preparing an authoritative snapshot.
  const read = readSelectionMirror(root);
  // Then corruption is a failure, never an empty replacement.
  await expect(read).rejects.toThrow();
});
