import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNetworkOperationRegistry } from './network-operation-registry.js';
import { createGitNetworkOperationStore } from './network-operation-storage.js';

const directories = [];
const setup = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-operation-recovery-'));
  directories.push(directory);
  return path.join(directory, 'operations.json');
};
const plans = (operationId) => ({
  internalPlan: {
    operationId,
    directory: '/private/repository',
    rawEndpoint: 'https://secret@example.com/owner/repository.git',
    credentialId: 'credential_secret',
    sourceSha: 'a'.repeat(40),
    target: { operation: 'push' },
  },
  publicPlan: {
    operationId,
    runtimeIdentity: { id: 'server_original', platform: 'web' },
    transport: { mode: 'managed', verification: { status: 'verified', method: 'credential' } },
    target: {
      operation: 'push',
      repositoryId: 'repository_one',
      bindingRevision: 1,
      configRevision: 'config_one',
      remote: {
        name: 'origin',
        endpoint: { displayUrl: 'https://example.com/owner/repository.git', fingerprint: 'endpoint_one' },
      },
      sourceRef: 'refs/heads/main',
      destinationRef: 'refs/heads/main',
    },
  },
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

it('serves the same operation ID as cancelled after restart without an executable plan', async () => {
  const filePath = await setup();
  const first = createNetworkOperationRegistry({
    store: createGitNetworkOperationStore({ filePath }),
  });
  await first.register(plans('git_restart'));

  const restarted = createNetworkOperationRegistry({
    store: createGitNetworkOperationStore({ filePath }),
  });
  await expect(restarted.get('git_restart')).resolves.toMatchObject({
    operationId: 'git_restart',
    state: 'cancelled',
    completedSteps: [],
    error: { code: 'CANCELLED' },
  });
  const execute = vi.fn(() => ({ state: 'succeeded' }));
  await expect(restarted.start('git_restart', execute))
    .rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_NOT_STARTABLE' });
  expect(execute).not.toHaveBeenCalled();
});

it('serves retained steps as outcome-unknown after a running operation is abandoned', async () => {
  const filePath = await setup();
  const store = createGitNetworkOperationStore({ filePath });
  const planned = plans('git_running');
  const first = createNetworkOperationRegistry({ store });
  await first.register(planned);
  const publicPlan = { ...planned.publicPlan, completedSteps: [], state: 'planned' };
  await store.update('git_running', { snapshot: { ...publicPlan, state: 'running' } });
  await store.update('git_running', {
    snapshot: { ...publicPlan, state: 'running', completedSteps: ['validated', 'transferred'] },
    remotePublicationStarted: true,
  });

  const restarted = createNetworkOperationRegistry({
    store: createGitNetworkOperationStore({ filePath }),
  });
  await expect(restarted.get('git_running')).resolves.toMatchObject({
    operationId: 'git_running',
    state: 'outcome-unknown',
    completedSteps: ['validated', 'transferred'],
    error: { code: 'OUTCOME_UNKNOWN', message: expect.stringContaining('remote publication began') },
  });
});
