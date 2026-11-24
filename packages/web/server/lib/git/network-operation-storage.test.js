import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitNetworkOperationStore } from './network-operation-storage.js';

const directories = [];
const setup = async (options = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-operation-storage-'));
  directories.push(directory);
  const filePath = path.join(directory, 'operations.json');
  return { filePath, store: createGitNetworkOperationStore({ filePath, ...options }) };
};
const snapshot = (operationId, operation = 'push') => ({
  operationId,
  runtimeIdentity: { id: 'server_original', platform: 'web' },
  transport: { mode: 'managed', verification: { status: 'verified', method: 'credential' } },
  target: {
    operation,
    repositoryId: 'repository_one',
    bindingRevision: 2,
    configRevision: 'config_one',
    remote: {
      name: 'origin',
      endpoint: { displayUrl: 'https://example.com/owner/repository.git', fingerprint: 'endpoint_fingerprint' },
    },
    sourceRef: 'refs/heads/main',
    destinationRef: 'refs/heads/main',
  },
  completedSteps: [],
  state: 'planned',
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('Git network operation storage', () => {
  it('recovers abandoned plans as cancelled without starting them', async () => {
    const { filePath, store } = await setup();
    await store.claim(snapshot('git_planned'));

    const restarted = createGitNetworkOperationStore({ filePath });
    await expect(restarted.recover()).resolves.toEqual([
      expect.objectContaining({
        operationId: 'git_planned',
        state: 'cancelled',
        completedSteps: [],
        error: { code: 'CANCELLED', message: expect.stringContaining('before the Git operation started') },
      }),
    ]);
  });

  it('stores an operation on a repository nobody bound (binding revision 0)', async () => {
    const { store } = await setup();
    const unbound = snapshot('git_unbound');
    unbound.transport = { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } };
    unbound.target.bindingRevision = 0;

    await expect(store.claim(unbound)).resolves.toEqual(expect.objectContaining({ operationId: 'git_unbound', state: 'planned' }));
  });

  // Two servers can share one data directory; the second one starting up must
  // not end the first one's push as if a restart had interrupted it.
  it('stores an operation on a plain HTTP loopback endpoint, and refuses plain HTTP to any other host', async () => {
    const { store } = await setup();
    const local = snapshot('git_loopback');
    local.target.remote.endpoint.displayUrl = 'http://127.0.0.1:8080/demo';
    await expect(store.claim(local)).resolves.toEqual(expect.objectContaining({ operationId: 'git_loopback' }));
    const remote = snapshot('git_plain_http');
    remote.target.remote.endpoint.displayUrl = 'http://review.example.com/demo';
    await expect(store.claim(remote)).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID' });
  });

  it('stores an operation whose endpoint path has percent-encoded spaces', async () => {
    const { store } = await setup();
    const azure = snapshot('git_azure');
    azure.target.remote.endpoint.displayUrl = 'https://dev.azure.com/org/CRM%202.0/_git/CRM%20Example';
    await expect(store.claim(azure)).resolves.toEqual(expect.objectContaining({ operationId: 'git_azure' }));
  });

  it('recovers only operations whose owning process is gone', async () => {
    const { filePath, store } = await setup();
    for (const id of ['git_live', 'git_dead']) {
      const planned = snapshot(id);
      await store.claim(planned);
      await store.update(id, { snapshot: { ...planned, state: 'running' } });
    }
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    stored.records.git_live.owner.pid = process.ppid;
    stored.records.git_dead.owner.pid = 999999999;
    await fs.writeFile(filePath, JSON.stringify(stored), { mode: 0o600 });

    const recovered = await createGitNetworkOperationStore({ filePath }).recover();
    expect(Object.fromEntries(recovered.map((value) => [value.operationId, value.state])))
      .toEqual({ git_live: 'running', git_dead: 'outcome-unknown' });
  });

  it('retains completed steps and publication uncertainty across restart', async () => {
    const { filePath, store } = await setup();
    const planned = snapshot('git_running');
    await store.claim(planned);
    await store.update('git_running', { snapshot: { ...planned, state: 'running' } });
    await store.update('git_running', {
      snapshot: { ...planned, state: 'running', completedSteps: ['validated', 'transferred'] },
      remotePublicationStarted: true,
    });

    const [recovered] = await createGitNetworkOperationStore({ filePath }).recover();
    expect(recovered).toMatchObject({
      operationId: 'git_running',
      state: 'outcome-unknown',
      completedSteps: ['validated', 'transferred'],
      error: { code: 'OUTCOME_UNKNOWN', message: expect.stringContaining('remote publication began') },
    });
  });

  it('never expires or evicts outcome-unknown records for capacity', async () => {
    let timestamp = 1;
    const { filePath, store } = await setup({ maxRecords: 1, terminalRetentionMs: 10, now: () => timestamp });
    const planned = snapshot('git_unknown');
    await store.claim(planned);
    await store.update('git_unknown', { snapshot: { ...planned, state: 'running' } });
    timestamp = 2;
    await store.update('git_unknown', {
      snapshot: {
        ...planned,
        state: 'outcome-unknown',
        error: { code: 'OUTCOME_UNKNOWN', message: 'Remote result is unknown' },
      },
      remotePublicationStarted: true,
    });
    timestamp = 10_000;

    const restarted = createGitNetworkOperationStore({
      filePath, maxRecords: 1, terminalRetentionMs: 10, now: () => timestamp,
    });
    await expect(restarted.read('git_unknown')).resolves.toMatchObject({ state: 'outcome-unknown' });
    await expect(restarted.claim(snapshot('git_new'))).rejects.toMatchObject({
      code: 'GIT_NETWORK_OPERATION_CAPACITY',
    });
  });

  it('keeps a record naming an operation this build does not know, and still refuses a malformed known one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { filePath, store } = await setup();
    await store.claim(snapshot('git_foreign'));
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    stored.records.git_foreign.snapshot.target.operation = 'mirror-push';
    stored.records.git_foreign.owner.pid = 999999999;
    await fs.writeFile(filePath, JSON.stringify(stored), { mode: 0o600 });

    const recovered = await createGitNetworkOperationStore({ filePath }).recover();
    expect(recovered).toEqual([expect.objectContaining({
      operationId: 'git_foreign',
      state: 'cancelled',
      target: expect.objectContaining({ operation: 'mirror-push' }),
    })]);
    // The record survived the rewrite that recovery performs.
    const after = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(after.records.git_foreign.snapshot.target.operation).toBe('mirror-push');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mirror-push'));
    warn.mockRestore();

    // A name this build cannot read is still a name, and a target it cannot
    // shape still may not carry an endpoint, a path or process output.
    for (const foreignTarget of [
      { kind: 'git-network', operation: 'https://token@example.com/op', projectId: 'repository_one' },
      { kind: 'git-network', operation: 'mirror-push', endpoint: 'https://token@example.com/repo.git' },
      { kind: 'git-network', operation: 'mirror-push', destination: '/private/repository' },
      {
        kind: 'git-network', operation: 'mirror-push',
        extra: { url: 'https://user:secret@example.com/repo', keyPath: '/private/key', processOutput: 'private output' },
      },
    ]) {
      after.records.git_foreign.snapshot.target = foreignTarget;
      await fs.writeFile(filePath, JSON.stringify(after), { mode: 0o600 });
      await expect(createGitNetworkOperationStore({ filePath }).recover())
        .rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID' });
    }

    after.records.git_foreign.snapshot.target = { kind: 'git-network', operation: 'mirror-push', sourceRef: 'refs/heads/main' };
    after.records.git_foreign.snapshot.stepResults = [
      { step: 'fetch', status: 'succeeded' },
      { step: 'pull', status: 'failed', error: { code: 'FUTURE_FAILURE', message: 'Failed' } },
      { step: 'push', status: 'skipped' },
    ];
    await fs.writeFile(filePath, JSON.stringify(after), { mode: 0o600 });
    await expect(createGitNetworkOperationStore({ filePath }).read('git_foreign'))
      .resolves.toMatchObject({ state: 'cancelled', stepResults: expect.any(Array) });

    after.records.git_foreign.snapshot.target = { kind: 'git-network', operation: 'push', sourceRef: 'not-a-ref' };
    delete after.records.git_foreign.snapshot.stepResults;
    await fs.writeFile(filePath, JSON.stringify(after), { mode: 0o600 });
    await expect(createGitNetworkOperationStore({ filePath }).recover())
      .rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID' });
  });

  it('keeps an arbitrary code inside a foreign target without printing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { filePath, store } = await setup();
    await store.claim(snapshot('git_foreign_code'));
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const escape = '\u001b]0;owned\u0007\u001b[31mINJECTED';
    stored.records.git_foreign_code.snapshot.target = {
      operation: 'mirror-push',
      detail: { code: escape, nested: [{ code: 'NOT_A_REAL_ERROR' }] },
    };
    await fs.writeFile(filePath, JSON.stringify(stored), { mode: 0o600 });

    const restarted = createGitNetworkOperationStore({ filePath });
    await expect(restarted.read('git_foreign_code')).resolves.toMatchObject({
      target: { operation: 'mirror-push', detail: { code: escape } },
    });
    await restarted.read('git_foreign_code');
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toContain('operation mirror-push');
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('INJECTED');
    expect(message).not.toContain('NOT_A_REAL_ERROR');
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(persisted.records.git_foreign_code.snapshot.target.detail.code).toBe(escape);
    warn.mockRestore();
  });

  it('keeps a record naming a step this build does not know, and never writes one', async () => {
    const { filePath, store } = await setup();
    const planned = snapshot('git_foreign_step');
    await store.claim(planned);
    await store.update('git_foreign_step', { snapshot: { ...planned, state: 'running' } });
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const record = stored.records.git_foreign_step;
    record.completedSteps = ['validated', 'verified-remote'];
    record.snapshot.completedSteps = ['validated', 'verified-remote'];
    record.owner.pid = 999999999;
    await fs.writeFile(filePath, JSON.stringify(stored), { mode: 0o600 });

    const recovered = await createGitNetworkOperationStore({ filePath }).recover();
    expect(recovered).toEqual([expect.objectContaining({
      operationId: 'git_foreign_step',
      state: 'outcome-unknown',
      completedSteps: ['validated', 'verified-remote'],
    })]);

    const strict = snapshot('git_foreign_step_write');
    strict.completedSteps = ['verified-remote'];
    await expect(store.claim(strict)).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID' });
  });

  it('keeps an inner code this build does not know inside a hydration part, and never writes one', async () => {
    const { filePath, store } = await setup({ now: () => 100 });
    const planned = snapshot('git_foreign_part', 'checkout-hydration');
    planned.target = {
      operation: 'checkout-hydration', repositoryId: 'repository_one', bindingRevision: 2,
      configRevision: 'config_one', remote: snapshot('unused').target.remote,
      requirements: [{
        kind: 'submodule', path: 'vendor/module',
        endpoint: { displayUrl: 'https://modules.example/module.git', fingerprint: 'module_fingerprint' },
      }],
    };
    await store.claim(planned);
    const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const record = stored.records.git_foreign_part;
    const part = { path: 'vendor/module', status: 'failed', error: { code: 'FUTURE_FAILURE', message: 'Failed' } };
    record.state = 'failed';
    record.completedSteps = ['validated'];
    record.finishedAt = 110;
    record.expiresAt = 1_000;
    record.snapshot = {
      ...record.snapshot,
      state: 'failed',
      completedSteps: ['validated'],
      error: { code: 'TRANSPORT_FAILED', message: 'Git transport failed' },
      hydration: { status: 'failed', submodules: [part], lfs: [] },
    };
    await fs.writeFile(filePath, JSON.stringify(stored), { mode: 0o600 });

    const restarted = createGitNetworkOperationStore({ filePath, now: () => 100 });
    await expect(restarted.read('git_foreign_part')).resolves.toMatchObject({
      state: 'failed',
      hydration: expect.objectContaining({ status: 'failed' }),
    });
    // Writing one stays refused: this build records only codes it can classify.
    const plannedWrite = snapshot('git_foreign_part_write', 'checkout-hydration');
    plannedWrite.target = planned.target;
    await store.claim(plannedWrite);
    await expect(store.update('git_foreign_part_write', { snapshot: {
      ...plannedWrite,
      state: 'failed',
      completedSteps: ['validated'],
      error: { code: 'TRANSPORT_FAILED', message: 'Git transport failed' },
      hydration: { status: 'failed', submodules: [part], lfs: [] },
    } })).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID' });
  });

  it('uses mode 0600 atomic storage, omits private fields, and rejects cross-process ID collisions', async () => {
    const { filePath, store } = await setup();
    const value = snapshot('git_collision');
    value.target.forceWithLease = { expectedRemoteSha: 'a'.repeat(40) };
    value.target.remote.endpoint.displayUrl = 'git@example.com:owner/repository.git';
    value.directory = '/private/repository';
    value.rawEndpoint = 'https://token@example.com/private/repository.git';
    value.credentialId = 'credential_secret';
    value.output = 'private process output';
    await store.claim(value);

    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    const encoded = await fs.readFile(filePath, 'utf8');
    expect(encoded).not.toContain('/private/repository');
    expect(encoded).not.toContain('token@example.com');
    expect(encoded).not.toContain('git@example.com');
    expect(encoded).not.toContain('credential_secret');
    expect(encoded).not.toContain('private process output');
    expect(encoded).not.toContain('a'.repeat(40));
    await expect(store.update('git_collision', {
      snapshot: {
        ...snapshot('git_collision'),
        state: 'running',
        target: { ...snapshot('git_collision').target, sourceRef: 'refs/heads/other' },
      },
    })).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_EXISTS' });
    await expect(createGitNetworkOperationStore({ filePath }).claim(snapshot('git_collision')))
      .rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_EXISTS' });
  });

  it('round-trips checkout hydration and rejects absolute public checkout paths', async () => {
    const { store } = await setup();
    const planned = snapshot('git_hydration', 'checkout-hydration');
    planned.target = {
      operation: 'checkout-hydration', repositoryId: 'repository_one', bindingRevision: 2,
      configRevision: 'config_one', remote: snapshot('unused').target.remote,
      requirements: [{
        kind: 'submodule', path: 'vendor/module',
        endpoint: { displayUrl: 'https://modules.example/module.git', fingerprint: 'module_fingerprint' },
      }],
    };
    await store.claim(planned);
    await store.update('git_hydration', { snapshot: { ...planned, state: 'running' } });
    await expect(store.update('git_hydration', { snapshot: {
      ...planned,
      state: 'succeeded',
      hydration: {
        status: 'failed',
        submodules: [{ path: 'vendor/module', status: 'failed', error: { code: 'TRANSPORT_FAILED', message: 'Failed' } }],
        lfs: [],
      },
    } })).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID' });
    const completed = {
      ...planned,
      state: 'succeeded',
      completedSteps: ['validated', 'checked-out'],
      hydration: {
        status: 'succeeded',
        submodules: [{
          path: 'vendor/module', status: 'succeeded',
          endpoint: planned.target.requirements[0].endpoint,
        }],
        lfs: [],
      },
    };
    await store.update('git_hydration', { snapshot: completed });
    await expect(store.read('git_hydration')).resolves.toEqual(completed);

    const invalid = snapshot('git_invalid_hydration', 'checkout-hydration');
    invalid.target = { ...planned.target, requirements: [{ ...planned.target.requirements[0], path: '/private/module' }] };
    await expect(store.claim(invalid)).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID' });

    const controlPath = snapshot('git_control_hydration', 'checkout-hydration');
    controlPath.target = { ...planned.target, requirements: [{ ...planned.target.requirements[0], path: 'vendor/module\nother' }] };
    await expect(store.claim(controlPath)).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID' });
  });

  it('persists the private bootstrap hydration marker without inventing repository authority', async () => {
    const { store } = await setup();
    const planned = snapshot('git_bootstrap_hydration', 'checkout-hydration');
    planned.target = { operation: 'checkout-hydration' };
    planned.transport = null;

    await expect(store.claim(planned)).resolves.toEqual(planned);
    await expect(store.read(planned.operationId)).resolves.toEqual(planned);

    const invalid = snapshot('git_null_push');
    invalid.transport = null;
    await expect(store.claim(invalid)).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID' });
  });
});
