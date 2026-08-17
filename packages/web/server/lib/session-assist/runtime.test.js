import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionAssistRuntime } from './runtime.js';

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

describe('session assist runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('routes every session read and metadata patch through the event workspace', async () => {
    const requests = [];
    const messages = [
      {
        info: { id: 'msg_user', sessionID: 'ses_1', role: 'user' },
        parts: [{ type: 'text', text: 'Continue the task.' }],
      },
      {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_1',
          parentID: 'msg_user',
          role: 'assistant',
          providerID: 'provider',
          modelID: 'model',
        },
        parts: [{ type: 'text', text: 'The task is complete.' }],
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, workspace: url.searchParams.get('workspace'), method: init.method ?? 'GET' });
      if (url.pathname === '/session/ses_1/message') return json(messages);
      if (url.pathname === '/session/ses_1' && init.method === 'PATCH') return json({});
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1', metadata: {} });
      throw new Error(`Unexpected ${url.pathname}`);
    }));
    const runtime = createSessionAssistRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({
        generateSmallModelText: async () => ({
          text: '{"recap":"Task complete","suggestion":"Validate the result."}',
          providerID: 'provider',
          modelID: 'model',
        }),
      }),
      quietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: 'ses_1', status: { type: 'idle' }, directory: '/workspace' },
    }, '/workspace', 'wrk_1');
    await vi.advanceTimersByTimeAsync(10);

    expect(requests.some((request) => request.method === 'PATCH')).toBe(true);
    expect(requests.every((request) => request.workspace === 'wrk_1')).toBe(true);
    runtime.stop();
  });
});
