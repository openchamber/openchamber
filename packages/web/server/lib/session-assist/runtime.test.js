import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionAssistRuntime } from './runtime.js';

const resources = [];
const message = (id, role, text, extra = {}) => ({
  info: { id, role, parentID: 'user', finish: 'stop', time: { completed: 1 }, providerID: 'test-provider', modelID: 'test-model', ...extra },
  parts: [{ type: 'text', text }],
});
const output = (recap = 'Зміни готові', suggestion = '') => ({ text: JSON.stringify({ recap, suggestion }), providerID: 'test-provider', modelID: 'test-model' });
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

async function fixture(generate = async () => output()) {
  const state = {
    messages: [message('user', 'user', 'Виправ помилку'), message('answer', 'assistant', 'Виправлено')],
    session: { id: 'session', directory: '/project', time: {}, metadata: { external: 'keep', openchamber: { note: 'keep' } } },
    targets: { recap: true, suggestion: true },
    gets: 0, failFresh: false, patches: [], requests: [], calls: [],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    state.requests.push({ method: request.method, directory: url.searchParams.get('directory'), limit: url.searchParams.get('limit'), auth: request.headers['x-test-auth'] });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'PATCH') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      state.patches.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.end(JSON.stringify(state.session));
    } else if (url.pathname.endsWith('/message')) {
      response.end(JSON.stringify(url.searchParams.get('limit') === '1' ? state.messages.slice(-1) : state.messages));
    } else {
      state.gets++;
      response.statusCode = state.failFresh && state.gets > 1 ? 500 : 200;
      response.end(JSON.stringify(state.session));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  state.base = base;
  const runtime = createSessionAssistRuntime({
    buildOpenCodeUrl: (route) => state.base + route,
    getOpenCodeAuthHeaders: () => ({ 'x-test-auth': 'fixture' }),
    getTargets: () => state.targets,
    quietMs: 1,
    getSmallModelService: async () => ({
      describeSmallModel: async () => ({ inputCharBudget: 64_000 }),
      generateSmallModelText: async (args) => { state.calls.push(args); return generate(args, state); },
    }),
  });
  resources.push({ runtime, server });
  const status = (type) => runtime.processPayload({ type: 'session.status', properties: { sessionID: 'session', status: { type } } }, '/project');
  return { state, runtime, status };
}

afterEach(async () => {
  for (const { runtime, server } of resources.splice(0)) {
    runtime.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  vi.restoreAllMocks();
});

describe('session assist runtime', () => {
  it('uses bounded authenticated SDK reads and preserves metadata with an empty suggestion', async () => {
    const { state, status } = await fixture(async (_args, current) => {
      current.session.metadata.openchamber.concurrent = 'new';
      return output();
    });
    status('idle');
    await vi.waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.requests.every((r) => r.directory === '/project' && r.auth === 'fixture')).toBe(true);
    expect(state.requests.filter((r) => r.limit).map((r) => r.limit)).toEqual(['50', '1']);
    expect(state.calls[0]).toMatchObject({ restrictToPreferredProvider: true, onOverflow: 'error', preferredProviderID: 'test-provider', preferredModelID: 'test-model', sessionID: 'session' });
    expect(state.patches[0].metadata).toMatchObject({ external: 'keep', openchamber: {
      note: 'keep', concurrent: 'new', assist: { recap: 'Зміни готові', suggestion: '', forMessageID: 'answer' },
    } });
  });

  it('does no work with both settings off and skips child, archived, or reverted sessions', async () => {
    const { state, status } = await fixture();
    state.targets = { recap: false, suggestion: false };
    status('idle');
    await pause();
    expect(state.requests).toHaveLength(0);
    state.targets.recap = true;
    state.session.parentID = 'parent';
    status('idle');
    await vi.waitFor(() => expect(state.gets).toBe(1));
    delete state.session.parentID;
    state.session.revert = { messageID: 'user' };
    status('idle');
    await vi.waitFor(() => expect(state.gets).toBe(2));
    delete state.session.revert;
    state.session.time.archived = 1;
    status('idle');
    await vi.waitFor(() => expect(state.gets).toBe(3));
    expect(state.calls).toHaveLength(0);
  });

  it('keeps recent context for recap-only and performs no write for an empty suggestion-only result', async () => {
    const { state, status } = await fixture();
    state.targets.suggestion = false;
    state.messages.unshift(message('previous-user', 'user', 'Попередня задача'), message('previous-answer', 'assistant', 'Зміст зробленого', { parentID: 'previous-user' }));
    status('idle');
    await vi.waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.calls[0].prompt).toContain('Зміст зробленого');
    expect(state.calls[0].system).not.toContain('suggestion');
    state.targets = { recap: false, suggestion: true };
    status('idle');
    await vi.waitFor(() => expect(state.calls).toHaveLength(2));
    await pause();
    expect(state.patches).toHaveLength(1);
  });

  it('does not write a stale result when the tail moves during generation', async () => {
    const { state, status } = await fixture(async (_args, current) => {
      current.messages.push(message('new-user', 'user', 'Нова задача'));
      return output();
    });
    status('idle');
    await vi.waitFor(() => expect(state.requests.some((r) => r.limit === '1')).toBe(true));
    await pause();
    expect(state.patches).toHaveLength(0);
  });

  it('does not fall back to stale metadata when the fresh read fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state, status } = await fixture();
    state.failFresh = true;
    status('idle');
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(state.gets).toBe(2);
    expect(state.patches).toHaveLength(0);
  });

  it('cancels old work and retains an expired newer idle timer until it can run', async () => {
    const releases = [];
    const { state, status } = await fixture(() => new Promise((resolve) => releases.push(resolve)));
    status('idle');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    status('busy');
    expect(state.calls[0].signal.aborted).toBe(true);
    state.messages.push(message('next-user', 'user', 'Далі'), message('next-answer', 'assistant', 'Готово', { parentID: 'next-user' }));
    status('idle');
    await pause();
    releases[0](output('Старий результат'));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(state.patches).toHaveLength(0);
    releases[1](output('Новий результат'));
    await vi.waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.patches[0].metadata.openchamber.assist).toMatchObject({ recap: 'Новий результат', forMessageID: 'next-answer' });
  });

  it('aborts on stop and honors settings switched off during generation', async () => {
    let release;
    const { state, runtime, status } = await fixture(() => new Promise((resolve) => { release = resolve; }));
    status('idle');
    await vi.waitFor(() => expect(state.calls).toHaveLength(1));
    runtime.stop();
    expect(state.calls[0].signal.aborted).toBe(true);
    release(output());
    await pause();
    expect(state.patches).toHaveLength(0);
    const second = await fixture(async (_args, current) => {
      current.targets = { recap: false, suggestion: false };
      return output();
    });
    second.status('idle');
    await vi.waitFor(() => expect(second.state.gets).toBe(2));
    await pause();
    expect(second.state.patches).toHaveLength(0);
  });

  it('ignores historical user updates but cancels a new request during generation', async () => {
    let release;
    const { state, runtime, status } = await fixture(() => new Promise((resolve) => { release = resolve; }));
    status('idle');
    await vi.waitFor(() => expect(state.calls).toHaveLength(1));
    const userUpdate = (created) => runtime.processPayload({ type: 'message.updated', properties: {
      info: { id: 'user', sessionID: 'session', role: 'user', time: { created } },
    } });
    userUpdate(1);
    expect(state.calls[0].signal.aborted).toBe(false);
    userUpdate(Date.now());
    expect(state.calls[0].signal.aborted).toBe(true);
    release(output());
    await pause();
    expect(state.patches).toHaveLength(0);
  });

  it('rejects endpoint changes before writing instead of carrying a session into a new runtime', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { state, status } = await fixture(async (_args, current) => {
      current.base = 'http://unreachable.invalid';
      return output();
    });
    status('idle');
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(state.patches).toHaveLength(0);
    expect(state.gets).toBe(1);
  });
});
