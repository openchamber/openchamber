import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ConfigResponse = { data: Record<string, unknown> };
type SessionRecord = { info: { id: string; role?: string }; parts: Array<Record<string, unknown>> };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(response: ConfigResponse) => void> = [];
let configCalls = 0;
const createClientCalls: Array<{ baseUrl: string; directory?: string }> = [];
const sessionMessagesCalls: Array<{ clientIndex: number; params: Record<string, unknown> }> = [];
const sessionMessageCalls: Array<{ clientIndex: number; params: Record<string, unknown> }> = [];
const sessionMessagesResponse: { data: SessionRecord[] } = {
  data: [{ info: { id: 'msg-1', role: 'assistant' }, parts: [] }],
};
const sessionMessageResponse: { data: SessionRecord | null } = {
  data: { info: { id: 'msg-lookup', role: 'user' }, parts: [{ id: 'part-1', type: 'text', text: 'hello' }] },
};
const promptAsyncCalls: unknown[][] = [];
const promptAsyncResults: Array<unknown> = [];

const promptAsyncMock = mock(async (...args: unknown[]) => {
  promptAsyncCalls.push(args);
  const next = promptAsyncResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { response: new Response(null, { status: 200 }) };
});

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock((config: { baseUrl: string; directory?: string }) => {
    const clientIndex = createClientCalls.push(config) - 1;
    return {
      config: {
        get: mock(() => {
          configCalls += 1;
          return new Promise<ConfigResponse>((resolve) => {
            configResolvers.push(resolve);
          });
        }),
      },
      session: {
        promptAsync: promptAsyncMock,
        messages: mock((params: Record<string, unknown>) => {
          sessionMessagesCalls.push({ clientIndex, params });
          return Promise.resolve(sessionMessagesResponse);
        }),
        message: mock((params: Record<string, unknown>) => {
          sessionMessageCalls.push({ clientIndex, params });
          return Promise.resolve(sessionMessageResponse);
        }),
      },
    };
  }),
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => 'test-runtime'),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  configResolvers.length = 0;
  configCalls = 0;
  createClientCalls.length = 0;
  sessionMessagesCalls.length = 0;
  sessionMessageCalls.length = 0;
  opencodeClient.setDirectory(undefined);
  promptAsyncCalls.length = 0;
  promptAsyncResults.length = 0;
});

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(configCalls).toBe(2);
  });
});

describe('opencodeClient session message wrappers', () => {
  test('drops order when paginating with a cursor', async () => {
    const directory = '/workspace/project-session-messages-test';
    opencodeClient.setDirectory(directory);

    const records = await opencodeClient.getSessionMessages('session-a', {
      limit: 25,
      cursor: 'cursor-1',
      order: 'asc',
    });

    expect(records).toEqual(sessionMessagesResponse.data);
    expect(createClientCalls.some((call) => call.directory === directory)).toBe(true);
    expect(sessionMessagesCalls).toHaveLength(1);
    expect(sessionMessagesCalls[0].params).toEqual({
      sessionID: 'session-a',
      limit: 25,
      cursor: 'cursor-1',
    });
  });

  test('looks up a single message through a scoped client', async () => {
    const directory = '/workspace/project-message-lookup-test';
    const record = await opencodeClient.getMessage('session-a', 'msg-lookup', directory);

    expect(record).toEqual(sessionMessageResponse.data);
    expect(createClientCalls.some((call) => call.directory === directory)).toBe(true);
    expect(sessionMessageCalls).toHaveLength(1);
    expect(sessionMessageCalls[0].params).toEqual({
      sessionID: 'session-a',
      messageID: 'msg-lookup',
    });
  });
});

describe('opencodeClient prompt retry behavior', () => {
  const sendPrompt = (providerID = 'anthropic') => opencodeClient.sendMessage({
    id: 'ses_1',
    providerID,
    modelID: 'claude-sonnet',
    text: 'hello',
  });

  test('does not retry 504 prompt responses because the POST may already be accepted', async () => {
    promptAsyncResults.push({ response: new Response('gateway timeout', { status: 504 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-504');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (504)');
  });

  test('does not retry transport failures because the tunnel may have lost only the response', async () => {
    promptAsyncResults.push(new TypeError('Failed to fetch'));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-network');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to fetch');
  });

  test('does not fabricate an HTTP 500 when the SDK swallows a transport failure into result.error', async () => {
    // The SDK catches thrown fetch errors and returns { error, response: undefined }.
    // That is a transport failure, not a server 500 — it must surface as a
    // descriptive transport error, never as "Failed to send message (500): {}".
    promptAsyncResults.push({ error: new TypeError('relay tunnel reset: plaintext frame on established channel'), response: undefined });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-transport');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('Failed to send message (500)');
    expect(message).toContain('transport failure');
    expect(message).toContain('relay tunnel reset');
    expect((error as Error & { status?: number }).status).toBe(undefined);
  });

  test('does not retry 503 prompt responses because proxy errors can be ambiguous too', async () => {
    promptAsyncResults.push({ response: new Response('starting', { status: 503 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-503');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (503)');
  });
});
