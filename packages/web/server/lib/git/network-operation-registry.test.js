import { describe, expect, it, vi } from 'vitest';
import { createNetworkOperationRegistry } from './network-operation-registry.js';

const plans = (operationId, secret = 'secret-endpoint') => ({
  internalPlan: { operationId, endpoint: secret, credentialId: 'credential_one' },
  publicPlan: { operationId, endpoint: 'https://example.com/repository.git' },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
};

describe('Git network operation registry', () => {
  it('registers immutable plans and returns public snapshots only', () => {
    const registry = createNetworkOperationRegistry();
    const input = plans('git_one');
    const snapshot = registry.register(input);
    input.internalPlan.endpoint = 'changed';

    expect(snapshot).toEqual({
      operationId: 'git_one', endpoint: 'https://example.com/repository.git', state: 'planned', completedSteps: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-endpoint');
    expect(registry.getInternalPlan('git_one').endpoint).toBe('secret-endpoint');
    expect(Object.isFrozen(registry.getInternalPlan('git_one'))).toBe(true);
  });

  it('rejects duplicate operation IDs', () => {
    const registry = createNetworkOperationRegistry();
    registry.register(plans('git_one'));
    expect(() => registry.register(plans('git_one'))).toThrow(expect.objectContaining({
      code: 'GIT_NETWORK_OPERATION_EXISTS',
    }));
  });

  it('starts atomically so duplicate callers join one execution promise', async () => {
    const registry = createNetworkOperationRegistry();
    registry.register(plans('git_one'));
    const gate = deferred();
    const execute = vi.fn(async (_plan, controls) => {
      controls.markStepCompleted('validated');
      await gate.promise;
      return { state: 'succeeded' };
    });

    const first = registry.start('git_one', execute);
    const second = registry.start('git_one', execute);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    gate.resolve();
    await expect(first).resolves.toMatchObject({
      state: 'succeeded', completedSteps: ['validated'],
    });
  });

  it('carries cancellation across the spawn boundary and terminates an attached child', async () => {
    const cancelChild = vi.fn();
    const registry = createNetworkOperationRegistry({ cancelChild });
    registry.register(plans('git_one'));
    const gate = deferred();
    const child = { kill: vi.fn() };
    const running = registry.start('git_one', async (_plan, controls) => {
      await gate.promise;
      expect(controls.attachChild(child)).toBe(true);
      return { state: 'cancelled', error: { code: 'CANCELLED', message: 'Cancelled' } };
    });
    await Promise.resolve();

    expect(registry.cancel('git_one')).toMatchObject({ state: 'running' });
    expect(registry.isCancellationRequested('git_one')).toBe(true);
    gate.resolve();
    await expect(running).resolves.toMatchObject({ state: 'cancelled' });
    expect(cancelChild).toHaveBeenCalledWith(child);
  });

  it('cancels a planned operation without starting it', () => {
    const registry = createNetworkOperationRegistry();
    registry.register(plans('git_one'));
    expect(registry.cancel('git_one')).toMatchObject({ state: 'cancelled' });
  });

  it.each([
    ['conflicted', 'CONFLICT'],
    ['failed', 'UNKNOWN'],
    ['partial', 'TRANSPORT_FAILED'],
    ['outcome-unknown', 'OUTCOME_UNKNOWN'],
  ])('stores truthful %s terminal outcomes', (state, code) => {
    const registry = createNetworkOperationRegistry();
    registry.register(plans(`git_${state}`));
    expect(registry.finish(`git_${state}`, { state, error: { code, message: state } })).toMatchObject({
      state, error: { code, message: state },
    });
  });

  it('requires complete ordered step results for terminal sync snapshots', () => {
    const registry = createNetworkOperationRegistry();
    registry.register({
      internalPlan: { operationId: 'git_sync', target: { operation: 'sync' } },
      publicPlan: { operationId: 'git_sync', target: { operation: 'sync' } },
    });
    expect(() => registry.finish('git_sync', { state: 'succeeded' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_GIT_NETWORK_OPERATION_COMPLETION' }));
    expect(registry.finish('git_sync', {
      state: 'succeeded',
      stepResults: [
        { step: 'fetch', status: 'succeeded' },
        { step: 'pull', status: 'succeeded' },
        { step: 'push', status: 'succeeded' },
      ],
    })).toMatchObject({ state: 'succeeded', stepResults: expect.any(Array) });
  });

  it('accepts only repository-relative paths in hydration completion records', () => {
    const registry = createNetworkOperationRegistry();
    registry.register(plans('git_hydration'));
    const hydration = {
      status: 'succeeded',
      submodules: [{ path: 'vendor/module', status: 'succeeded' }],
      lfs: [],
    };
    expect(() => registry.finish('git_hydration', {
      state: 'succeeded', hydration: { ...hydration, submodules: [{ ...hydration.submodules[0], path: '/private/module' }] },
    })).toThrow(expect.objectContaining({ code: 'INVALID_GIT_NETWORK_OPERATION_COMPLETION' }));
    expect(() => registry.finish('git_hydration', {
      state: 'succeeded', hydration: { ...hydration, submodules: [{
        ...hydration.submodules[0], endpoint: { displayUrl: 'https://token@example.com/module.git', fingerprint: 'module' },
      }] },
    })).toThrow(expect.objectContaining({ code: 'INVALID_GIT_NETWORK_OPERATION_COMPLETION' }));
    expect(() => registry.finish('git_hydration', {
      state: 'succeeded',
      hydration: {
        status: 'failed',
        submodules: [{ path: 'vendor/module', status: 'failed', error: { code: 'TRANSPORT_FAILED', message: 'Failed' } }],
        lfs: [],
      },
    })).toThrow(expect.objectContaining({ code: 'INVALID_GIT_NETWORK_OPERATION_COMPLETION' }));
    expect(registry.finish('git_hydration', { state: 'succeeded', hydration }))
      .toMatchObject({ state: 'succeeded', hydration });
  });

  it('resolves unexpected executor failures to a stored UNKNOWN failure', async () => {
    const registry = createNetworkOperationRegistry();
    registry.register(plans('git_one'));
    await expect(registry.start('git_one', async () => { throw new Error('private nonce'); })).resolves.toMatchObject({
      state: 'failed', error: { code: 'UNKNOWN', message: 'Git network operation failed' },
    });
    expect(JSON.stringify(registry.get('git_one'))).not.toContain('private nonce');
  });

  it('expires abandoned plans to recover capacity', () => {
    let timestamp = 0;
    const registry = createNetworkOperationRegistry({ maxEntries: 1, plannedRetentionMs: 10, now: () => timestamp });
    registry.register(plans('git_old'));
    timestamp = 10;
    expect(() => registry.register(plans('git_new'))).not.toThrow();
    expect(() => registry.get('git_old')).toThrow(expect.objectContaining({ code: 'GIT_NETWORK_OPERATION_NOT_FOUND' }));
  });

  it('rejects mismatched state and error pairs', () => {
    const registry = createNetworkOperationRegistry();
    registry.register(plans('git_one'));
    expect(() => registry.finish('git_one', {
      state: 'cancelled', error: { code: 'UNKNOWN', message: 'wrong pair' },
    })).toThrow(expect.objectContaining({ code: 'INVALID_GIT_NETWORK_OPERATION_COMPLETION' }));
  });

  it('adds only parser-compatible authenticated actor metadata to public snapshots', async () => {
    const registry = createNetworkOperationRegistry();
    registry.register(plans('git_one'));
    const gate = deferred();
    const running = registry.start('git_one', async (_plan, controls) => {
      controls.updateTransportMetadata({
        provider: 'github', instance: 'github.com', accountId: 'account-one', login: 'octocat',
      });
      expect(() => controls.updateTransportMetadata({ password: 'secret' }))
        .toThrow(expect.objectContaining({ code: 'INVALID_GIT_NETWORK_OPERATION' }));
      await gate.promise;
      return { state: 'succeeded' };
    });
    await Promise.resolve();
    expect(registry.get('git_one')).not.toHaveProperty('transportMetadata');
    expect(registry.get('git_one').transport).toMatchObject({
      actor: {
        kind: 'provider', provider: 'github', instance: 'github.com', accountId: 'account-one', login: 'octocat',
      },
    });
    gate.resolve();
    await running;
  });

  it('evicts only terminal operations and rejects capacity when all entries are active', () => {
    let timestamp = 1;
    const registry = createNetworkOperationRegistry({ maxEntries: 2, now: () => timestamp });
    registry.register(plans('git_running'));
    registry.start('git_running', () => new Promise(() => {}));
    registry.register(plans('git_terminal'));
    registry.finish('git_terminal', { state: 'succeeded' });
    timestamp += 1;
    registry.register(plans('git_new'));
    expect(() => registry.get('git_terminal')).toThrow(expect.objectContaining({ code: 'GIT_NETWORK_OPERATION_NOT_FOUND' }));
    expect(registry.get('git_running').state).toBe('running');

    expect(() => registry.register(plans('git_overflow'))).toThrow(expect.objectContaining({
      code: 'GIT_NETWORK_OPERATION_CAPACITY',
    }));
  });

  it('never expires outcome-unknown entries', () => {
    let timestamp = 0;
    const registry = createNetworkOperationRegistry({ terminalRetentionMs: 10, now: () => timestamp });
    registry.register(plans('git_planned'));
    registry.register(plans('git_terminal'));
    registry.finish('git_terminal', {
      state: 'outcome-unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'Unknown outcome' },
    });
    timestamp = 10;
    expect(registry.cleanup()).toBe(0);
    expect(registry.get('git_planned').state).toBe('planned');
    expect(registry.get('git_terminal').state).toBe('outcome-unknown');
  });

  it('does not expose terminal success when durable completion fails', async () => {
    const store = {
      recover: vi.fn(async () => []),
      read: vi.fn(async () => null),
      claim: vi.fn(async (snapshot) => snapshot),
      update: vi.fn(async (_id, input) => {
        if (input.snapshot.state === 'succeeded') throw new Error('disk unavailable');
        return input.snapshot;
      }),
    };
    const registry = createNetworkOperationRegistry({ store });
    await registry.register({
      internalPlan: { operationId: 'git_durable', target: { operation: 'fetch' } },
      publicPlan: {
        operationId: 'git_durable',
        runtimeIdentity: { id: 'server_one', platform: 'web' },
        transport: { mode: 'anonymous', verification: { status: 'anonymous' } },
        target: { operation: 'fetch' },
      },
    });

    const result = await registry.start('git_durable', async (_plan, controls) => {
      await controls.markStepCompleted('validated');
      return { state: 'succeeded' };
    });

    expect(result).toMatchObject({
      state: 'outcome-unknown',
      completedSteps: ['validated'],
      error: { code: 'OUTCOME_UNKNOWN', message: expect.stringContaining('inspect') },
    });
    await expect(registry.get('git_durable')).resolves.toMatchObject({ state: 'outcome-unknown' });
  });
});
