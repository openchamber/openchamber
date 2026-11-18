import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMutationStore } from './mutation-storage.js';
import { createMutationExecutor } from './mutation-executor.js';
import { createSourceControlAuditStore } from './audit-storage.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const record = { key: 'revocation', inputDigest: 'captured-digest', kind: 'change-request-merge',
  actor: { provider: 'github', instance: 'github.com', accountId: 'account-one' },
  target: { repositoryId: 'repo-one', bindingRevision: 1, primaryRemote: 'origin',
    project: { id: 'acme/example', owner: 'acme', name: 'example' }, number: 17 } };
const setup = async () => {
  const root = await fs.mkdtemp('/tmp/opencode/mutation-reconcile-'); roots.push(root);
  const recreate = (id, fsImpl = fs) => {
    const store = createMutationStore({ filePath: path.join(root, 'mutations.json'), fsImpl });
    const auditStore = createSourceControlAuditStore({ filePath: path.join(root, 'audit.json') });
    return { store, auditStore, executor: createMutationExecutor({ store, auditStore, runtimeIdentity: { id, platform: 'web' } }) };
  };
  const first = recreate('original');
  let writes = 0;
  await expect(first.executor.execute({ record, providerAccountId: 'github.com#42',
    perform: async () => { writes += 1; throw new Error('Response lost'); }, classifyError: () => 'outcome-unknown' }))
    .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
  return { ...first, recreate, writes: () => writes };
};

it('settles the original unknown mutation and audit through an explicit read-only recovery after restart', async () => {
  const fixture = await setup();
  const restarted = fixture.recreate('restarted');
  const observed = { number: 17, headSha: 'a'.repeat(40), merged: false };
  const result = await restarted.executor.reconcile({ record, providerAccountId: 'github.com#42',
    reconcile: async () => ({ state: 'succeeded', result: observed }) });
  expect(result).toMatchObject({ replayed: true, record: { state: 'succeeded', result: observed } });
  expect(fixture.writes()).toBe(1);
  expect(await restarted.auditStore.read('provider:revocation')).toMatchObject({ state: 'succeeded',
    runtime: { id: 'original' }, result: { steps: ['provider-reconciliation'], errorCode: null } });
  await expect(restarted.executor.execute({ record, providerAccountId: 'github.com#42',
    perform: async () => { throw new Error('Must not write'); } })).resolves.toMatchObject({ replayed: true });
});

it('leaves ordinary execute sticky and rejects changed authority or unproved reads without altering the receipt', async () => {
  const fixture = await setup();
  const before = await fixture.store.read(record.key);
  let reads = 0;
  const reconcile = async () => { reads += 1; return { state: 'outcome-unknown' }; };
  await expect(fixture.executor.execute({ record, providerAccountId: 'github.com#42', reconcile }))
    .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
  expect(reads).toBe(0);
  await expect(fixture.executor.reconcile({ record: { ...record, inputDigest: 'changed' }, providerAccountId: 'github.com#42', reconcile }))
    .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_CONFLICT' });
  expect(reads).toBe(0);
  await expect(fixture.executor.reconcile({ record, providerAccountId: 'github.com#42', reconcile }))
    .rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
  expect(await fixture.store.read(record.key)).toEqual(before);
  expect(fixture.writes()).toBe(1);
});

it('preserves an unknown snapshot when reconciliation persistence fails and recovers by reading again', async () => {
  const fixture = await setup();
  const broken = fixture.recreate('broken', { ...fs, rename: async () => { throw new Error('Disk unavailable'); } });
  const request = { record, providerAccountId: 'github.com#42', reconcile: async () => ({ state: 'succeeded', result: { number: 17, merged: false } }) };
  await expect(broken.executor.reconcile(request)).rejects.toThrow('Disk unavailable');
  expect((await fixture.store.read(record.key)).state).toBe('outcome-unknown');
  expect((await fixture.auditStore.read('provider:revocation')).state).toBe('outcome-unknown');
  await expect(fixture.recreate('healthy').executor.reconcile(request)).resolves.toMatchObject({ record: { state: 'succeeded' } });
  expect(fixture.writes()).toBe(1);
});
