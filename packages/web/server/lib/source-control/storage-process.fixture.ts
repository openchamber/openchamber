import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createBindingStore } from './binding-storage.js';
import { createMutationStore } from './mutation-storage.js';
import { createSourceControlAuditStore } from './audit-storage.js';
import { createMutationExecutor } from './mutation-executor.js';
import { withSourceControlFileLock } from './file-lock.js';
import type { Serializable } from 'node:child_process';
import type { MutationClaim, MutationCompletion } from './mutation-storage.js';

const [kind, filePath] = process.argv.slice(2);
const requiredFilePath = () => {
  if (filePath === undefined) throw new TypeError('Missing storage fixture file path');
  return filePath;
};
const options = {
  lockWaitMs: 300,
  fsImpl: {
    ...fs,
    readFile: new Proxy(fs.readFile, {
      async apply(readFile, _receiver, args: Parameters<typeof fs.readFile>) {
        try { return await readFile(...args); }
        finally { await delay(30); }
      },
    }),
  },
};
const makeBindingStore = () => createBindingStore({ ...options, filePath: requiredFilePath() });
const makeMutationStore = () => createMutationStore({ ...options, filePath: requiredFilePath() });
const makeAuditStore = () => {
  const auditOptions: Parameters<typeof createSourceControlAuditStore>[0] = { ...options };
  if (filePath !== undefined) auditOptions.filePath = filePath;
  return createSourceControlAuditStore(auditOptions);
};
type Executor = ReturnType<typeof createMutationExecutor>;
type FixtureStore = ReturnType<typeof makeBindingStore | typeof makeMutationStore | typeof makeAuditStore> | Executor;
interface FixtureFactories { [kind: string]: () => FixtureStore }
const stores: FixtureFactories = {
  binding: makeBindingStore,
  mutation: makeMutationStore,
  audit: makeAuditStore,
  executor: () => createMutationExecutor({
    store: makeMutationStore(),
    auditStore: createSourceControlAuditStore({ ...options, filePath: `${filePath}.audit.json` }),
    runtimeIdentity: { id: `server_${process.pid}`, platform: 'web' },
  }),
};
interface FixtureMessage {
  id: string;
  method: string;
  args?: Serializable[];
  hold?: boolean;
  outcome?: MutationCompletion['state'];
  release?: string;
}
const isExecute = (message: FixtureMessage): message is FixtureMessage & { args: [MutationClaim] } => message.method === 'execute';
interface FixtureError { code?: unknown; status?: unknown; message?: unknown; current?: unknown }
const hasErrorFields = (error: unknown): error is FixtureError => error != null;
const isFixtureMethod = (value: unknown): value is (...args: Serializable[]) => Serializable | Promise<Serializable> =>
  typeof value === 'function';
type MethodsOf<Store> = Store extends FixtureStore ? Store[keyof Store] : never;
interface FixtureMethods { [method: string]: MethodsOf<FixtureStore> }
const callStore = (store: FixtureMethods, method: string, args: Serializable[]) => {
  const operation: unknown = store[method];
  if (!isFixtureMethod(operation)) throw new TypeError('Storage fixture method is not callable');
  return operation.apply(store, args);
};
const store = stores[kind ?? 'undefined']?.();
const releases = new Map<string, () => void>();
const send = process.send?.bind(process);
if (!send) throw new TypeError('Storage fixture requires an IPC channel');
process.on('message', async (message: FixtureMessage) => {
  const { id, method, args = [], hold = false, outcome = 'succeeded', release } = message;
  if (release) {
    releases.get(release)?.();
    return;
  }
  try {
    let value: Serializable | void;
    if (method === 'hold-lock') {
      value = await withSourceControlFileLock(requiredFilePath(), async () => {
        const waiting = new Promise<void>((resolve) => releases.set(id, resolve));
        send({ event: 'locked', id });
        await waiting;
      });
    } else if (isExecute(message)) {
      if (!store || !('execute' in store)) throw new TypeError('Storage fixture has no mutation executor');
      value = await store.execute({
        record: message.args[0],
        providerAccountId: 'github.com#42',
        perform: async () => {
          const waiting = hold ? new Promise<void>((resolve) => releases.set(id, resolve)) : Promise.resolve();
          send({ event: 'perform', id });
          await waiting;
          if (outcome !== 'succeeded') throw new Error('provider failure');
          return { number: 7 };
        },
        classifyError: () => outcome,
        reconcile: async () => {
          send({ event: 'reconcile', id });
          const completion: MutationCompletion = { state: outcome };
          if (outcome === 'succeeded') completion.result = { number: 7 };
          return completion;
        },
      });
    } else {
      if (!store) throw new TypeError('Storage fixture has no store');
      value = await callStore(store, method, args);
    }
    send({ id, ok: true, value });
  } catch (error) {
    if (!hasErrorFields(error)) throw error;
    send({ id, ok: false, error: { code: error.code, status: error.status, message: error.message, current: error.current } });
  } finally {
    releases.delete(id);
  }
});
send({ event: 'ready' });
