import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createMutationStore } from './mutation-storage.js';
import { createMutationExecutor } from './mutation-executor.js';
import { createSourceControlAuditStore } from './audit-storage.js';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const setup = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-source-authority-'));
  directories.push(directory);
  const store = createMutationStore({ filePath: path.join(directory, 'mutations.json') });
  const auditStore = createSourceControlAuditStore({ filePath: path.join(directory, 'audit.json') });
  return { store, auditStore, executor: createMutationExecutor({ store, auditStore, runtimeIdentity: { id: 'runtime-one', platform: 'web' } }) };
};
const authority = { botId: 'bot-one', itemId: 'item-one', identityId: 'identity-one', identityRevision: 2, credentialRevision: 1 };
const mutation = { key: 'bot:request', inputDigest: 'fixed-digest', kind: 'change-request-comment',
  actor: { provider: 'github', instance: 'github.com', accountId: 'exact-credential' },
  target: { repositoryId: 'repo-one', botAuthority: authority, project: { id: 'owner/repo', owner: 'owner', name: 'repo' }, number: 17 },
};

it('keeps bot attribution and exact provider identity through durable replay without provider work', async () => {
  const { store, auditStore, executor } = await setup();
  let writes = 0;
  const input = { record: mutation, providerAccountId: 'github.com#42', perform: async () => { writes += 1; return { commented: true, commentId: 7 }; } };
  await executor.execute(input);
  await executor.execute(input);
  expect(writes).toBe(1);
  expect(await auditStore.list()).toMatchObject([{ initiator: 'bot', botAuthority: authority, providerAccountId: 'github.com#42', state: 'succeeded' }]);
  expect(await store.list()).toMatchObject([{ target: { botAuthority: authority }, state: 'succeeded' }]);
});

it('rejects mixed binding and bot authority and incomplete identity revisions', async () => {
  const { store } = await setup();
  await expect(store.claim({ ...mutation, target: { ...mutation.target, bindingRevision: 0, primaryRemote: 'origin' } })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
  await expect(store.claim({ ...mutation, target: { ...mutation.target, botAuthority: { ...authority, credentialRevision: 0 } } })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
  expect(await store.list()).toEqual([]);
});

it('reconciles a persisted running bot mutation and never dispatches it again', async () => {
  const { store, executor } = await setup();
  await store.claim(mutation);
  let writes = 0;
  const result = await executor.execute({ record: mutation, providerAccountId: 'github.com#42',
    perform: async () => { writes += 1; return {}; }, reconcile: async () => ({ state: 'outcome-unknown' }) }).catch((error) => error);
  expect(result.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
  expect(writes).toBe(0);
  expect((await store.read(mutation.key)).state).toBe('outcome-unknown');
});
