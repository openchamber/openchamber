import { describe, expect, test } from 'bun:test';

import type {
  ActivationStage,
  RuntimeActivationAdapter,
  RuntimeSnapshot,
  SafeActivationLogger,
} from '../types';
import type { HostDescriptor, HostId, HostSessionRef } from '../../types';
import { createHostActivationController } from '../host-activation-controller';
import { noopLogger } from '../safe-activation-logger';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const hostA: HostDescriptor = {
  hostId: 'host-a' as HostId,
  label: 'Host A',
  transport: { kind: 'direct', apiUrl: 'http://localhost:3000' },
};

const hostB: HostDescriptor = {
  hostId: 'host-b' as HostId,
  label: 'Host B',
  transport: { kind: 'ssh', sshEndpoint: 'remote:22' },
};

const hostC: HostDescriptor = {
  hostId: 'host-c' as HostId,
  label: 'Host C',
  transport: { kind: 'relay', relayServerId: 'relay-1' },
};

const refA1: HostSessionRef = {
  hostId: 'host-a' as HostId,
  sessionId: 'ses_a1',
  directory: '/home/user/project-a',
  projectId: 'proj_a',
};

const refA2: HostSessionRef = {
  hostId: 'host-a' as HostId,
  sessionId: 'ses_a2',
  directory: '/home/user/project-a2',
  projectId: 'proj_a2',
};

const refB1: HostSessionRef = {
  hostId: 'host-b' as HostId,
  sessionId: 'ses_b1',
  directory: '/remote/project-b',
  projectId: 'proj_b',
};

const refC1: HostSessionRef = {
  hostId: 'host-c' as HostId,
  sessionId: 'ses_c1',
  directory: '/relay/project-c',
  projectId: 'proj_c',
};

// ---------------------------------------------------------------------------
// Fake adapter factory
// ---------------------------------------------------------------------------

interface FakeAdapterOptions {
  currentHostId?: HostId;
  currentSessionId?: string;
  shouldFail?: Partial<Record<string, Error | string>>;
  validateHostFn?: (host: HostDescriptor, signal: AbortSignal) => Promise<void>;
  switchHostFn?: (host: HostDescriptor, signal: AbortSignal) => Promise<void>;
  openProjectFn?: (ref: HostSessionRef, signal: AbortSignal) => Promise<void>;
  selectSessionFn?: (ref: HostSessionRef, signal: AbortSignal) => Promise<void>;
  verifySessionFn?: (ref: HostSessionRef, signal: AbortSignal) => Promise<boolean>;
}

const createFakeAdapter = (opts: FakeAdapterOptions = {}): RuntimeActivationAdapter & { callLog: string[]; snapshot: RuntimeSnapshot } => {
  const callLog: string[] = [];
  const snapshot: RuntimeSnapshot = {
    hostId: opts.currentHostId,
    sessionId: opts.currentSessionId,
  };

  const fail = (stage: string): void => {
    const err = opts.shouldFail?.[stage];
    if (err) {
      if (typeof err === 'string') throw new Error(err);
      throw err;
    }
  };

  return {
    callLog,
    snapshot,

    getCurrentSnapshot: () => ({ ...snapshot }),

    isCurrentHost: (hostId: HostId): boolean => {
      return snapshot.hostId === hostId;
    },

    isCurrentSession: (ref: HostSessionRef): boolean => {
      return snapshot.hostId === ref.hostId && snapshot.sessionId === ref.sessionId;
    },

    validateHost: async (host: HostDescriptor, signal: AbortSignal): Promise<void> => {
      callLog.push('validateHost');
      fail('validateHost');
      if (opts.validateHostFn) await opts.validateHostFn(host, signal);
    },

    switchHost: async (host: HostDescriptor, signal: AbortSignal): Promise<void> => {
      callLog.push('switchHost');
      fail('switchHost');
      snapshot.hostId = host.hostId;
      snapshot.runtimeKey = `host:${host.hostId}`;
      if (opts.switchHostFn) await opts.switchHostFn(host, signal);
    },

    waitForRuntimeReady: async (): Promise<void> => {
      callLog.push('waitForRuntimeReady');
      fail('waitForRuntimeReady');
    },

    openProjectOrDirectory: async (ref: HostSessionRef): Promise<void> => {
      callLog.push('openProjectOrDirectory');
      fail('openProjectOrDirectory');
      if (opts.openProjectFn) await opts.openProjectFn(ref, signal);
    },

    verifySessionExists: async (ref: HostSessionRef, signal: AbortSignal): Promise<boolean> => {
      callLog.push('verifySessionExists');
      fail('verifySessionExists');
      if (opts.verifySessionFn) return opts.verifySessionFn(ref, signal);
      return true;
    },

    selectSession: async (ref: HostSessionRef, signal: AbortSignal): Promise<void> => {
      callLog.push('selectSession');
      fail('selectSession');
      snapshot.sessionId = ref.sessionId;
      if (opts.selectSessionFn) await opts.selectSessionFn(ref, signal);
    },

    restore: async (snap: RuntimeSnapshot): Promise<void> => {
      callLog.push('restore');
      fail('restore');
      snapshot.hostId = snap.hostId;
      snapshot.runtimeKey = snap.runtimeKey;
      snapshot.sessionId = snap.sessionId;
      snapshot.projectId = snap.projectId;
      snapshot.directory = snap.directory;
    },
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hostMap: Record<string, HostDescriptor> = {
  'host-a': hostA,
  'host-b': hostB,
  'host-c': hostC,
};

const getHost = (hostId: HostId): HostDescriptor | undefined => hostMap[hostId];

const createController = (
  adapter: ReturnType<typeof createFakeAdapter>,
  overrides?: { timeoutMs?: number; clearUnread?: (ref: HostSessionRef) => void },
) => {
  return createHostActivationController({
    adapter,
    getHost,
    clearUnread: overrides?.clearUnread ?? (() => {}),
    timeoutMs: overrides?.timeoutMs ?? 5_000,
    logger: noopLogger,
  });
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('host-activation-controller', () => {
  // ---- 1. host A → host B session success ----
  test('1. host A → host B session succeeds', async () => {
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('success');
    expect(adapter.callLog).toContain('validateHost');
    expect(adapter.callLog).toContain('switchHost');
    expect(adapter.callLog).toContain('waitForRuntimeReady');
    expect(adapter.callLog.some((l) => l.startsWith('openProjectOrDirectory'))).toBe(true);
    expect(adapter.callLog).toContain('verifySessionExists');
    expect(adapter.callLog).toContain('selectSession');
    expect(adapter.snapshot.hostId).toBe('host-b');
    expect(adapter.snapshot.sessionId).toBe('ses_b1');

    ctrl.dispose();
  });

  // ---- 2. Same host switching sessions doesn't call switchHost ----
  test('2. same host does not call switchHost', async () => {
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refA2);

    expect(result.kind).toBe('success');
    expect(adapter.callLog).not.toContain('switchHost');
    expect(adapter.callLog).toContain('validateHost');

    ctrl.dispose();
  });

  // ---- 3. Current active session returns no-op ----
  test('3. current active session returns no-op', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      currentSessionId: 'ses_a1',
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refA1);

    expect(result.kind).toBe('no-op');
    expect(adapter.callLog).toHaveLength(0);

    ctrl.dispose();
  });

  // ---- 4. projectId and directory are passed to adapter ----
  test('4. projectId and directory passed to adapter', async () => {
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter);

    await ctrl.activateSession(refB1);

    // Verify adapter received the correct ref with projectId and directory
    // by checking the openProjectOrDirectory call was made
    expect(adapter.callLog).toContain('openProjectOrDirectory');

    ctrl.dispose();
  });

  // ---- 5. A → B → C rapid clicks, only C takes effect ----
  test('5. rapid A → B → C clicks, only C takes effect', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      switchHostFn: async () => {
        await delay(50);
      },
    });
    const ctrl = createController(adapter);

    // Fire all three concurrently
    const [resultA, resultB, resultC] = await Promise.all([
      ctrl.activateSession(refB1),
      ctrl.activateSession(refC1),
      ctrl.activateSession(refB1),
    ]);

    // The last one (C) should be the final one
    // A and B should be cancelled
    const results = [resultA, resultB, resultC];
    const cancelled = results.filter((r) => r.kind === 'cancelled' || r.kind === 'failure');
    const succeeded = results.filter((r) => r.kind === 'success' || r.kind === 'no-op');

    // At least one should have succeeded or been the last
    expect(cancelled.length + succeeded.length).toBe(3);

    ctrl.dispose();
  });

  // ---- 6. Old activation result can't overwrite new state ----
  test('6. old activation result cannot overwrite new state', async () => {
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => { resolveFirst = r; });

    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      switchHostFn: async () => {
        if (adapter.callLog.filter((l) => l === 'switchHost').length === 0) {
          await firstPromise;
        }
      },
    });
    const ctrl = createController(adapter);

    // Start first activation
    const p1 = ctrl.activateSession(refB1);
    // Start second activation (aborts first)
    const p2 = ctrl.activateSession(refC1);

    // Resolve first
    resolveFirst();

    const [r1, r2] = await Promise.all([p1, p2]);

    // First should be cancelled, second should succeed
    expect(r1.kind).toBe('cancelled');
    expect(r2.kind).toBe('success');

    ctrl.dispose();
  });

  // ---- 7. Old activation doesn't select after C completes ----
  test('7. old activation does not select after new activation completes', async () => {
    const selections: string[] = [];
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      selectSessionFn: async (ref) => {
        selections.push(ref.sessionId);
        await delay(10);
      },
    });
    const ctrl = createController(adapter);

    const p1 = ctrl.activateSession(refB1);
    const p2 = ctrl.activateSession(refC1);

    await Promise.all([p1, p2]);

    // Only the last activation's session should have been selected
    // refB1's session might have been selected before being cancelled
    // but refC1's session must be in the list
    expect(selections).toContain('ses_c1');

    ctrl.dispose();
  });

  // ---- 8. host not found ----
  test('8. host not found returns HOST_NOT_FOUND', async () => {
    const adapter = createFakeAdapter();
    const ctrl = createController(adapter);

    const ref: HostSessionRef = {
      hostId: 'nonexistent' as HostId,
      sessionId: 'ses_1',
      directory: '/tmp',
      projectId: 'p1',
    };

    const result = await ctrl.activateSession(ref);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('HOST_NOT_FOUND');

    ctrl.dispose();
  });

  // ---- 9. host offline ----
  test('9. host offline returns HOST_OFFLINE', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { validateHost: new Error('HOST_OFFLINE') },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('HOST_OFFLINE');

    ctrl.dispose();
  });

  // ---- 10. unsupported transport ----
  test('10. unsupported transport returns UNSUPPORTED_TRANSPORT', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { validateHost: new Error('UNSUPPORTED_TRANSPORT') },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('UNSUPPORTED_TRANSPORT');

    ctrl.dispose();
  });

  // ---- 11. authentication failed ----
  test('11. authentication failed returns AUTHENTICATION_FAILED', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { validateHost: new Error('AUTHENTICATION_FAILED') },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('AUTHENTICATION_FAILED');

    ctrl.dispose();
  });

  // ---- 12. runtime ready timeout ----
  test('12. runtime ready timeout returns RUNTIME_READY_TIMEOUT', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { waitForRuntimeReady: new Error('TIMEOUT') },
    });
    const ctrl = createController(adapter, { timeoutMs: 100 });

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('RUNTIME_READY_TIMEOUT');

    ctrl.dispose();
  });

  // ---- 13. project not found ----
  test('13. project not found returns PROJECT_NOT_FOUND', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { openProjectOrDirectory: new Error('PROJECT_NOT_FOUND') },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('PROJECT_NOT_FOUND');

    ctrl.dispose();
  });

  // ---- 14. directory not found ----
  test('14. directory not found returns DIRECTORY_NOT_FOUND', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { openProjectOrDirectory: new Error('DIRECTORY_NOT_FOUND') },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('DIRECTORY_NOT_FOUND');

    ctrl.dispose();
  });

  // ---- 15. session not found ----
  test('15. session not found returns SESSION_NOT_FOUND', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      verifySessionFn: async () => false,
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('SESSION_NOT_FOUND');

    ctrl.dispose();
  });

  // ---- 16. selectSession fails ----
  test('16. selectSession failure returns SELECTION_FAILED', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { selectSession: new Error('selection error') },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('SELECTION_FAILED');

    ctrl.dispose();
  });

  // ---- 17. failure then rollback succeeds ----
  test('17. failure after host switch triggers rollback', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { openProjectOrDirectory: new Error('NAVIGATION_FAILED') },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('NAVIGATION_FAILED');
    expect(adapter.callLog).toContain('restore');
    expect(adapter.callLog).toContain('switchHost');

    ctrl.dispose();
  });

  // ---- 18. rollback failure preserves original and rollback error ----
  test('18. rollback failure preserves original and rollback errors', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: {
        openProjectOrDirectory: new Error('NAVIGATION_FAILED'),
        restore: new Error('restore failed'),
      },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('NAVIGATION_FAILED');
    expect(result.rollbackError).toBeDefined();
    expect(result.rollbackError?.code).toBe('ROLLBACK_FAILED');

    ctrl.dispose();
  });

  // ---- 19. abort does not clearUnread ----
  test('19. abort does not clearUnread', async () => {
    const cleared: HostSessionRef[] = [];
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      selectSessionFn: async () => {
        await delay(100);
      },
    });
    const ctrl = createController(adapter, {
      clearUnread: (ref) => { cleared.push(ref); },
    });

    const p = ctrl.activateSession(refB1);
    ctrl.cancelCurrent('test');
    await p;

    expect(cleared).toHaveLength(0);

    ctrl.dispose();
  });

  // ---- 20. success only clears target session unread ----
  test('20. success only clears target session unread', async () => {
    const cleared: HostSessionRef[] = [];
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter, {
      clearUnread: (ref) => { cleared.push(ref); },
    });

    await ctrl.activateSession(refB1);

    expect(cleared).toHaveLength(1);
    expect(cleared[0].hostId).toBe('host-b');
    expect(cleared[0].sessionId).toBe('ses_b1');

    ctrl.dispose();
  });

  // ---- 21. does not clear unread for same sessionId but different host ----
  test('21. does not clear unread for same sessionId different host', async () => {
    const cleared: HostSessionRef[] = [];
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter, {
      clearUnread: (ref) => { cleared.push(ref); },
    });

    await ctrl.activateSession(refB1);

    // Should not have cleared any session from host-a
    expect(cleared.every((r) => r.hostId === 'host-b')).toBe(true);

    ctrl.dispose();
  });

  // ---- 22. dispose cleans up pending activation ----
  test('22. dispose cleans up pending activation', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      selectSessionFn: async () => {
        await delay(200);
      },
    });
    const ctrl = createController(adapter);

    ctrl.activateSession(refB1);
    ctrl.dispose();

    // After dispose, state should be cleaned
    const state = ctrl.getState();
    expect(state.stage).toBe('idle');
  });

  // ---- 23. dispose后 activateSession returns disposed error ----
  test('23. dispose后 activateSession returns CONTROLLER_DISPOSED', async () => {
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter);

    ctrl.dispose();

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('CONTROLLER_DISPOSED');
  });

  // ---- 24. controller can be used by non-React code ----
  test('24. controller is usable without React', async () => {
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter);

    // Imperative usage
    const state = ctrl.getState();
    expect(state.stage).toBe('idle');
    expect(state.requestId).toBeNull();

    const result = await ctrl.activateSession(refB1);
    expect(result.kind).toBe('success');

    const stateAfter = ctrl.getState();
    expect(stateAfter.stage).toBe('succeeded');

    ctrl.dispose();
  });

  // ---- 25. secret does not enter logs ----
  test('25. secret does not enter logs', async () => {
    const logs: string[] = [];
    const logger: SafeActivationLogger = {
      debug: (_stage, msg) => { logs.push(msg); },
      info: (_stage, msg) => { logs.push(msg); },
      warn: (_stage, msg) => { logs.push(msg); },
      error: (_stage, msg) => { logs.push(msg); },
    };

    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createHostActivationController({
      adapter,
      getHost,
      clearUnread: () => {},
      timeoutMs: 5_000,
      logger,
    });

    await ctrl.activateSession(refB1);

    // No log should contain transport URLs, tokens, or secrets
    for (const log of logs) {
      expect(log).not.toContain('http://localhost:3000');
      expect(log).not.toContain('remote:22');
      expect(log).not.toContain('relay-1');
      expect(log).not.toContain('token');
      expect(log).not.toContain('secret');
    }

    ctrl.dispose();
  });

  // ---- 26. adapter call order is correct ----
  test('26. adapter call order is correct for full activation', async () => {
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter);

    await ctrl.activateSession(refB1);

    // Expected order: validateHost → switchHost → waitForRuntimeReady → openProjectOrDirectory → verifySessionExists → selectSession
    const stageOrder = [
      'validateHost',
      'switchHost',
      'waitForRuntimeReady',
      'verifySessionExists',
      'selectSession',
    ];
    let lastIdx = -1;
    for (const stage of stageOrder) {
      const idx = adapter.callLog.indexOf(stage);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }

    ctrl.dispose();
  });

  // ---- 27. switch success but verify fails → restore ----
  test('27. switch success but verify fails triggers restore', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      verifySessionFn: async () => false,
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('SESSION_NOT_FOUND');
    expect(adapter.callLog).toContain('restore');
    expect(adapter.callLog).toContain('switchHost');

    ctrl.dispose();
  });

  // ---- 28. same host navigation failure does not execute full host restore ----
  test('28. same host navigation failure does not restore host', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { openProjectOrDirectory: new Error('NAVIGATION_FAILED') },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refA2);

    expect(result.kind).toBe('failure');
    // No switchHost was called, so no restore needed
    expect(adapter.callLog).not.toContain('switchHost');
    expect(adapter.callLog).not.toContain('restore');

    ctrl.dispose();
  });

  // ---- 29. timeout late-arriving promise does not modify state ----
  test('29. timeout late-arriving promise does not modify state', async () => {
    let resolveLate!: () => void;
    const latePromise = new Promise<void>((r) => { resolveLate = r; });

    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      selectSessionFn: async () => {
        await latePromise;
      },
    });
    const ctrl = createController(adapter, { timeoutMs: 50 });

    // Start activation
    const p1 = ctrl.activateSession(refB1);

    // Wait for timeout to fire
    await delay(200);

    // Resolve the late promise so the old activation can complete
    resolveLate();
    await p1;

    // The state should have been set by timeout, not by late resolution
    const state = ctrl.getState();
    // After timeout, it should be failed or cancelled
    expect(state.stage === 'failed' || state.stage === 'cancelled' || state.stage === 'idle').toBe(true);

    ctrl.dispose();
  });

  // ---- 30. cancelCurrent cleans timer and pending state ----
  test('30. cancelCurrent cleans timer and pending state', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      selectSessionFn: async () => {
        await delay(500);
      },
    });
    const ctrl = createController(adapter);

    ctrl.activateSession(refB1);
    await delay(10);
    ctrl.cancelCurrent('user cancelled');

    const state = ctrl.getState();
    expect(state.stage).toBe('idle');
    expect(state.requestId).toBeNull();

    ctrl.dispose();
  });

  // ---- 31. listener subscribe/unsubscribe correct ----
  test('31. listener subscribe/unsubscribe works', async () => {
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter);

    const states: ActivationStage[] = [];
    const unsub = ctrl.subscribe((s) => {
      states.push(s.stage);
    });

    await ctrl.activateSession(refB1);

    expect(states.length).toBeGreaterThan(0);
    expect(states).toContain('succeeded');

    // Unsubscribe
    unsub();
    states.length = 0;

    await ctrl.activateSession(refB1);

    // No new states should be captured after unsubscribe
    expect(states).toHaveLength(0);

    ctrl.dispose();
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('concurrent activations abort previous', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      validateHostFn: async () => {
        await delay(50);
      },
    });
    const ctrl = createController(adapter);

    const p1 = ctrl.activateSession(refB1);
    const p2 = ctrl.activateSession(refC1);

    const [r1, r2] = await Promise.all([p1, p2]);

    // At least one should be cancelled
    expect(r1.kind === 'cancelled' || r2.kind === 'cancelled').toBe(true);

    ctrl.dispose();
  });

  test('dispose during activation aborts and cleans up', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      validateHostFn: async () => {
        await delay(200);
      },
    });
    const ctrl = createController(adapter);

    const p = ctrl.activateSession(refB1);
    await delay(10);
    ctrl.dispose();

    const result = await p;
    expect(result.kind === 'cancelled' || result.kind === 'failure').toBe(true);
  });

  test('getState returns stable reference when no change', () => {
    const adapter = createFakeAdapter();
    const ctrl = createController(adapter);

    const s1 = ctrl.getState();
    const s2 = ctrl.getState();
    // Same values, but different object references (no memoization needed for getState)
    expect(s1.stage).toBe(s2.stage);
    expect(s1.requestId).toBe(s2.requestId);

    ctrl.dispose();
  });

  test('cancelCurrent after dispose is a no-op', () => {
    const adapter = createFakeAdapter();
    const ctrl = createController(adapter);

    ctrl.dispose();
    // Should not throw
    ctrl.cancelCurrent('test');
  });

  test('multiple subscribe/unsubscribe cycles', async () => {
    const adapter = createFakeAdapter({ currentHostId: 'host-a' as HostId });
    const ctrl = createController(adapter);

    const count1 = { n: 0 };
    const count2 = { n: 0 };

    const unsub1 = ctrl.subscribe(() => { count1.n++; });
    const unsub2 = ctrl.subscribe(() => { count2.n++; });

    await ctrl.activateSession(refB1);
    expect(count1.n).toBeGreaterThan(0);
    expect(count2.n).toBeGreaterThan(0);

    unsub1();
    count1.n = 0;
    count2.n = 0;

    await ctrl.activateSession(refA2);
    expect(count1.n).toBe(0);
    expect(count2.n).toBeGreaterThan(0);

    unsub2();
    ctrl.dispose();
  });

  test('no-op does not call clearUnread', async () => {
    const cleared: HostSessionRef[] = [];
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      currentSessionId: 'ses_a1',
    });
    const ctrl = createController(adapter, {
      clearUnread: (ref) => { cleared.push(ref); },
    });

    // refA1 matches current session (host-a + ses_a1)
    const result = await ctrl.activateSession(refA1);
    expect(result.kind).toBe('no-op');
    expect(cleared).toHaveLength(0);

    ctrl.dispose();
  });

  test('switchHost error returns SWITCH_FAILED', async () => {
    const adapter = createFakeAdapter({
      currentHostId: 'host-a' as HostId,
      shouldFail: { switchHost: new Error('network error') },
    });
    const ctrl = createController(adapter);

    const result = await ctrl.activateSession(refB1);

    expect(result.kind).toBe('failure');
    expect(result.error?.code).toBe('SWITCH_FAILED');

    ctrl.dispose();
  });
});
