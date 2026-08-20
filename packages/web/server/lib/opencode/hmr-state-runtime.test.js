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

  it('retains shared service ownership, endpoint, and auth across HMR', () => {
    const runtime = createRuntime();
    const hmrState = runtime.getOrCreateHmrState();

    runtime.syncStateFromRuntime(hmrState, {
      openCodeProcess: null,
      openCodePort: 6123,
      openCodeBaseUrl: 'http://127.0.0.1:6123',
      isSharedOpenCodeService: true,
      isShuttingDown: false,
      signalsAttached: true,
      openCodeWorkingDirectory: '/Users/example',
      openCodeAuthPassword: 'service-password',
      openCodeAuthSource: 'shared-service',
      openCodeAuthUsername: 'service-user',
    });

    expect(runtime.restoreRuntimeFromState({ hmrState, userProvidedOpenCodePassword: null })).toEqual({
      openCodeProcess: null,
      openCodePort: 6123,
      openCodeBaseUrl: 'http://127.0.0.1:6123',
      isSharedOpenCodeService: true,
      isShuttingDown: false,
      signalsAttached: true,
      openCodeWorkingDirectory: '/Users/example',
      openCodeAuthPassword: 'service-password',
      openCodeAuthSource: 'shared-service',
      openCodeAuthUsername: 'service-user',
    });
  });

  it('does not substitute a process password for an authless shared service after HMR', () => {
    const runtime = createRuntime();
    const hmrState = runtime.getOrCreateHmrState();
    hmrState.isSharedOpenCodeService = true;
    hmrState.openCodeAuthSource = 'shared-service';
    hmrState.openCodeAuthPassword = null;

    expect(runtime.restoreRuntimeFromState({
      hmrState,
      userProvidedOpenCodePassword: 'unrelated-process-password',
    }).openCodeAuthPassword).toBeNull();
  });
});
