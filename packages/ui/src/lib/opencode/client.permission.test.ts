import { describe, expect, mock, test } from 'bun:test';

type PermissionV2Fixture = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
};

const permissionGetMock = mock((args: { sessionID: string; requestID: string }) => {
  return new Promise<unknown>((resolve, reject) => {
    pendingResolutions.push((r: TestResponse) => {
      if (r.kind === 'throw') {
        reject(new Error('network down'));
      } else if (r.kind === 'ok') {
        resolve(makeSuccessResult(r.permission));
      } else {
        const status = r.kind === 'not-found' ? 404 : 500;
        resolve(makeErrorResult(status));
      }
    });
    pendingArgs.push(args);
  });
});

type TestResponse =
  | { kind: 'ok'; permission: PermissionV2Fixture }
  | { kind: 'not-found' }
  | { kind: 'server-error' }
  | { kind: 'throw' };

const pendingResolutions: Array<(r: TestResponse) => void> = [];
const pendingArgs: Array<{ sessionID: string; requestID: string }> = [];

/**
 * Build a HeyApi success result that matches the wrapper's expectations:
 *   - error === undefined (success branch)
 *   - data.data === the permission (200 status payload)
 *   - response.status === 200
 */
const makeSuccessResult = (permission: PermissionV2Fixture) => ({
  data: { data: permission },
  error: undefined,
  request: new Request('http://test/'),
  response: new Response(null, { status: 200 }),
});

/**
 * Build a HeyApi error result with the given status code.
 */
const makeErrorResult = (status: number) => ({
  data: undefined,
  error: {
    name: status === 404 ? 'PermissionNotFoundError' : 'ServerError',
    data: { message: 'err' },
  },
  request: new Request('http://test/'),
  response: new Response(null, { status }),
});

const createOpencodeClientMock = mock(() => ({
  v2: {
    session: {
      permission: {
        get: permissionGetMock,
      },
    },
  },
}));

(mock as unknown as { restore?: () => void }).restore?.();

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: createOpencodeClientMock,
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

const { opencodeClient } = await import(`./client?cache-test-permission=${Date.now()}`);

/**
 * Drive the in-flight mocked `get()` call to the next resolver with the
 * given response shape. Each test owns exactly one queued call, so this
 * is unambiguous as long as tests do not overlap.
 */
const resolveNext = (response: TestResponse) => {
  queueMicrotask(() => {
    const resolver = pendingResolutions.shift();
    if (resolver) resolver(response);
  });
};

describe('opencodeClient.fetchPermission', () => {
  test('returns state="ok" with the permission when the server returns 200', async () => {
    const permission: PermissionV2Fixture = {
      id: 'perm_1',
      sessionID: 'ses_1',
      action: 'bash',
      resources: ['*'],
    };
    const promise = opencodeClient.fetchPermission('ses_1', 'perm_1');
    resolveNext({ kind: 'ok', permission });
    const result = await promise;
    expect(result.state).toBe('ok');
    if (result.state === 'ok') {
      expect(result.permission).toEqual(permission);
    }
    expect(pendingArgs[0]).toEqual({ sessionID: 'ses_1', requestID: 'perm_1' });
  });

  test('returns state="resolved" when the server returns 404', async () => {
    const promise = opencodeClient.fetchPermission('ses_1', 'perm_gone');
    resolveNext({ kind: 'not-found' });
    const result = await promise;
    expect(result).toEqual({ state: 'resolved' });
  });

  test('returns state="unknown" on non-404 error responses (e.g. 500)', async () => {
    const promise = opencodeClient.fetchPermission('ses_1', 'perm_1');
    resolveNext({ kind: 'server-error' });
    const result = await promise;
    expect(result).toEqual({ state: 'unknown' });
  });

  test('returns state="unknown" when the SDK throws (network failure)', async () => {
    const promise = opencodeClient.fetchPermission('ses_1', 'perm_1');
    resolveNext({ kind: 'throw' });
    const result = await promise;
    expect(result).toEqual({ state: 'unknown' });
  });
});
