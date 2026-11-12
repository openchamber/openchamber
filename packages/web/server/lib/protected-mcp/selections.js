import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ensureLocalMcpDirectory, writeLocalMcpFile } from '../opencode/mcp-local-files.js';
import { createLocalMcpReader } from '../opencode/mcp-local-reader.js';
import { isBoolean, isPlainObject, isString } from '../shared/guards.js';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { protectedSelectionReader } from './selections-reader.js';
import { assertSelectionMirrorWriteFits, projectIdentitySchema, selectionDocumentName } from './selection-mirror-documents.js';

/**
 * Which protected connections OpenCode starts, for every project or for one.
 * A selection holds an MCP name and a connection id. The front door pushes
 * their enabled union to the service's shared agent subject after route writes.
 */
export function createProtectedSelectionStore({ dataDir, resolveProjectIdentity, enforceMirrorCapacity = false }) {
  const local = createLocalMcpReader(dataDir);
  const reader = protectedSelectionReader(dataDir, { fs, path, isBoolean, isPlainObject, isString });
  const globalFile = path.join(dataDir, 'mcp-protected', 'global.json');
  const resolveRemoteTarget = async (directory) => {
    const identity = projectIdentitySchema.parse(await resolveProjectIdentity(directory));
    return { global: globalFile, project: path.join(path.dirname(globalFile), selectionDocumentName({ identity })), identity };
  };

  const read = (directory) => {
    if (!directory) {
      const global = reader.readDocument(globalFile, null).servers;
      const effective = Object.fromEntries(Object.entries(global).filter(([, entry]) => !entry.disabled));
      return { global, project: null, effective };
    }
    if (resolveProjectIdentity) return resolveRemoteTarget(directory).then((target) => reader.readTarget(target));
    return reader.readTarget(reader.resolve(local.resolve(directory)));
  };

  const writeDocument = (file, identity, servers) => {
    const document = identity === null ? { version: 1, servers } : { version: 1, identity, servers };
    return writeLocalMcpFile(file, `${JSON.stringify(document, null, 2)}\n`);
  };

  const mutate = async ({ scope, directory }, change) => {
    let file = globalFile;
    let identity = null;
    if (scope === 'project') {
      const target = resolveProjectIdentity ? await resolveRemoteTarget(directory) : reader.resolve(local.resolve(directory));
      file = target.project;
      identity = target.identity;
    }
    await ensureLocalMcpDirectory(path.dirname(file));
    const commit = () => withSourceControlFileLock(`${file}.lock`, async () => {
      const { servers } = reader.readDocument(file, identity);
      change(servers);
      if (enforceMirrorCapacity) {
        await assertSelectionMirrorWriteFits(dataDir, identity === null ? { version: 1, servers } : { version: 1, identity, servers });
      }
      await writeDocument(file, identity, servers);
    });
    return enforceMirrorCapacity
      ? withSourceControlFileLock(path.join(dataDir, 'mcp-protected-capacity.lock'), commit)
      : commit();
  };

  return {
    read,
    async set({ scope, directory, name, connection, disabled = false }) {
      reader.validateName(name);
      const entry = reader.parseEntry(disabled ? { connection, disabled: true } : { connection });
      await mutate({ scope, directory }, (servers) => {
        servers[name] = entry;
      });
    },
    async remove({ scope, directory, name }) {
      reader.validateName(name);
      await mutate({ scope, directory }, (servers) => {
        delete servers[name];
      });
    },
    async removeConnection(connectionId) {
      const removed = [];
      const notUpdated = [];
      const directory = path.dirname(globalFile);
      let files;
      try { files = await fs.promises.readdir(directory); }
      catch (error) { if (error.code === 'ENOENT') return { removed, notUpdated }; throw error; }
      for (const name of files.sort().filter((name) => name === 'global.json' || /^project-[0-9a-f]{64}\.json$/.test(name))) {
        const file = path.join(directory, name);
        try {
          await withSourceControlFileLock(`${file}.lock`, async () => {
            const identity = name === 'global.json' ? null : z.object({ identity: z.string().min(1) }).parse(JSON.parse(await fs.promises.readFile(file, 'utf8'))).identity;
            const { servers } = reader.readDocument(file, identity);
            const names = Object.keys(servers).filter((key) => servers[key].connection === connectionId);
            if (names.length === 0) return;
            for (const key of names) delete servers[key];
            await writeDocument(file, identity, servers);
            removed.push(name);
          });
        } catch { notUpdated.push(name); }
      }
      return { removed, notUpdated };
    },
  };
}
