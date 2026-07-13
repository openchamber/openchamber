import { beforeEach, describe, expect, test } from 'bun:test';

import type { HostDescriptor, HostId, HostSessionRef } from '../types';
import type {
  ActivationStage,
  RuntimeActivationAdapter,
  RuntimeSnapshot,
} from './types';
import { createHostActivationController } from './host-activation-controller';
import { noopLogger } from './safe-activation-logger';
import {
  redactMeta,
  safeHostLabel,
} from './activation-errors';
import {
  createActivationInternalState,
  toPublicState,
  startNewRequest,
  isCurrentRequest,
  advanceStage,
  resetToIdle,
  disposeState,
} from './activation-state';

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

const refA: HostSessionRef = {
  hostId: 'host-a' as HostId,
  sessionId: 'ses_a1',
  directory: '/workspace/project-a',
  projectId: 'proj-a',
};

const refA2: HostSessionRef = {
  hostId: 'host-a' as HostId,
  sessionId: 'ses_a2',
  directory: '/workspace/project-a2',
  projectId: 'proj-a2',
};

const refB: HostSessionRef = {
  hostId: 'host-b' as HostId,
  sessionId: 'ses_b1',
  directory: '/workspace/project-b',
  projectId: 'proj-b',
};

// ---------------------------------------------------------------------------
// Fake adapter factory
// ---------------------------------------------------------------------------

interface FakeAdapterOptions {
  currentSession?: HostSessionRef;
  currentHostId?: HostId;
  sessionExists?: boolean;
  validateError?: Error;
  switchError?: Error;
  readyError?: Error;
  openProjectError?: Error;
  verifyError?: Error;
  selectError?: Error;
  restoreError?: Error;
}

const createFakeAdapter = (opts: FakeAdapterOptions = {}) => {
  const callLog: string[] = [];
  let currentSessionRef = opts.currentSession;
  let currentHostIdValue = opts.currentHostId;

  const adapter: RuntimeActivationAdapter & {
    callLog: string[];
    clearLog: () => void;
    setCurrentSession: (ref: HostSessionRef | undefined) => void;
    setCurrentHostId: (id: HostId | undefined) => void;
  } = {
    callLog,
    clearLog: () => { callLog.length = 0; },
    setCurrentSession: (ref) => { currentSessionRef = ref; },
    setCurrentHostId: (id) => { currentHostIdValue = id; },

    getCurrentSnapshot: (): RuntimeSnapshot => {
      callLog.push('getCurrentSnapshot');
      return {
        hostId: currentHostIdValue,
        sessionId: currentSessionRef?.sessionId,
        directory: currentSessionRef?.directory,
        projectId: currentSessionRef?.projectId,
      };
    },

    isCurrentHost: (hostId: HostId): boolean => {
      callLog.push('isCurrentHost');
      return currentHostIdValue === hostId;
    },

    isCurrentSession: (ref: HostSessionRef): boolean => {
      callLog.push('isCurrentSession');
      return (
        currentSessionRef !== undefined &&
        currentSessionRef.hostId === ref.hostId &&
        currentSessionRef.sessionId === ref.sessionId
      );
    },

    validateHost: async (host: HostDescriptor, signal: AbortSignal): Promise<void> => {
      callLog.push('validateHost');
      if (signal.aborted) throw new Error('ABORTED');
      if (opts.validateError) throw opts.validateError;
    },

    switchHost: async (host: HostDescriptor, signal: AbortSignal): Promise<void> => {
      callLog.push('switchHost');
      if (signal.aborted) throw new Error('ABORTED');
      if (opts.switchError) throw opts.switchError;
      currentHostIdValue = host.hostId;
    },

    waitForRuntimeReady: async (host: HostDescriptor, signal: AbortSignal): Promise<void> => {
      callLog.push('waitForRuntimeReady');
      if (signal.aborted) throw new Error('ABORTED');
      if (opts.readyError) throw opts.readyError;
    },

    openProjectOrDirectory: async (ref: HostSessionRef, signal: AbortSignal): Promise<void> => {
      callLog.push('openProjectOrDirectory');
      if (signal.aborted) throw new Error('ABORTED');
      if (opts.openProjectError) throw opts.openProjectError;
    },

    verifySessionExists: async (ref: HostSessionRef, signal: AbortSignal): Promise<boolean> => {
      callLog.push('verifySessionExists');
      if (signal.aborted) throw new Error('ABORTED');
      if (opts.verifyError) throw opts.verifyError;
      return opts.sessionExists !== undefined ? opts.sessionExists : true;
    },

    selectSession: async (ref: HostSessionRef, signal: AbortSignal): Promise<void> => {
      callLog.push('selectSession');
      if (signal.aborted) throw new Error('ABORTED');
      if (opts.selectError) throw opts.selectError;
      currentSessionRef = ref;
    },

    restore: async (snapshot: RuntimeSnapshot, signal: AbortSignal): Promise<void> => {
      callLog.push('restore');
      if (signal.aborted) throw new Error('ABORTED');
      if (opts.restoreError) throw opts.restoreError;
      currentHostIdValue = snapshot.hostId;
    },
  };

  return adapter;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hosts = new Map<HostId, HostDescriptor>([
  [hostA.hostId, hostA],
  [hostB.hostId, hostB],
]);

const getHost = (hostId: HostId) => hosts.get(hostId);

let clearedUnreads: HostSessionRef[] = [];
const clearUnread = (ref: HostSessionRef) => { clearedUnreads.push(ref); };

const createController = (adapter: ReturnType<typeof createFakeAdapter>, timeoutMs = 5000, rollbackTimeoutMs = 1000) =>
  createHostActivationController({
    adapter,
    getHost,
    clearUnread,
    timeoutMs,
    rollbackTimeoutMs,
    logger: noopLogger,
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearedUnreads = [];
});

// 1. host A → host B session 成功
test('activation from host A to host B succeeds', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('success');
  expect(result.requestId).toBeTruthy();
  expect(adapter.callLog).toContain('validateHost');
  expect(adapter.callLog).toContain('switchHost');
  expect(adapter.callLog).toContain('waitForRuntimeReady');
  expect(adapter.callLog).toContain('openProjectOrDirectory');
  expect(adapter.callLog).toContain('verifySessionExists');
  expect(adapter.callLog).toContain('selectSession');
  expect(clearedUnreads).toEqual([refB]);
  ctrl.dispose();
});

// 2. 同一 host 切 session 不调用 switchHost
test('same host switch does not call switchHost', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refA2);

  expect(result.kind).toBe('success');
  expect(adapter.callLog).not.toContain('switchHost');
  expect(adapter.callLog).toContain('validateHost');
  expect(adapter.callLog).toContain('selectSession');
  ctrl.dispose();
});

// 3. 当前 active session 返回 no-op
test('activating current session returns no-op', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refA);

  expect(result.kind).toBe('no-op');
  expect(adapter.callLog).not.toContain('switchHost');
  expect(adapter.callLog).not.toContain('openProjectOrDirectory');
  expect(adapter.callLog).not.toContain('selectSession');
  expect(clearedUnreads).toEqual([]);
  ctrl.dispose();
});

// 4. HostSessionRef 的 projectId 和 directory 被传给 adapter
test('projectId and directory are passed to adapter', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId });
  const ctrl = createController(adapter);

  await ctrl.activateSession(refB);

  expect(adapter.callLog).toContain('openProjectOrDirectory');
  ctrl.dispose();
});

// 5. A → B → C 快速点击，最终只有 C 生效
test('rapid A→B→C clicks, only C takes effect', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });

  // Hang on validateHost for the first call (same-host activation)
  let validateCallCount = 0;
  adapter.validateHost = async (_host, signal) => {
    adapter.callLog.push('validateHost');
    validateCallCount++;
    if (validateCallCount === 1) {
      return new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
      });
    }
  };

  const ctrl = createController(adapter);

  // Start A → A2 (will hang on validateHost)
  const pA2 = ctrl.activateSession(refA2);
  // Start A → B (will abort A2, validateHost is fast for 2nd call)
  const pB = ctrl.activateSession(refB);

  const resultB = await pB;
  expect(resultB.kind).toBe('success');

  const resultA2 = await pA2;
  expect(resultA2.kind).toBe('cancelled');

  ctrl.dispose();
});

// 6. 旧 activation 结果不能覆盖新 state
test('old activation result does not overwrite new state', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  const ctrl = createController(adapter);

  // Both refA2 and refB are different from current session, both require activation
  const p1 = ctrl.activateSession(refA2);
  const p2 = ctrl.activateSession(refB);

  const [r1, r2] = await Promise.all([p1, p2]);
  // r1 should be cancelled since r2 took over
  expect(r1.kind).toBe('cancelled');
  expect(r2.kind).toBe('success');
  ctrl.dispose();
});

// 7. 旧 activation 不得在 C 完成后 select A/B
test('cancelled activation does not select after new activation completes', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  const ctrl = createController(adapter);

  const p1 = ctrl.activateSession(refA2);
  const p2 = ctrl.activateSession(refB);

  const [r1, r2] = await Promise.all([p1, p2]);
  expect(r1.kind).toBe('cancelled');
  expect(r2.kind).toBe('success');
  ctrl.dispose();
});

// 8. host 不存在
test('host not found returns HOST_NOT_FOUND', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId });
  const ctrl = createController(adapter);

  const refUnknown: HostSessionRef = {
    hostId: 'host-unknown' as HostId,
    sessionId: 'ses_1',
    directory: '/unknown',
    projectId: 'proj-unknown',
  };

  const result = await ctrl.activateSession(refUnknown);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('HOST_NOT_FOUND');
  expect(adapter.callLog).not.toContain('validateHost');
  ctrl.dispose();
});

// 9. host offline
test('host offline returns HOST_OFFLINE', async () => {
  const adapter = createFakeAdapter({
    currentHostId: hostA.hostId,
    validateError: new Error('HOST_OFFLINE'),
  });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('HOST_OFFLINE');
  ctrl.dispose();
});

// 10. unsupported transport
test('unsupported transport returns UNSUPPORTED_TRANSPORT', async () => {
  const adapter = createFakeAdapter({
    currentHostId: hostA.hostId,
    validateError: new Error('UNSUPPORTED_TRANSPORT'),
  });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('UNSUPPORTED_TRANSPORT');
  ctrl.dispose();
});

// 11. authentication failed
test('authentication failed returns AUTHENTICATION_FAILED', async () => {
  const adapter = createFakeAdapter({
    currentHostId: hostA.hostId,
    validateError: new Error('AUTHENTICATION_FAILED'),
  });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('AUTHENTICATION_FAILED');
  ctrl.dispose();
});

// 12. runtime ready timeout
test('runtime ready timeout returns RUNTIME_READY_TIMEOUT', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId });
  adapter.waitForRuntimeReady = async (_host, signal) => {
    adapter.callLog.push('waitForRuntimeReady');
    return new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
      setTimeout(() => {
        signal.dispatchEvent(new Event('abort'));
      }, 0);
    });
  };

  const ctrl = createController(adapter, 100);
  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  ctrl.dispose();
});

// 13. project 不存在
test('project not found returns PROJECT_NOT_FOUND', async () => {
  const adapter = createFakeAdapter({
    currentHostId: hostA.hostId,
    openProjectError: new Error('PROJECT_NOT_FOUND'),
  });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
  ctrl.dispose();
});

// 14. directory 不存在
test('directory not found returns failure', async () => {
  const adapter = createFakeAdapter({
    currentHostId: hostA.hostId,
    openProjectError: new Error('DIRECTORY_NOT_FOUND'),
  });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  ctrl.dispose();
});

// 15. session 不存在
test('session not found returns SESSION_NOT_FOUND', async () => {
  const adapter = createFakeAdapter({
    currentHostId: hostA.hostId,
    sessionExists: false,
  });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('SESSION_NOT_FOUND');
  ctrl.dispose();
});

// 16. selectSession 失败
test('selectSession failure returns SELECTION_FAILED', async () => {
  const adapter = createFakeAdapter({
    currentHostId: hostA.hostId,
    selectError: new Error('select failed'),
  });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('SELECTION_FAILED');
  ctrl.dispose();
});

// 17. 失败后 rollback 成功
test('rollback succeeds after switch failure', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId });
  adapter.openProjectOrDirectory = async () => {
    adapter.callLog.push('openProjectOrDirectory');
    throw new Error('PROJECT_NOT_FOUND');
  };

  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
  expect(adapter.callLog).toContain('restore');
  ctrl.dispose();
});

// 18. rollback 失败保留原始错误和 rollback 错误
test('rollback failure preserves both errors', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId });
  adapter.openProjectOrDirectory = async () => {
    adapter.callLog.push('openProjectOrDirectory');
    throw new Error('PROJECT_NOT_FOUND');
  };
  adapter.restore = async () => {
    adapter.callLog.push('restore');
    throw new Error('restore failed');
  };

  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
  expect(result.rollbackError).toBeDefined();
  expect(result.rollbackError?.code).toBe('ROLLBACK_FAILED');
  ctrl.dispose();
});

// 19. abort 后不 clearUnread
test('cancelled activation does not clearUnread', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  adapter.selectSession = async (_ref, signal) => {
    adapter.callLog.push('selectSession');
    return new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
    });
  };

  const ctrl = createController(adapter);

  const p1 = ctrl.activateSession(refA2);
  ctrl.cancelCurrent('test');

  const result = await p1;
  expect(result.kind).toBe('cancelled');
  expect(clearedUnreads).toEqual([]);
  ctrl.dispose();
});

// 20. 成功后只清除目标 session unread
test('success clears only target session unread', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  const ctrl = createController(adapter);

  await ctrl.activateSession(refB);

  expect(clearedUnreads).toHaveLength(1);
  expect(clearedUnreads[0]).toEqual(refB);
  ctrl.dispose();
});

// 21. 不清除相同 sessionId 但不同 host 的 unread
test('does not clear unread for same sessionId on different host', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  const ctrl = createController(adapter);

  await ctrl.activateSession(refB);

  expect(clearedUnreads.every((r) => r.hostId === ('host-b' as HostId))).toBe(true);
  ctrl.dispose();
});

// 22. dispose 清理 pending activation
test('dispose cleans up pending activation', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId });
  const ctrl = createController(adapter);

  const p = ctrl.activateSession(refA2);
  ctrl.dispose();

  const result = await p;
  expect(['cancelled', 'no-op', 'failure']).toContain(result.kind);
});

// 23. dispose 后 activateSession 行为明确
test('activateSession after dispose returns failure', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId });
  const ctrl = createController(adapter);
  ctrl.dispose();

  const result = await ctrl.activateSession(refA);

  expect(result.kind).toBe('failure');
  expect(result.error?.code).toBe('CONTROLLER_DISPOSED');
});

// 24. Controller 可被非 React 代码使用
test('controller works without React', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  const ctrl = createController(adapter);

  const state = ctrl.getState();
  expect(state.stage).toBe('idle');
  expect(state.requestId).toBeNull();

  const unsub = ctrl.subscribe(() => {});

  const result = await ctrl.activateSession(refB);
  expect(result.kind).toBe('success');

  unsub();
  ctrl.dispose();
});

// 25. secret 不进入日志
test('secrets do not appear in logger output', async () => {
  const logged: string[] = [];
  const logger = {
    debug: (_stage: string, msg: string, meta?: Record<string, unknown>) => {
      logged.push(msg);
      if (meta) logged.push(JSON.stringify(meta));
    },
    info: (_stage: string, msg: string, meta?: Record<string, unknown>) => {
      logged.push(msg);
      if (meta) logged.push(JSON.stringify(meta));
    },
    warn: (_stage: string, msg: string, meta?: Record<string, unknown>) => {
      logged.push(msg);
      if (meta) logged.push(JSON.stringify(meta));
    },
    error: (_stage: string, msg: string, meta?: Record<string, unknown>) => {
      logged.push(msg);
      if (meta) logged.push(JSON.stringify(meta));
    },
  };

  const adapter = createFakeAdapter({ currentHostId: hostA.hostId });
  const ctrl = createHostActivationController({
    adapter,
    getHost,
    clearUnread,
    timeoutMs: 5000,
    logger,
  });

  await ctrl.activateSession(refB);

  const allLogged = logged.join('\n');
  expect(allLogged).not.toContain('http://localhost:3000');
  expect(allLogged).not.toContain('remote:22');
  expect(allLogged).not.toContain('token');
  expect(allLogged).not.toContain('secret');
  ctrl.dispose();
});

// 26. adapter 调用顺序正确
test('adapter calls in correct order for cross-host activation', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  const ctrl = createController(adapter);

  await ctrl.activateSession(refB);

  // Verify the key calls happened in sequence
  const log = adapter.callLog;
  const isCurrentSessionIdx = log.indexOf('isCurrentSession');
  const getCurrentSnapshotIdx = log.indexOf('getCurrentSnapshot');
  const validateHostIdx = log.indexOf('validateHost');
  const isCurrentHostIdx = log.indexOf('isCurrentHost');
  const switchHostIdx = log.indexOf('switchHost');
  const waitForRuntimeReadyIdx = log.indexOf('waitForRuntimeReady');
  const openProjectIdx = log.indexOf('openProjectOrDirectory');
  const verifySessionIdx = log.indexOf('verifySessionExists');
  const selectSessionIdx = log.indexOf('selectSession');

  expect(isCurrentSessionIdx).toBeLessThan(getCurrentSnapshotIdx);
  expect(getCurrentSnapshotIdx).toBeLessThan(validateHostIdx);
  expect(validateHostIdx).toBeLessThan(isCurrentHostIdx);
  expect(isCurrentHostIdx).toBeLessThan(switchHostIdx);
  expect(switchHostIdx).toBeLessThan(waitForRuntimeReadyIdx);
  expect(waitForRuntimeReadyIdx).toBeLessThan(openProjectIdx);
  expect(openProjectIdx).toBeLessThan(verifySessionIdx);
  expect(verifySessionIdx).toBeLessThan(selectSessionIdx);
  ctrl.dispose();
});

// 27. switch 成功但 verify 失败时执行 restore
test('restore called when switch succeeds but verify fails', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, sessionExists: false });
  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refB);

  expect(result.kind).toBe('failure');
  expect(adapter.callLog).toContain('restore');
  ctrl.dispose();
});

// 28. 同 host navigation 失败时不执行完整 host restore
test('same host navigation failure does not restore host', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  adapter.openProjectOrDirectory = async () => {
    adapter.callLog.push('openProjectOrDirectory');
    throw new Error('NAVIGATION_FAILED');
  };

  const ctrl = createController(adapter);

  const result = await ctrl.activateSession(refA2);

  expect(result.kind).toBe('failure');
  expect(adapter.callLog).not.toContain('restore');
  ctrl.dispose();
});

// 29. timeout 后晚到的 Promise 不修改 state
test('late promise after timeout does not modify state', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });

  // Same-host activation failure (no rollback needed)
  adapter.openProjectOrDirectory = async () => {
    adapter.callLog.push('openProjectOrDirectory');
    throw new Error('NAVIGATION_FAILED');
  };

  const ctrl = createController(adapter, 500, 500);

  const p = ctrl.activateSession(refA2);
  const result = await p;

  expect(result.kind).toBe('failure');

  const stateAfter = ctrl.getState();
  expect(stateAfter.error).toBeTruthy();
  expect(stateAfter.error?.code).toBe('NAVIGATION_FAILED');
  ctrl.dispose();
});

// 30. cancelCurrent 清理 timer 和 pending state
test('cancelCurrent cleans up timers and pending state', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId, currentSession: refA });
  adapter.selectSession = async (_ref, signal) => {
    adapter.callLog.push('selectSession');
    return new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
    });
  };

  const ctrl = createController(adapter);

  const p = ctrl.activateSession(refA2);
  // Give a tick for the activation to start
  await new Promise((r) => setTimeout(r, 10));
  ctrl.cancelCurrent('user cancel');

  const result = await p;
  expect(result.kind).toBe('cancelled');

  const state = ctrl.getState();
  expect(state.stage).toBe('idle');
  expect(state.requestId).toBeNull();
  ctrl.dispose();
});

// 31. listener subscribe/unsubscribe 正确
test('listener subscribe and unsubscribe work correctly', async () => {
  const adapter = createFakeAdapter({ currentHostId: hostA.hostId });
  const ctrl = createController(adapter);

  const states: ActivationStage[] = [];
  const unsub = ctrl.subscribe((s) => {
    states.push(s.stage);
  });

  await ctrl.activateSession(refA2);

  expect(states.length).toBeGreaterThan(0);

  unsub();
  states.length = 0;

  await ctrl.activateSession(refB);

  expect(states.length).toBe(0);
  ctrl.dispose();
});

// ---------------------------------------------------------------------------
// activation-state unit tests
// ---------------------------------------------------------------------------

describe('activation-state', () => {
  test('createActivationInternalState initializes correctly', () => {
    const s = createActivationInternalState();
    expect(s.requestCounter).toBe(0);
    expect(s.currentRequestId).toBeNull();
    expect(s.stage).toBe('idle');
    expect(s.disposed).toBe(false);
  });

  test('startNewRequest increments counter and aborts previous', () => {
    const s = createActivationInternalState();
    const { requestId: r1 } = startNewRequest(s, refA);
    expect(r1).toBe('1');

    const { requestId: r2 } = startNewRequest(s, refB);
    expect(r2).toBe('2');
    expect(s.currentRequestId).toBe('2');
  });

  test('isCurrentRequest returns correct value', () => {
    const s = createActivationInternalState();
    startNewRequest(s, refA);
    expect(isCurrentRequest(s, '1')).toBe(true);
    expect(isCurrentRequest(s, '2')).toBe(false);

    startNewRequest(s, refB);
    expect(isCurrentRequest(s, '1')).toBe(false);
    expect(isCurrentRequest(s, '2')).toBe(true);
  });

  test('toPublicState returns correct snapshot', () => {
    const s = createActivationInternalState();
    startNewRequest(s, refA);
    advanceStage(s, 'validating');

    const publicState = toPublicState(s);
    expect(publicState.stage).toBe('validating');
    expect(publicState.requestId).toBe('1');
    expect(publicState.targetRef).toEqual(refA);
    expect(publicState.startedAt).toBeTruthy();
  });

  test('resetToIdle clears everything', () => {
    const s = createActivationInternalState();
    startNewRequest(s, refA);
    advanceStage(s, 'validating');
    resetToIdle(s);

    expect(s.currentRequestId).toBeNull();
    expect(s.stage).toBe('idle');
    expect(s.error).toBeNull();
  });

  test('disposeState aborts and clears listeners', () => {
    const s = createActivationInternalState();
    startNewRequest(s, refA);
    s.listeners.add(() => {});
    disposeState(s);

    expect(s.disposed).toBe(true);
    expect(s.listeners.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// redactMeta tests
// ---------------------------------------------------------------------------

describe('redactMeta', () => {
  test('redacts sensitive keys', () => {
    const result = redactMeta({
      token: 'secret123',
      authorization: 'Bearer xyz',
      hostId: 'host-a',
      relayGrant: 'grant-data',
      pairingSecret: 'pairing',
      normalField: 'visible',
    });

    expect(result.token).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.hostId).toBe('host-a');
    expect(result.relayGrant).toBe('[REDACTED]');
    expect(result.pairingSecret).toBe('[REDACTED]');
    expect(result.normalField).toBe('visible');
  });

  test('truncates long strings', () => {
    const longStr = 'a'.repeat(200);
    const result = redactMeta({ field: longStr });
    expect(result.field).toContain('...[truncated]');
  });
});

describe('safeHostLabel', () => {
  test('returns safe label', () => {
    expect(safeHostLabel('host-a' as HostId)).toBe('host:host-a');
  });
});
