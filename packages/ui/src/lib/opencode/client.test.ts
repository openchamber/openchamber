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
