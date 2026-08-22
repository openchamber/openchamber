import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionRunner } from './session-runner.js';

const SESSION_ID = 'child-1';
const DIRECTORY = '/work';

// A clock the runner consumes through `now`/`sleep`, fast-forwardable so the
// 15s grace windows never actually wait.
const makeClock = () => {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  };
};

const assistantRecord = ({ id, text, created, completed = created + 1, error = undefined }) => ({
  info: {
    role: 'assistant',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
    time: { created, ...(completed !== undefined ? { completed } : {}) },
    ...(error ? { error } : {}),
  },
  parts: [{ id, type: 'text', text }],
});

const createFakeClient = (overrides = {}) => ({
  session: {
    status: vi.fn(async () => ({ data: {} })),
    messages: vi.fn(async () => ({ data: [] })),
    create: vi.fn(async () => ({ data: { id: 'created-1' } })),
    abort: vi.fn(async () => ({})),
    ...(overrides.session ?? {}),
  },
});

const createRunner = ({ client, fetchImpl, clock = makeClock() } = {}) => createSessionRunner({
  buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
  getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer test' }),
  createClient: () => client ?? createFakeClient(),
  now: clock.now,
  sleep: clock.sleep,
  ...(fetchImpl ? {} : {}),
});

const runPrompt = (runner, client, overrides = {}) => runner.runPromptOnSession({
  client,
  sessionID: SESSION_ID,
  directory: DIRECTORY,
  prompt: 'Write a hook',
  model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
  timeoutMs: null,
  signal: undefined,
  ...overrides,
});

describe('session runner — runPromptOnSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches prompt_async with the model override and returns the final text', async () => {
    const dispatchCalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      dispatchCalls.push({ url: String(url), init });
      return { ok: true };
    }));
    const client = createFakeClient({
      session: {
        status: vi.fn(async () => ({ data: { [SESSION_ID]: { type: 'busy' } } })),
        messages: vi.fn(async () => ({ data: [
          assistantRecord({ id: 'm1', text: 'the answer', created: 1000 }),
        ] })),
      },
    });
    // busy on the first poll, idle afterwards so the wait exits.
    client.session.status
      .mockResolvedValueOnce({ data: { [SESSION_ID]: { type: 'busy' } } })
      .mockResolvedValue({ data: { [SESSION_ID]: { type: 'idle' } } });

    const runner = createRunner({ client });
    const result = await runPrompt(runner, client);

    expect(dispatchCalls).toHaveLength(1);
    const { url, init } = dispatchCalls[0];
    expect(new URL(url).pathname).toBe(`/session/${SESSION_ID}/prompt_async`);
    expect(new URL(url).searchParams.get('directory')).toBe(DIRECTORY);
    expect(JSON.parse(init.body)).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      parts: [{ type: 'text', text: 'Write a hook' }],
    });
    expect(result.text).toBe('the answer');
    expect(result.truncated).toBe(false);
    expect(result.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  it('picks the newest completed assistant message regardless of list order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const client = createFakeClient({
      session: {
        status: vi.fn(async () => ({ data: { [SESSION_ID]: { type: 'idle' } } })),
        // Newest-first: a naive last-match scan would return the older text.
        messages: vi.fn(async () => ({ data: [
          assistantRecord({ id: 'm2', text: 'newest answer', created: 2000 }),
          assistantRecord({ id: 'm1', text: 'older answer', created: 1000 }),
        ] })),
      },
    });

    const runner = createRunner({ client });
    const result = await runPrompt(runner, client);
    expect(result.text).toBe('newest answer');
  });

  it('surfaces a failed run as its provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const client = createFakeClient({
      session: {
        status: vi.fn(async () => ({ data: { [SESSION_ID]: { type: 'idle' } } })),
        messages: vi.fn(async () => ({ data: [
          assistantRecord({
            id: 'm1',
            text: '',
            created: 1000,
            error: { data: { message: 'Insufficient Balance' } },
          }),
        ] })),
      },
    });

    const runner = createRunner({ client });
    await expect(runPrompt(runner, client)).rejects.toThrow('Insufficient Balance');
  });

  it('fails fast when the dispatch never produces activity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const client = createFakeClient(); // always idle, never any messages

    const runner = createRunner({ client });
    await expect(runPrompt(runner, client)).rejects.toMatchObject({
      statusCode: 500,
      message: 'The run did not start; no assistant activity was recorded',
    });
    expect(client.session.status.mock.calls.length).toBeGreaterThan(30);
  });

  it('fails when a run goes idle after activity without a completed assistant message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const client = createFakeClient({
      session: {
        messages: vi.fn(async () => ({ data: [
          assistantRecord({ id: 'm1', text: 'partial', created: 1000, completed: null }),
        ] })),
      },
    });
    client.session.status
      .mockResolvedValueOnce({ data: { [SESSION_ID]: { type: 'busy' } } })
      .mockResolvedValue({ data: { [SESSION_ID]: { type: 'idle' } } });

    const runner = createRunner({ client });
    await expect(runPrompt(runner, client)).rejects.toMatchObject({
      statusCode: 500,
      message: 'The run ended without a completed assistant message',
    });
  });

  it('surfaces a failed prompt_async dispatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => 'provider exploded',
    })));
    const client = createFakeClient();

    const runner = createRunner({ client });
    await expect(runPrompt(runner, client)).rejects.toThrow('prompt_async failed (502)');
  });
});

describe('session runner — validateModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects models unknown to the provider snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        providers: [{ id: 'anthropic', models: [{ id: 'claude-sonnet-4' }] }],
      }),
    })));
    const runner = createRunner();
    await expect(runner.validateModels(DIRECTORY, ['anthropic/unknown-model'])).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Unknown model'),
    });
    await expect(runner.validateModels(DIRECTORY, ['anthropic/claude-sonnet-4'])).resolves.toBeUndefined();
  });

  it('fails open when the provider snapshot cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
    const runner = createRunner();
    await expect(runner.validateModels(DIRECTORY, ['anything/at-all'])).resolves.toBeUndefined();
  });
});

describe('session runner — createChildSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates with flattened parentID and title', async () => {
    const client = createFakeClient();
    const runner = createRunner({ client });
    const session = await runner.createChildSession({
      client,
      parentID: 'parent-1',
      directory: DIRECTORY,
      title: 'Fused: a/b',
    });
    expect(session.id).toBe('created-1');
    expect(client.session.create).toHaveBeenCalledWith({
      directory: DIRECTORY,
      parentID: 'parent-1',
      title: 'Fused: a/b',
    });
  });

  it('surfaces the real creation failure with status and server message', async () => {
    const client = createFakeClient({
      session: {
        create: vi.fn(async () => ({
          data: undefined,
          response: { status: 400 },
          error: { message: 'parent not found' },
        })),
      },
    });
    const runner = createRunner({ client });
    await expect(runner.createChildSession({
      client,
      parentID: 'parent-1',
      directory: DIRECTORY,
      title: 'Fused: a/b',
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('parent not found'),
    });
  });
});

describe('session runner — abortSessions', () => {
  it('counts fulfilled aborts', async () => {
    const client = createFakeClient();
    client.session.abort
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('gone'));
    const runner = createRunner({ client });
    await expect(runner.abortSessions({
      client,
      sessionIDs: ['a', 'b'],
      directory: DIRECTORY,
    })).resolves.toBe(1);
  });
});
