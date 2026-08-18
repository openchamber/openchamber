import { afterEach, describe, expect, it, vi } from 'vitest';

import { createContextObligatoryRuntime } from './runtime.js';

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

describe('context obligatory runtime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('injects pinned text in chronological order after compaction and records the summary cursor', async () => {
    const requests = [];
    let sessionReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1' && init.method === 'PATCH') return json({});
      if (url.pathname === '/session/ses_1') {
        sessionReads += 1;
        return json({
          id: 'ses_1',
          metadata: { openchamber: { context_obligatory_messages: [
            { id: 'msg_2', createdAt: 20, role: 'assistant' },
            { id: 'msg_1', createdAt: 10, role: 'user' },
          ] } },
        });
      }
      if (url.pathname === '/session/ses_1/message') return json([
        { info: { id: 'msg_agent', role: 'assistant', providerID: 'provider', modelID: 'model', agent: 'build' } },
        { info: { id: 'msg_summary', role: 'assistant', summary: true, time: { completed: 30 } } },
      ]);
      if (url.pathname === '/session/ses_1/message/msg_1') return json({ parts: [{ type: 'text', text: 'First' }] });
      if (url.pathname === '/session/ses_1/message/msg_2') return json({ parts: [{ type: 'text', text: 'Second' }] });
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));
    const runtime = createContextObligatoryRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
    });

    await runtime.processPayload({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });

    const prompt = requests.find((request) => request.path.endsWith('/prompt_async'));
    const payload = JSON.parse(prompt.body);
    expect(payload).toMatchObject({
      model: { providerID: 'provider', modelID: 'model' },
      agent: 'build',
      parts: [{ type: 'text', synthetic: true }],
    });
    expect(payload.parts[0].text.indexOf('First')).toBeLessThan(payload.parts[0].text.indexOf('Second'));
    expect(payload.parts[0].text).toContain('continuing the pre-compaction work');
    expect(payload.parts[0].text).toContain('use it silently as background context');
    expect(payload.parts[0].text).toContain('Only if no tasks or next steps remain');
    expect(payload.parts[0].text).toContain('no more than one short paragraph');
    const patch = requests.find((request) => request.method === 'PATCH');
    expect(JSON.parse(patch.body).metadata.openchamber.context_obligatory_last_compaction_message_id).toBe('msg_summary');
    expect(sessionReads).toBe(2);
    runtime.stop();
  });


  it('restores project knowledge after compaction even with nothing pinned', async () => {
    // Pinned messages are already in the conversation until compaction removes
    // them; project knowledge was never there at all, so a session with no
    // pinned messages still has something to get back.
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1' && init.method === 'PATCH') return json({});
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1', metadata: {} });
      if (url.pathname === '/session/ses_1/message') return json([
        { info: { id: 'msg_agent', role: 'assistant', providerID: 'provider', modelID: 'model', agent: 'build' } },
        { info: { id: 'msg_summary', role: 'assistant', summary: true, time: { completed: 30 } } },
      ]);
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));
    const runtime = createContextObligatoryRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      sessionKnowledgeRuntime: {
        metadataKey: 'knowledge_context_delivered',
        readDeliveredSignature: () => '',
        resolvePending: async () => ({ text: '## Pinned notes\n\n- Remember this.', signature: 'sig-1' }),
      },
    });

    await runtime.processPayload({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });

    const prompt = requests.find((request) => request.path.endsWith('/prompt_async'));
    expect(JSON.parse(prompt.body).parts[0].text).toContain('Remember this.');
    const patch = requests.find((request) => request.method === 'PATCH');
    // Recorded with the cursor, so the next ordinary send does not repeat it.
    expect(JSON.parse(patch.body).metadata.openchamber.knowledge_context_delivered).toBe('sig-1');
  });

  it('sends pinned messages and project knowledge as one message', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET', body: init.body });
      if (url.pathname === '/session/ses_1' && init.method === 'PATCH') return json({});
      if (url.pathname === '/session/ses_1') return json({
        id: 'ses_1',
        metadata: { openchamber: { context_obligatory_messages: [{ id: 'msg_1', createdAt: 10, role: 'user' }] } },
      });
      if (url.pathname === '/session/ses_1/message') return json([
        { info: { id: 'msg_agent', role: 'assistant', providerID: 'provider', modelID: 'model', agent: 'build' } },
        { info: { id: 'msg_summary', role: 'assistant', summary: true, time: { completed: 30 } } },
      ]);
      if (url.pathname === '/session/ses_1/message/msg_1') return json({ parts: [{ type: 'text', text: 'Pinned message' }] });
      if (url.pathname === '/session/ses_1/prompt_async') return json({});
      throw new Error(`Unexpected ${url.pathname}`);
    }));
    const runtime = createContextObligatoryRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      sessionKnowledgeRuntime: {
        metadataKey: 'knowledge_context_delivered',
        readDeliveredSignature: () => '',
        resolvePending: async () => ({ text: 'Pinned notes block', signature: 'sig-1' }),
      },
    });

    await runtime.processPayload({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });

    // One turn, not two: back-to-back synthetic messages read as the agent
    // being interrupted twice.
    const prompts = requests.filter((request) => request.path.endsWith('/prompt_async'));
    expect(prompts).toHaveLength(1);
    const text = JSON.parse(prompts[0].body).parts[0].text;
    expect(text).toContain('Pinned notes block');
    expect(text).toContain('Pinned message');
  });

  it('does nothing when the session already carries the knowledge and has no pins', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      requests.push({ path: url.pathname, method: init.method ?? 'GET' });
      if (url.pathname === '/session/ses_1') return json({ id: 'ses_1', metadata: {} });
      throw new Error(`Unexpected ${url.pathname}`);
    }));
    const runtime = createContextObligatoryRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      sessionKnowledgeRuntime: {
        metadataKey: 'knowledge_context_delivered',
        readDeliveredSignature: () => 'sig-1',
        resolvePending: async () => ({ text: '', signature: 'sig-1' }),
      },
    });

    await runtime.processPayload({ type: 'session.compacted', properties: { sessionID: 'ses_1' } });

    expect(requests.some((request) => request.path.endsWith('/prompt_async'))).toBe(false);
  });

  it('ignores ordinary idle events without making requests', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createContextObligatoryRuntime({
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
    });
    await runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
    expect(fetchImpl).not.toHaveBeenCalled();
    runtime.stop();
  });
});
