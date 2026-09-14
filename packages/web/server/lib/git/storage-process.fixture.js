import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { createSystemPushAcknowledgementStore } from './system-push-acknowledgement-storage.js';
import { createContributorProvenanceStore } from './contributor-provenance-storage.js';
import { createManagedSshCredentialStore } from './ssh-credential-storage.js';
import { createGitIdentityStore } from './identity-storage.js';

const [kind, filePath] = process.argv.slice(2);
const fsImpl = {
  ...fs,
  open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[0] !== filePath) return handle;
    const readFile = handle.readFile.bind(handle);
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      close: (...closeArgs) => handle.close(...closeArgs),
      readFile: async (...readArgs) => {
        const result = await readFile(...readArgs);
        await delay(30);
        return result;
      },
    };
  },
};
const syncFsImpl = {
  ...fsSync,
  constants: fsSync.constants,
  readFileSync: (...args) => {
    const result = fsSync.readFileSync(...args);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    return result;
  },
};
const options = { filePath, lockWaitMs: 500 };
const stores = {
  acknowledgement: () => createSystemPushAcknowledgementStore({ ...options, fsImpl }),
  provenance: () => createContributorProvenanceStore({
    ...options,
    fsImpl,
    resolveRepositoryIdentity: async () => ({ supported: true, repositoryId: 'repo_one' }),
    resolveGitPaths: async (directory) => ({ supported: true, bare: false, gitDirectory: directory }),
  }),
  ssh: () => createManagedSshCredentialStore({ ...options, fsImpl }),
  identity: () => createGitIdentityStore({ ...options, fsImpl: syncFsImpl }),
};
const store = stores[kind]?.();
const releases = new Map();

process.on('message', async ({ id, method, args = [] }) => {
  try {
    let value;
    if (method === 'hold-lock') {
      value = await withSourceControlFileLock(`${filePath}.lock`, async () => {
        process.send({ event: 'locked', id });
        await new Promise((resolve) => releases.set(id, resolve));
      });
    } else {
      value = await store[method](...args);
    }
    process.send({ id, ok: true, value });
  } catch (error) {
    process.send({
      id,
      ok: false,
      error: { code: error.code, status: error.status, message: error.message, current: error.current },
    });
  } finally {
    releases.delete(id);
  }
});
process.send({ event: 'ready' });
