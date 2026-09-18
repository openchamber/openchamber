import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSourceControlAuditStore } from './audit-storage.js';
import { storageProcess } from './storage-process.test-support.js';

const directories = [];
const children = [];
const setup = async (options = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-audit-'));
  directories.push(directory);
  const filePath = path.join(directory, 'source-control-audit.json');
  return { filePath, store: createSourceControlAuditStore({ filePath, ...options }) };
};
const plan = (id, overrides = {}) => ({
  id,
  initiator: 'user',
  executorKind: 'provider-api',
  runtime: { id: 'server_one', platform: 'web' },
  repositoryId: 'repo_one',
  providerAccountId: 'account_one',
  transportReference: null,
  target: { kind: 'change-request', operation: 'change-request-merge', projectId: 'project_one', number: 7 },
  ...overrides,
});

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('source-control audit storage', () => {
  it('preserves sibling lifecycle writes from independent processes and allows one terminal transition', async () => {
    const { filePath, store } = await setup();
    const pair = await Promise.all([storageProcess('audit', filePath), storageProcess('audit', filePath)]);
    children.push(...pair);
    for (const method of ['plan', 'start', 'finish']) {
      const results = await Promise.all(pair.map((child, index) => {
        const id = `sibling_${index}`;
        const args = method === 'plan' ? [plan(id)] : method === 'start' ? [id]
          : [id, { state: 'succeeded', errorCode: null, steps: ['provider-request'] }];
        return child.call(method, args).result;
      }));
      expect(results.every((result) => result.ok)).toBe(true);
    }
    expect((await store.list()).map((record) => record.state)).toEqual(['succeeded', 'succeeded']);
    await store.plan(plan('same'));
    const results = await Promise.all(pair.map((child, index) => child.call('finish', ['same', {
      state: index === 0 ? 'succeeded' : 'failed', errorCode: null, steps: [],
    }]).result));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok).error.code).toBe('SOURCE_CONTROL_AUDIT_CONFLICT');
  });

  it('fails closed on busy reads and cleans failed snapshot writes', async () => {
    const { filePath, store } = await setup();
    await store.plan(plan('original'));
    const original = await fs.readFile(filePath, 'utf8');
    const failing = createSourceControlAuditStore({ filePath, fsImpl: { ...fs, rename: async () => { throw new Error('rename failed'); } } });
    await expect(failing.start('original')).rejects.toThrow('rename failed');
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['source-control-audit.json']);
    await fs.writeFile(`${filePath}.lock`, 'orphan');
    const blocked = createSourceControlAuditStore({ filePath, lockWaitMs: 20 });
    for (const operation of [() => blocked.read('missing'), () => blocked.list(), () => blocked.plan(plan('new'))]) {
      await expect(operation()).rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503 });
    }
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);
  });

  it('persists a strict anonymous transport marker without account or credential fields', async () => {
    const { filePath, store } = await setup();
    const input = plan('git:anonymous', { executorKind: 'openchamber-server-git', providerAccountId: null,
      transportReference: { kind: 'anonymous' }, target: { kind: 'git-network', operation: 'fetch', fetchScope: 'remote', force: false,
        remotes: [{ role: 'operation', name: 'origin', endpointFingerprint: 'a'.repeat(43) }] } });
    await store.plan(input);
    expect(await createSourceControlAuditStore({ filePath }).read(input.id)).toMatchObject({ providerAccountId: null, transportReference: { kind: 'anonymous' } });
    for (const extra of [{ credentialId: 'secret' }, { marker: 'system-credentials' }, { accountId: 'account' }]) {
      await expect(store.plan({ ...input, id: 'invalid', transportReference: { kind: 'anonymous', ...extra } })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
    }
  });
  it('round trips remote Fetch scope without refs, endpoints, or provider credentials', async () => {
    const { filePath, store } = await setup();
    const target = {
      kind: 'git-network', operation: 'fetch', fetchScope: 'remote', force: true,
      remotes: [{ role: 'operation', name: 'upstream', endpointFingerprint: 'a'.repeat(43) }],
    };
    const input = plan('git:remote-fetch', {
      executorKind: 'openchamber-server-git', providerAccountId: null,
      transportReference: { kind: 'system', marker: 'system-credentials' }, target,
    });
    await store.plan(input);
    await store.start(input.id);
    await store.finish(input.id, { state: 'succeeded', errorCode: null, steps: ['validated', 'transferred'] });
    const reopened = createSourceControlAuditStore({ filePath });
    expect(await reopened.read(input.id)).toMatchObject({ target, state: 'succeeded', providerAccountId: null });
    for (const extra of [{ force: 'yes' }, { fetchScope: 'all' }, { refspec: '+refs/*:refs/*' }, { operation: 'push' }]) {
      await expect(reopened.plan({ ...input, id: 'git:invalid', target: { ...target, ...extra } }))
        .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
    }
  });

  it('writes a strict versioned mode-0600 snapshot with no mutation payload fields', async () => {
    const { filePath, store } = await setup({ now: () => 100 });
    await store.plan(plan('provider_one'));
    await store.start('provider_one');
    await store.finish('provider_one', { state: 'succeeded', errorCode: null, steps: ['provider-request'] });

    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(persisted).toEqual({
      version: 1,
      records: {
        provider_one: {
          ...plan('provider_one'), state: 'succeeded', plannedAt: 100, startedAt: 100, finishedAt: 100,
          result: { state: 'succeeded', errorCode: null, steps: ['provider-request'] }, expiresAt: 2_592_000_100,
        },
      },
    });
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['source-control-audit.json']);
  });

  it('fails closed for malformed, unknown-version, and unknown-field state', async () => {
    const { filePath, store } = await setup();
    await fs.writeFile(filePath, '{broken', 'utf8');
    await expect(store.list()).rejects.toBeInstanceOf(SyntaxError);
    await fs.writeFile(filePath, JSON.stringify({ version: 2, records: {} }), 'utf8');
    await expect(store.list()).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
    await fs.writeFile(filePath, JSON.stringify({ version: 1, records: { bad: { secret: 'token' } } }), 'utf8');
    await expect(store.list()).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
  });

  it.each([
    { target: { kind: 'change-request', operation: 'change-request-merge', projectId: 'https://user:token@example.com/repo', number: 7 } },
    { executorKind: 'openchamber-server-git', target: { kind: 'git-network', operation: 'push', remotes: [] }, transportReference: { kind: 'managed', credentialId: 'https://example.com/private' } },
    { privateKeyPath: '/private/key' },
    { stdout: 'credential output' },
  ])('rejects URL-shaped, private-path, output, and unknown fields', async (override) => {
    const { store } = await setup({ now: () => 100 });
    await expect(store.plan(plan('bad', override))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
  });

  it('reuses one logical record and rejects changed immutable audit identity', async () => {
    const { store } = await setup({ now: () => 100 });
    const first = await store.plan(plan('provider_one'));
    await expect(Promise.all([store.plan(plan('provider_one')), store.plan(plan('provider_one'))]))
      .resolves.toEqual([
        { status: 'existing', record: first.record },
        { status: 'existing', record: first.record },
      ]);
    await expect(store.plan(plan('provider_one', { repositoryId: 'repo_two' })))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_AUDIT_CONFLICT' });
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it('accepts exact managed, system, and split sync transport authority without payload objects', async () => {
    const { store } = await setup({ now: () => 100 });
    const gitPlan = (id, operation, transportReference) => plan(id, {
      executorKind: 'openchamber-server-git',
      providerAccountId: null,
      transportReference,
      target: { kind: 'git-network', operation, remotes: [] },
    });
    const managed = { kind: 'managed', credentialId: 'ocgit:v1:ssh:key_one' };
    const system = { kind: 'system', marker: 'system-credentials' };
    await store.plan(gitPlan('managed', 'fetch', managed));
    await store.plan(gitPlan('system', 'pull', system));
    await store.plan(gitPlan('delete', 'delete-remote-branch', managed));
    await store.plan(gitPlan('sync', 'sync', { kind: 'sync', fetch: system, push: managed }));
    await store.plan(gitPlan('legacy-hydration', 'checkout-hydration', system));
    await store.plan(gitPlan('checkout', 'checkout-actions', {
      kind: 'system', marker: 'local-checkout-actions',
    }));

    await expect(store.read('managed')).resolves.toMatchObject({ transportReference: managed });
    await expect(store.read('delete')).resolves.toMatchObject({
      target: { operation: 'delete-remote-branch' }, transportReference: managed,
    });
    await expect(store.read('sync')).resolves.toMatchObject({
      transportReference: { kind: 'sync', fetch: system, push: managed },
    });
    await expect(store.plan(gitPlan('payload', 'push', {
      kind: 'managed', credentialId: { username: 'user', password: 'secret' },
    }))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
    await expect(store.plan(gitPlan('missing-transport', 'push', null)))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
  });

  it('stores exact hydration auxiliary grants and no transport when hydration needs no transfer', async () => {
    const { store } = await setup({ now: () => 100 });
    const hydration = (id, auxiliaries, transportReference) => plan(id, {
      executorKind: 'openchamber-server-git', providerAccountId: null, transportReference,
      target: { kind: 'git-network', operation: 'checkout-hydration', remotes: [], auxiliaries },
    });
    const submodule = { kind: 'submodule', endpointFingerprint: 'a'.repeat(43) };
    const lfs = { kind: 'lfs', endpointFingerprint: 'b'.repeat(43) };
    const systemSubmodule = { kind: 'submodule', endpointFingerprint: 'c'.repeat(43) };
    await store.plan(hydration('hydration:none', [], null));
    await store.plan(hydration('hydration:mixed', [submodule, lfs, systemSubmodule], {
      kind: 'auxiliary',
      entries: [
        { ...submodule, transport: { kind: 'managed', credentialId: 'ocgit:v1:ssh:key_one' } },
        { ...lfs, transport: { kind: 'anonymous' } },
        { ...systemSubmodule, transport: { kind: 'system', marker: 'system-credentials' } },
      ],
    }));

    await expect(store.read('hydration:none')).resolves.toMatchObject({ transportReference: null });
    await expect(store.read('hydration:mixed')).resolves.toMatchObject({
      providerAccountId: null,
      transportReference: { kind: 'auxiliary', entries: [
        { kind: 'submodule', endpointFingerprint: 'a'.repeat(43), transport: { kind: 'managed', credentialId: 'ocgit:v1:ssh:key_one' } },
        { kind: 'lfs', endpointFingerprint: 'b'.repeat(43), transport: { kind: 'anonymous' } },
        { kind: 'submodule', endpointFingerprint: 'c'.repeat(43), transport: { kind: 'system', marker: 'system-credentials' } },
      ] },
    });
    await expect(store.plan(hydration('hydration:mismatch', [submodule], {
      kind: 'auxiliary', entries: [{ ...lfs, transport: { kind: 'system', marker: 'system-credentials' } }],
    }))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
    await expect(store.plan(hydration('hydration:raw', [submodule], {
      kind: 'auxiliary', entries: [{ ...submodule, rawEndpoint: 'https://secret.example/repo', transport: { kind: 'anonymous' } }],
    }))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
    await expect(store.plan(hydration('hydration:local-marker', [submodule], {
      kind: 'auxiliary', entries: [{ ...submodule, transport: { kind: 'system', marker: 'local-checkout-actions' } }],
    }))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
    await expect(store.plan(hydration('hydration:fingerprint', [{ ...submodule, endpointFingerprint: 'short' }], null)))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
    await expect(store.plan({
      ...hydration('hydration:account', [submodule], null), providerAccountId: 'parent-account',
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_AUDIT' });
  });

  it('retains an authoritative GitLab account ID without treating its instance prefix as a transport URL', async () => {
    const { store } = await setup({ now: () => 100 });
    await store.plan(plan('gitlab_one', { providerAccountId: 'https://gitlab.example#9' }));
    await expect(store.read('gitlab_one')).resolves.toMatchObject({
      providerAccountId: 'https://gitlab.example#9',
    });
  });

  it.each([
    ['cancelled', 'CANCELLED'],
    ['failed', 'TRANSPORT_FAILED'],
    ['outcome-unknown', 'OUTCOME_UNKNOWN'],
  ])('persists compact %s results without free-form errors', async (state, errorCode) => {
    const { store } = await setup({ now: () => 100 });
    await store.plan(plan(state));
    await store.start(state);
    await store.finish(state, { state, errorCode, steps: [] });
    await expect(store.read(state)).resolves.toMatchObject({
      state, result: { state, errorCode, steps: [] }, finishedAt: 100,
    });
  });

  it('prunes and evicts only resolved terminal records while protecting every active state', async () => {
    let timestamp = 0;
    const { store } = await setup({ now: () => timestamp, maxRecords: 4, terminalTtlMs: 10 });
    await store.plan(plan('terminal'));
    await store.start('terminal');
    await store.finish('terminal', { state: 'failed', errorCode: 'FAILED', steps: [] });
    timestamp = 5;
    await store.plan(plan('planned'));
    await store.plan(plan('running'));
    await store.start('running');
    await store.plan(plan('unknown'));
    await store.start('unknown');
    await store.finish('unknown', { state: 'outcome-unknown', errorCode: 'OUTCOME_UNKNOWN', steps: [] });
    await store.plan(plan('replacement'));

    await expect(store.read('terminal')).resolves.toBeNull();
    await expect(store.read('planned')).resolves.toMatchObject({ state: 'planned' });
    await expect(store.read('running')).resolves.toMatchObject({ state: 'running' });
    await expect(store.read('unknown')).resolves.toMatchObject({ state: 'outcome-unknown', expiresAt: null });
    timestamp = 1_000;
    await expect(store.plan(plan('over-capacity'))).rejects.toMatchObject({ code: 'SOURCE_CONTROL_AUDIT_CAPACITY' });
  });
});
