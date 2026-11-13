import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildRestartNotification } from './restart-notification.js';
import { createSessionRuntime, RESTART_RESUME_GRACE_MS } from './session-runtime.js';
import { restartInterruptedNotification } from '../session-interruption/restart.js';
import { createAutomationAdmission, sessionKey } from '../session-automation/runtime.js';
import { createSessionInterruptionRuntime } from '../session-interruption/runtime.js';
import { createAutoResumeRuntime } from '../session-interruption/auto-resume.js';
import { createSessionMetadataStore } from '../openchamber-sessions/session-metadata-store.js';

const recoveryDetails = async (fetchImpl) => {
  let metadata = { openchamber: { priority: { at: 1 } } };
  const openCode = {
    read: async () => structuredClone(metadata),
    write: async (_id, next) => { metadata = structuredClone(next); },
  };
  const reloadStore = () => createSessionMetadataStore({
    dataDir: '/tmp/opencode/restart-recovery-test',
    openCode,
    fsPromises: { readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
  });
  const store = reloadStore();
  const interruption = createSessionInterruptionRuntime({
    updateMetadata: store.updateSessionMetadata,
    now: () => 100,
    createClient: () => ({
      session: { get: async () => ({ title: 'Question', directory: '/repo' }) },
      message: { list: async () => ({ data: [{
        id: 'msg_q', type: 'assistant',
        content: [{ type: 'tool', id: 'call_q', name: 'question', state: { status: 'running', input: { questions: [{ question: 'Color?' }] } } }],
      }] }) },
    }),
  });
  const runtime = createSessionRuntime({
    writeSseEvent() {},
    getNotificationClients: () => new Set(),
    buildOpenCodeUrl: (route) => `http://localhost:49722${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    fetchImpl,
  });
  const busy = () => {
    const payload = { type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } } };
    runtime.processOpenCodeSsePayload(payload);
    interruption.processPayload(payload, '/repo');
  };
  busy();
  await interruption.recordRestartInterruptions({ ...runtime.interruptBusySessionsAfterRestart(), cause: 'process-exited' });
  return { runtime, store, reloadStore, busy };
};

describe('managed OpenCode restart session recovery', () => {
  afterEach(() => vi.useRealTimers());

  it('settles busy sessions and switches to manual guidance after automatic recovery', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const events = [];
    const sessionRuntime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      broadcastEvent: (event) => events.push(event),
      buildOpenCodeUrl: (path) => `http://localhost:49722${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async () => ({ ok: true }),
    });
    const markBusy = (sessionID) => sessionRuntime.processOpenCodeSsePayload({
      type: 'session.status',
      properties: { sessionID, status: { type: 'busy' } },
    });

    try {
      markBusy('session-1');
      markBusy('session-2');
      markBusy('session-3');
      events.length = 0;
      const recovery = sessionRuntime.interruptBusySessionsAfterRestart();

      expect(sessionRuntime.getActiveSessionCount()).toBe(0);
      expect(Object.values(sessionRuntime.getSessionStateSnapshot()).map((state) => state.status))
        .toEqual(['idle', 'idle', 'idle']);
      expect(events.filter((event) => event.type === 'openchamber:session-status')).toHaveLength(3);
      expect(events.filter((event) => event.type === 'session.error')).toHaveLength(3);
      expect(buildRestartNotification(recovery)).toMatchObject({
        kind: 'opencode-restart-resuming',
        sessionId: 'session-1',
        body: expect.stringContaining('resume automatically'),
      });

      await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
      markBusy('session-1');
      const repeated = sessionRuntime.interruptBusySessionsAfterRestart();
      expect(repeated.autoResumeSessionIds).toEqual([]);
      expect(buildRestartNotification(repeated)).toMatchObject({
        kind: 'opencode-restart-interrupted',
        body: 'OpenCode restarted during a running response. Send a message to continue.',
      });
      expect(buildRestartNotification(sessionRuntime.interruptBusySessionsAfterRestart())).toBeNull();
    } finally {
      sessionRuntime.dispose();
    }
  });

  it('uses manual guidance for a batch with an exhausted session', () => {
    expect(buildRestartNotification({ sessionIds: ['used', 'new'], autoResumeSessionIds: ['new'] }))
      .toMatchObject({
        kind: 'opencode-restart-interrupted',
        body: 'OpenCode restarted during running responses. Send a message in each chat to continue.',
      });
  });

  it('waits for automation ownership without spending recovery attempts and leases every send', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const automation = createAutomationAdmission();
    await automation.ready();
    const keys = [sessionKey('session-1')];
    automation.claim('fixloop:1', keys);
    const fetchImpl = vi.fn(async () => {
      expect(() => automation.claim('review:1', keys)).toThrow();
      return fetchImpl.mock.calls.length === 1 ? { ok: false, status: 503 } : { ok: true };
    });
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      buildOpenCodeUrl: (route) => `http://localhost:49722${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      acquireRestartResume: async (sessionId) => {
        await automation.ready();
        return automation.trySend(null, [sessionKey(sessionId)]);
      },
      fetchImpl,
    });
    const markBusy = () => runtime.processOpenCodeSsePayload({
      type: 'session.status', properties: { sessionID: 'session-1', status: { type: 'busy' } },
    });
    try {
      markBusy();
      expect(runtime.interruptBusySessionsAfterRestart().autoResumeSessionIds).toEqual(['session-1']);
      await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS + 60_000);
      expect(fetchImpl).not.toHaveBeenCalled();

      automation.release('fixloop:1');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body).id).toBe(JSON.parse(fetchImpl.mock.calls[1][1].body).id);
      expect(() => automation.claim('review:1', keys)).not.toThrow();
      markBusy();
      expect(runtime.interruptBusySessionsAfterRestart().autoResumeSessionIds).toEqual([]);
    } finally {
      runtime.dispose();
    }
  });

  it('keeps manual recovery metadata after exhausted automatic retries and reload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const { runtime, reloadStore, busy } = await recoveryDetails(fetchImpl);
    try {
      await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS + 45_000);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      const restored = reloadStore();
      const metadata = await restored.get('session-1');
      expect(metadata.openchamber).toMatchObject({
        priority: { at: 1 },
        interruption: { reason: 'opencode-restart', at: 100, cause: 'process-exited', tool: { name: 'question', callID: 'call_q' } },
        restartCutTurn: { messageID: 'msg_q', callID: 'call_q' },
        pendingQuestion: { messageID: 'msg_q', callID: 'call_q', title: 'Color?' },
      });
      const sendPrompt = vi.fn(async () => busy());
      const manual = createAutoResumeRuntime({ updateMetadata: restored.updateSessionMetadata, sendPrompt, readMemory: () => null });
      expect(await manual.continueManually({ sessionId: 'session-1', directory: '/repo', at: 100 })).toBe('sent');
      expect((await restored.get('session-1')).openchamber.interruption).toBeUndefined();
      expect(sendPrompt).toHaveBeenCalledOnce();
      expect(runtime.interruptBusySessionsAfterRestart().autoResumeSessionIds).toEqual([]);
      await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      manual.stop();
    } finally {
      runtime.dispose();
      vi.restoreAllMocks();
    }
  });

  it('clears recovered details on busy while retaining the cut-turn marker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const { runtime, store, reloadStore, busy } = await recoveryDetails(fetchImpl);
    try {
      await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
      expect(fetchImpl).toHaveBeenCalledOnce();
      // HTTP admission alone does not prove the session has started running.
      expect((await store.get('session-1')).openchamber.pendingQuestion).toBeDefined();
      busy();
      await vi.advanceTimersByTimeAsync(0);
      expect((await reloadStore().get('session-1')).openchamber).toEqual({
        priority: { at: 1 },
        restartCutTurn: { messageID: 'msg_q', at: 100, callID: 'call_q', toolName: 'question' },
      });
    } finally {
      runtime.dispose();
    }
  });

  it('includes manual recovery targets when a later restart exhausts every session budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const runtime = createSessionRuntime({
      writeSseEvent() {},
      getNotificationClients: () => new Set(),
      buildOpenCodeUrl: (route) => `http://localhost:49722${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
    });
    try {
      for (const sessionID of ['session-1', 'session-2', 'session-3']) {
        runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } });
      }
      const recovery = runtime.interruptBusySessionsAfterRestart();
      expect(recovery.autoResumeSessionIds).toEqual(['session-1', 'session-2', 'session-3']);
      await vi.advanceTimersByTimeAsync(RESTART_RESUME_GRACE_MS);
      for (const sessionID of recovery.sessionIds) {
        runtime.processOpenCodeSsePayload({ type: 'session.status', properties: { sessionID, status: { type: 'busy' } } });
      }
      const repeated = runtime.interruptBusySessionsAfterRestart();
      const manualIds = repeated.sessionIds.filter((id) => !repeated.autoResumeSessionIds.includes(id));
      expect(restartInterruptedNotification(manualIds.map((sessionId) => ({ sessionId, directory: '/repo', title: null }))))
        .toMatchObject({
          kind: 'opencode-restart-interrupted',
          sessions: [
            { sessionId: 'session-1', directory: '/repo' },
            { sessionId: 'session-2', directory: '/repo' },
            { sessionId: 'session-3', directory: '/repo' },
          ],
        });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      runtime.dispose();
    }
  });
});
