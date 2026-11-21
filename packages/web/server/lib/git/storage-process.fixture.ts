import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { createContributorProvenanceStore } from './contributor-provenance-storage.js';
import { createManagedSshCredentialStore } from './ssh-credential-storage.js';
import { createGitIdentityStore } from './identity-storage.js';
import type { PathOrFileDescriptor } from 'node:fs';
import type { ProvenanceGitPaths } from './contributor-provenance-storage.js';
import type { JsonValue } from '../shared/json-values.js';

const [kind, filePath] = process.argv.slice(2);
const fsImpl = {
  ...fs,
  open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (args[0] !== filePath) return handle;
    const readFile = handle.readFile.bind(handle);
    return Object.assign(handle, {
      readFile: async (...readArgs: Parameters<typeof readFile>) => {
        const result = await readFile(...readArgs);
        await delay(30);
        return result;
      },
    });
  },
};
function readFileSync(path: PathOrFileDescriptor, options?: { encoding?: null | undefined; flag?: string | undefined } | null): NonSharedBuffer;
function readFileSync(path: PathOrFileDescriptor, options: { encoding: BufferEncoding; flag?: string | undefined } | BufferEncoding): string;
function readFileSync(...args: Parameters<typeof fsSync.readFileSync>): ReturnType<typeof fsSync.readFileSync>;
function readFileSync(...args: Parameters<typeof fsSync.readFileSync>) {
  const result = fsSync.readFileSync(...args);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  return result;
}
const syncFsImpl = {
  ...fsSync,
  constants: fsSync.constants,
  readFileSync,
};
type FixtureStoreOptions = Pick<NonNullable<Parameters<typeof createManagedSshCredentialStore>[0]>, 'filePath' | 'lockWaitMs'>;
const options: FixtureStoreOptions = { lockWaitMs: 500 };
if (filePath !== undefined) options.filePath = filePath;
const stores = {
  provenance: () => createContributorProvenanceStore({
    ...options,
    fsImpl,
    resolveRepositoryIdentity: async () => ({ supported: true, repositoryId: 'repo_one' }),
    resolveGitPaths: async (directory) => {
      const paths: ProvenanceGitPaths = { supported: true, bare: false };
      if (directory !== undefined) paths.gitDirectory = directory;
      return paths;
    },
  }),
  ssh: () => createManagedSshCredentialStore({ ...options, fsImpl }),
  identity: () => createGitIdentityStore({ ...options, fsImpl: syncFsImpl }),
};
type FixtureStoreFactory = typeof stores[keyof typeof stores];
const storeFactory = (factories: Record<string, FixtureStoreFactory>, name: string | undefined) =>
  factories[String(name)]?.();
const store = storeFactory(stores, kind);
const releases = new Map<string, () => void>();

interface StorageProcessMessage {
  id: string;
  method: string;
  args?: JsonValue[];
}
const send = process.send?.bind(process);
if (!send) throw new TypeError('Storage fixture requires an IPC channel');

const hasErrorFields = (value: unknown): value is { code?: unknown; status?: unknown; message?: unknown; current?: unknown } =>
  value !== null && value !== undefined;
const hasStoreField = (value: unknown): value is Record<string, unknown> => value !== null && value !== undefined;
const runMethod = <Target>(target: Target, method: string, args: JsonValue[]) => {
  if (!hasStoreField(target)) throw new TypeError(`Cannot read properties of ${target} (reading '${method}')`);
  const handler = target[method];
  if (!(handler instanceof Function)) throw new TypeError('store[method] is not a function');
  return Function.prototype.apply.call(handler, target, [...args]);
};

process.on('message', async ({ id, method, args = [] }: StorageProcessMessage) => {
  try {
    let value;
    if (method === 'hold-lock') {
      value = await withSourceControlFileLock(`${filePath}.lock`, async () => {
        send({ event: 'locked', id });
        await new Promise<void>((resolve) => releases.set(id, resolve));
      });
    } else {
      value = await runMethod(store, method, args);
    }
    send({ id, ok: true, value });
  } catch (error) {
    if (!hasErrorFields(error)) throw new TypeError(`Cannot read properties of ${error} (reading 'code')`);
    send({
      id,
      ok: false,
      error: { code: error.code, status: error.status, message: error.message, current: error.current },
    });
  } finally {
    releases.delete(id);
  }
});
send({ event: 'ready' });
