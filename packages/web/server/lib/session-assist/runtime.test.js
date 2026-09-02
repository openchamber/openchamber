import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { createSessionAssistRuntime } from './runtime.js';

const SESSION_ID = 'ses-1';
const DIRECTORY = '/workspace';

const messages = [
  {
    info: {
      id: 'msg-user',
      sessionID: SESSION_ID,
      role: 'user',
      time: { created: 1 },
    },
    parts: [{ type: 'text', text: 'Finish the task' }],
  },
  {
    info: {
      id: 'msg-assistant',
      sessionID: SESSION_ID,
      role: 'assistant',
      parentID: 'msg-user',
      providerID: 'provider-1',
      modelID: 'model-1',
      time: { created: 2, completed: 3 },
    },
    parts: [{ type: 'text', text: 'The task is complete' }],
  },
];

function createSseResponse({ signal }) {
  const encoder = new TextEncoder();
  let sent = false;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (!sent) {
              sent = true;
              return {
                value: encoder.encode('data: {"id":"evt-idle","type":"session.execution.succeeded","data":{"sessionID":"ses-1"},"location":{"directory":"/workspace"}}\n\n'),
                done: false,
              };
            }
            return new Promise((resolve, reject) => {
              const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              };
              signal.addEventListener('abort', onAbort, { once: true });
            });
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session assist runtime with opencode2 events', () => {
  it('starts the idle assist flow when the hub translates execution success', async () => {
    const requests = [];
    const generateSmallModelText = vi.fn(async () => ({
      text: '{"recap":"The task is complete","suggestion":"Continue with the next task"}',
      providerID: 'provider-1',
      modelID: 'model-1',
    }));
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ pathname: url.pathname, search: url.search, method: init.method ?? 'GET' });
      if (url.pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return Response.json({});
      if (url.pathname === `/session/${SESSION_ID}`) return Response.json({ id: SESSION_ID, metadata: {} });
      if (url.pathname === `/session/${SESSION_ID}/message`) return Response.json(messages);
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchImpl);

    const assist = createSessionAssistRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText }),
      quietMs: 1,
    });
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeProtocol: () => 'opencode2',
      upstreamReconnectDelayMs: 100,
      fetchImpl: async (_url, { signal }) => createSseResponse({ signal }),
    });
    hub.subscribeEvent(({ payload, directory }) => assist.processPayload(payload, directory));

    try {
      hub.start();
      await waitForAssertion(() => expect(generateSmallModelText).toHaveBeenCalledOnce());

      expect(generateSmallModelText).toHaveBeenCalledWith(expect.objectContaining({
        directory: DIRECTORY,
        preferredProviderID: 'provider-1',
        preferredModelID: 'model-1',
      }));
      expect(requests).toContainEqual({ pathname: `/session/${SESSION_ID}`, search: '?directory=%2Fworkspace', method: 'PATCH' });
    } finally {
      assist.stop();
      hub.stop();
    }
  });
});
