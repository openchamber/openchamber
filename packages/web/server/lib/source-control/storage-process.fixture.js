import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createBindingStore } from './binding-storage.js';
import { createMutationStore } from './mutation-storage.js';
import { createSourceControlAuditStore } from './audit-storage.js';
import { createMutationExecutor } from './mutation-executor.js';
import { withSourceControlFileLock } from './file-lock.js';

const [kind, filePath] = process.argv.slice(2);
const options = { filePath, lockWaitMs: 300, fsImpl: { ...fs, readFile: async (...args) => {
  // Widen snapshot races without putting a barrier inside the transaction.
  try { return await fs.readFile(...args); }
  finally { await delay(30); }
} } };
const stores = {
  binding: () => createBindingStore(options),
  mutation: () => createMutationStore(options),
  audit: () => createSourceControlAuditStore(options),
  executor: () => createMutationExecutor({
    store: createMutationStore(options),
    auditStore: createSourceControlAuditStore({ ...options, filePath: `${filePath}.audit.json` }),
    runtimeIdentity: { id: `server_${process.pid}`, platform: 'web' },
  }),
};
const store = stores[kind]?.();
const releases = new Map();
process.on('message', async ({ id, method, args = [], hold = false, outcome = 'succeeded', release }) => {
  if (release) {
    releases.get(release)?.();
    return;
  }
  try {
    let value;
    if (method === 'hold-lock') {
      value = await withSourceControlFileLock(filePath, async () => {
        const waiting = new Promise((resolve) => releases.set(id, resolve));
        process.send({ event: 'locked', id });
        await waiting;
      });
    } else if (method === 'execute') {
      value = await store.execute({
        record: args[0],
        providerAccountId: 'github.com#42',
        perform: async () => {
          const waiting = hold ? new Promise((resolve) => releases.set(id, resolve)) : Promise.resolve();
          process.send({ event: 'perform', id });
          await waiting;
          if (outcome !== 'succeeded') throw new Error('provider failure');
          return { number: 7 };
        },
        classifyError: () => outcome,
        reconcile: async () => {
          process.send({ event: 'reconcile', id });
          const completion = { state: outcome };
          if (outcome === 'succeeded') completion.result = { number: 7 };
          return completion;
        },
      });
    } else {
      value = await store[method](...args);
    }
    process.send({ id, ok: true, value });
  } catch (error) {
    process.send({ id, ok: false, error: { code: error.code, status: error.status, message: error.message, current: error.current } });
  } finally {
    releases.delete(id);
  }
});
process.send({ event: 'ready' });
