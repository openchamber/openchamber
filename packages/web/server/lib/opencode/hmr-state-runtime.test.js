import { describe, expect, it } from 'vitest';

import { createHmrStateRuntime } from './hmr-state-runtime.js';

const createRuntime = (env = {}) => createHmrStateRuntime({
  globalThisLike: {},
  os: { homedir: () => '/Users/example' },
  processLike: { env },
  stateKey: '__testHmrState',
});

describe('hmr state runtime', () => {
  it('uses configured OpenCode cwd when provided', () => {
    const runtime = createRuntime({ OPENCHAMBER_OPENCODE_CWD: '/tmp/openchamber-data' });

    expect(runtime.getOrCreateHmrState().openCodeWorkingDirectory).toBe('/tmp/openchamber-data');
  });

  it('falls back to home directory without configured OpenCode cwd', () => {
    const runtime = createRuntime();

    expect(runtime.getOrCreateHmrState().openCodeWorkingDirectory).toBe('/Users/example');
  });

  it('transfers the ambiguity lease association through HMR state without serializing it into a record', () => {
    const globalThisLike = {};
    const first = createHmrStateRuntime({
      globalThisLike,
      os: { homedir: () => '/Users/example' },
      processLike: { env: {} },
      stateKey: '__testHmrState',
    });
    const lease = { secrets: new Set(['internal-only']), released: false };
    const state = first.getOrCreateHmrState();
    first.syncStateFromRuntime(state, {
      openCodeProcess: null,
      openCodePort: null,
      openCodeBaseUrl: null,
      isShuttingDown: false,
      signalsAttached: false,
      openCodeWorkingDirectory: '/Users/example',
      openCodeAuthPassword: null,
      openCodeAuthSource: null,
      guardianOutcomeUnknownFence: { version: 1, kind: 'stop', operationId: 'operation-id' },
      guardianOutcomeUnknownLease: lease,
    });

    const second = createHmrStateRuntime({
      globalThisLike,
      os: { homedir: () => '/Users/example' },
      processLike: { env: {} },
      stateKey: '__testHmrState',
    });
    expect(second.restoreRuntimeFromState({
      hmrState: second.getOrCreateHmrState(),
      userProvidedOpenCodePassword: null,
    })).toMatchObject({ guardianOutcomeUnknownLease: lease });
    expect(second.getOrCreateHmrState()).not.toHaveProperty('guardianOutcomeUnknownLeaseToken');
  });

  it('retains every unresolved ambiguity fence across HMR state transfer', () => {
    const globalThisLike = {};
    const first = createHmrStateRuntime({
      globalThisLike,
      os: { homedir: () => '/Users/example' },
      processLike: { env: {} },
      stateKey: '__testHmrState',
    });
    const fences = [
      { version: 1, kind: 'prepare', operationId: 'prepare-operation' },
      { version: 1, kind: 'stop', operationId: 'stop-operation' },
    ];
    first.syncStateFromRuntime(first.getOrCreateHmrState(), {
      openCodeProcess: null,
      openCodePort: null,
      openCodeBaseUrl: null,
      isShuttingDown: false,
      signalsAttached: false,
      openCodeWorkingDirectory: '/Users/example',
      openCodeAuthPassword: null,
      openCodeAuthSource: null,
      guardianOutcomeUnknownFences: fences,
      guardianOutcomeUnknownFence: fences[0],
      guardianOutcomeUnknownLease: null,
    });

    const second = createHmrStateRuntime({
      globalThisLike,
      os: { homedir: () => '/Users/example' },
      processLike: { env: {} },
      stateKey: '__testHmrState',
    });
    expect(second.restoreRuntimeFromState({
      hmrState: second.getOrCreateHmrState(),
      userProvidedOpenCodePassword: null,
    })).toMatchObject({
      guardianOutcomeUnknownFence: fences[0],
      guardianOutcomeUnknownFences: fences,
    });
  });
});
