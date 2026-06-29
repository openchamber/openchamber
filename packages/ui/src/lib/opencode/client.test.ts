import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ConfigResponse = { data: Record<string, unknown> };
type SessionCreateResult = { data?: unknown; error?: unknown };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(response: ConfigResponse) => void> = [];
let configCalls = 0;
let sessionCreateResult: SessionCreateResult = { data: null };
const sessionCreateCalls: Array<Record<string, unknown>> = [];

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock(() => ({
    config: {
      get: mock(() => {
        configCalls += 1;
        return new Promise<ConfigResponse>((resolve) => {
          configResolvers.push(resolve);
        });
      }),
    },
    session: {
      create: mock((params: Record<string, unknown>) => {
        sessionCreateCalls.push(params);
        return Promise.resolve(sessionCreateResult);
      }),
    },
  })),
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

describe('opencodeClient createSession', () => {
  beforeEach(() => {
    sessionCreateCalls.length = 0;
    sessionCreateResult = { data: null };
  });

  test('copies location.directory to directory when server returns V2 shape', async () => {
    sessionCreateResult = {
      data: {
        id: 'session-1',
        title: 'New session',
        projectID: 'project-1',
        version: '2',
        location: { directory: '/workspace/project' },
        time: { created: 1, updated: 1 },
      },
    };

    const session = await opencodeClient.createSession({ title: 'New session' }, '/workspace/project');

    expect(session.id).toBe('session-1');
    expect(session.directory).toBe('/workspace/project');
    expect(sessionCreateCalls.length).toBe(1);
    expect(sessionCreateCalls[0].directory).toBe('/workspace/project');
  });

  test('preserves existing directory field when server returns legacy shape', async () => {
    sessionCreateResult = {
      data: {
        id: 'session-2',
        title: 'Legacy session',
        projectID: 'project-2',
        version: '2',
        directory: '/legacy/project',
        location: { directory: '/different/project' },
        time: { created: 1, updated: 1 },
      },
    };

    const session = await opencodeClient.createSession({ title: 'Legacy session' }, '/legacy/project');

    expect(session.directory).toBe('/legacy/project');
  });

  test('falls back to request directory when server omits both fields', async () => {
    sessionCreateResult = {
      data: {
        id: 'session-3',
        title: 'No directory',
        projectID: 'project-3',
        version: '2',
        time: { created: 1, updated: 1 },
      },
    };

    const session = await opencodeClient.createSession({ title: 'No directory' }, '/workspace/project');

    expect((session as { directory?: string }).directory).toBe('/workspace/project');
  });

  test('leaves directory unset when neither field is present and no request directory', async () => {
    sessionCreateResult = {
      data: {
        id: 'session-4',
        title: 'No directory',
        projectID: 'project-4',
        version: '2',
        time: { created: 1, updated: 1 },
      },
    };

    const session = await opencodeClient.createSession({ title: 'No directory' }, null);

    expect((session as { directory?: string }).directory).toBe(undefined);
  });
});
