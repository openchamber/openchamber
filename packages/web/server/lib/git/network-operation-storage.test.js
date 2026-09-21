import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
