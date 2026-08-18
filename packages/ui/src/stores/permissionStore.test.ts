import { beforeEach, describe, expect, mock, test } from 'bun:test';

let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => fetchImpl(input, init),
}));
mock.module('@/sync/sync-refs', () => ({ getAllSyncSessionMap: () => new Map() }));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => ({ getDirectoryForSession: () => '/project' }) },
}));
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: { getDirectory: () => '/fallback' },
}));

const { usePermissionStore } = await import('./permissionStore');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('permission store server policy', () => {
  beforeEach(() => {
    usePermissionStore.getState().reset();
    usePermissionStore.setState({ legacyCandidate: null, legacyRuntimeKey: null });
    fetchImpl = async () => json({ sessions: {} });
  });

  test('hydrates the authoritative server snapshot', async () => {
    fetchImpl = async () => json({ sessions: { root: true } });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
  });

  test('preserves previous state when hydration fails', async () => {
    usePermissionStore.setState({ autoAccept: { root: true }, loaded: true });
    fetchImpl = async () => json({}, 503);
    await expect(usePermissionStore.getState().hydrate()).rejects.toThrow();
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
  });

  test('updates local state only after server persistence succeeds', async () => {
    fetchImpl = async () => json({}, 500);
    await expect(usePermissionStore.getState().setSessionAutoAccept('root', true)).rejects.toThrow();
    expect(usePermissionStore.getState().autoAccept).toEqual({});
  });

  test('sends the session directory for immediate pending reconciliation', async () => {
    let body: unknown;
    fetchImpl = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json({ sessions: { root: true } });
    };
    await usePermissionStore.getState().setSessionAutoAccept('root', true);
    expect(body).toEqual({ enabled: true, directory: '/project' });
  });

  test('migrates a legacy local policy when the server has no policy yet', async () => {
    usePermissionStore.setState({ legacyCandidate: { root: true }, legacyRuntimeKey: null });
    const requests: string[] = [];
    fetchImpl = async (input) => {
      requests.push(input);
      return input.includes('/sessions/')
        ? json({ sessions: { root: true } })
        : json({ sessions: {} });
    };
    await usePermissionStore.getState().hydrate();
    expect(requests).toEqual(['/api/permission-auto-accept', '/api/permission-auto-accept/sessions/root']);
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
    expect(usePermissionStore.getState().legacyCandidate).toBe(null);
  });

  test('rejects a hydration response from before reset', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    fetchImpl = async () => oldResponse;
    const oldHydration = usePermissionStore.getState().hydrate();

    usePermissionStore.getState().reset();
    fetchImpl = async () => json({ sessions: { current: true }, revision: 2 });
    await usePermissionStore.getState().hydrate();
    resolveOld(json({ sessions: { stale: true }, revision: 1 }));
    await oldHydration;

    expect(usePermissionStore.getState().autoAccept).toEqual({ current: true });
  });

  test('rejects a mutation response from before reset', async () => {
    let resolveOld!: (response: Response) => void;
    fetchImpl = async () => new Promise<Response>((resolve) => { resolveOld = resolve; });
    const mutation = usePermissionStore.getState().setSessionAutoAccept('stale', true);

    usePermissionStore.getState().reset();
    resolveOld(json({ sessions: { stale: true }, revision: 1 }));
    await mutation;

    expect(usePermissionStore.getState().autoAccept).toEqual({});
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('keeps the highest authoritative revision when mutations resolve out of order', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchImpl = async () => new Promise<Response>((resolve) => { resolvers.push(resolve); });
    const first = usePermissionStore.getState().setSessionAutoAccept('first', true);
    const second = usePermissionStore.getState().setSessionAutoAccept('second', true);

    resolvers[1](json({ sessions: { first: true, second: true }, revision: 2 }));
    await second;
    resolvers[0](json({ sessions: { first: true }, revision: 1 }));
    await first;

    expect(usePermissionStore.getState().autoAccept).toEqual({ first: true, second: true });
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('ignores an older broadcast revision', () => {
    usePermissionStore.getState().applySnapshot({ sessions: { current: true }, revision: 4 });
    usePermissionStore.getState().applySnapshot({ sessions: { stale: true }, revision: 3 });

    expect(usePermissionStore.getState().autoAccept).toEqual({ current: true });
  });
});
