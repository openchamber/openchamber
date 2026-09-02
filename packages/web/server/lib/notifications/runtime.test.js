import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { createNotificationTriggerRuntime } from './runtime.js';

function createSseResponse({ blocks = [], signal, holdOpen = false } = {}) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              return { value: encoder.encode(blocks[index++]), done: false };
            }
            if (holdOpen) {
              return new Promise((resolve, reject) => {
                const onAbort = () => {
                  signal.removeEventListener('abort', onAbort);
                  const error = new Error('Aborted');
                  error.name = 'AbortError';
                  reject(error);
                };
                signal.addEventListener('abort', onAbort, { once: true });
              });
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

async function waitForAssertion(assertion) {
  const deadline = Date.now() + 1000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function createNotificationRuntime() {
  const emitDesktopNotification = vi.fn();
  const broadcastUiNotification = vi.fn();
  const sendPushToAllUiSessions = vi.fn(async () => {});
  const sendApnsToAllUiSessions = vi.fn(async () => {});
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({
      nativeNotificationsEnabled: true,
      notificationMode: 'always',
    }),
    prepareNotificationLastMessage: async ({ message }) => message,
    buildTemplateVariables: async () => ({}),
    extractLastMessageText: (payload) => payload.properties?.info?.parts?.[0]?.text ?? '',
    fetchLastAssistantMessageText: async () => '',
    resolveNotificationTemplate: (template, variables) => template.replace('{last_message}', variables.last_message ?? ''),
    shouldApplyResolvedTemplateMessage: () => true,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    isAnyInteractiveClientVisible: () => false,
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
  });

  return {
    runtime,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('notification trigger runtime with opencode2 events', () => {
  it('delivers a question notification from a V2 form.created event', async () => {
    vi.useFakeTimers();
    const { runtime, emitDesktopNotification, broadcastUiNotification, sendPushToAllUiSessions, sendApnsToAllUiSessions } = createNotificationRuntime();
    const deliveries = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async (_url, { signal }) => createSseResponse({
        signal,
        holdOpen: true,
        blocks: [
          'data: {"id":"evt-form","type":"form.created","data":{"form":{"id":"form-1","sessionID":"ses-1","title":"Choose a target","fields":[{"key":"target","type":"string","title":"Target","description":"Where should this go?"}]}},"location":{"directory":"/workspace"}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent(({ payload }) => {
      deliveries.push(runtime.maybeSendPushForTrigger(payload));
    });

    try {
      hub.start();
      await flushMicrotasks();
      expect(deliveries).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
      expect(sendPushToAllUiSessions).toHaveBeenCalled();

      expect(emitDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'question',
        body: 'Where should this go?',
        sessionId: 'ses-1',
        directory: '/workspace',
      }));
      expect(broadcastUiNotification).toHaveBeenCalled();
      expect(sendPushToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({
        tag: 'question-ses-1',
        data: expect.objectContaining({ type: 'question', sessionId: 'ses-1' }),
      }), { requireNoSse: true });
      expect(sendApnsToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Agent needs your input',
        data: { sessionId: 'ses-1' },
      }), { requireNoSse: true });
    } finally {
      hub.stop();
    }
  });

  it('delivers an error notification from a V2 execution failure', async () => {
    const { runtime, emitDesktopNotification, sendPushToAllUiSessions } = createNotificationRuntime();
    const deliveries = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'data: {"id":"evt-error","type":"session.execution.failed","data":{"sessionID":"ses-1","error":{"type":"unknown","message":"The agent failed"}},"location":{"directory":"/workspace"}}\n\n',
        ],
      }),
    });
    hub.subscribeEvent(({ payload }) => {
      deliveries.push(runtime.maybeSendPushForTrigger(payload));
    });

    try {
      hub.start();
      await waitForAssertion(() => expect(deliveries).toHaveLength(1));
      await deliveries[0];

      expect(emitDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        body: 'The agent failed',
        sessionId: 'ses-1',
        directory: '/workspace',
      }));
      expect(sendPushToAllUiSessions).toHaveBeenCalledWith(expect.objectContaining({
        tag: 'error-ses-1',
        body: 'The agent failed',
      }), { requireNoSse: true });
    } finally {
      hub.stop();
    }
  });
});
