import { beforeEach, describe, expect, mock, test } from 'bun:test';

type FetchInit = RequestInit & { directory?: string | null };
let fetchImpl: (input: string, init?: FetchInit) => Promise<Response>;
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: FetchInit) => fetchImpl(input, init),
}));
// The sessions the sync layer knows, by id, with the directory each one runs in.
let sessionMap = new Map<string, { id: string; directory: string }>();
let sessionDirectory = '/project';
mock.module('@/sync/sync-refs', () => ({ getAllSyncSessionMap: () => sessionMap }));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => ({ getDirectoryForSession: () => sessionDirectory }) },
}));
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: { getDirectory: () => '/fallback' },
}));

const { usePermissionStore } = await import('./permissionStore');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('permission store server policy', () => {
  beforeEach(() => {
    sessionMap = new Map();
    sessionDirectory = '/project';
    usePermissionStore.getState().reset();
    usePermissionStore.setState({ legacyCandidate: null, legacyRuntimeKey: null });
    fetchImpl = async () => json({ sessions: {} });
  });

  test('hydrates the authoritative server snapshot', async () => {
    fetchImpl = async () => json({ sessions: { root: true } });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto' });
  });

  test('reads modes when the server has them and on/off as auto/ask when it does not', async () => {
    fetchImpl = async () => json({ sessions: { root: true, off: false }, modes: { root: 'safety', off: 'ask' }, revision: 1 });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().modes).toEqual({ root: 'safety', off: 'ask' });
    expect(usePermissionStore.getState().getSessionMode('root')).toBe('safety');

    usePermissionStore.getState().reset();
    fetchImpl = async () => json({ sessions: { root: true, off: false } });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto', off: 'ask' });
  });

  test('preserves previous state when hydration fails', async () => {
    usePermissionStore.setState({ modes: { root: 'auto' }, loaded: true });
    fetchImpl = async () => json({}, 503);
    await expect(usePermissionStore.getState().hydrate()).rejects.toThrow();
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto' });
  });

  test('updates local state only after server persistence succeeds', async () => {
    fetchImpl = async () => json({}, 500);
    await expect(usePermissionStore.getState().setSessionMode('root', 'auto')).rejects.toThrow();
    expect(usePermissionStore.getState().modes).toEqual({});
  });

  test('sends the session directory for immediate pending reconciliation', async () => {
    let body: unknown;
    fetchImpl = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json({ sessions: { root: true } });
    };
    await usePermissionStore.getState().setSessionMode('root', 'auto');
    expect(body).toEqual({ mode: 'auto', enabled: true, directory: '/project' });
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
    expect(usePermissionStore.getState().modes).toEqual({ root: 'auto' });
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

    expect(usePermissionStore.getState().modes).toEqual({ current: 'auto' });
  });

  test('rejects a mutation response from before reset', async () => {
    let resolveOld!: (response: Response) => void;
    fetchImpl = async () => new Promise<Response>((resolve) => { resolveOld = resolve; });
    const mutation = usePermissionStore.getState().setSessionMode('stale', 'auto');

    usePermissionStore.getState().reset();
    resolveOld(json({ sessions: { stale: true }, revision: 1 }));
    await mutation;

    expect(usePermissionStore.getState().modes).toEqual({});
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('keeps the highest authoritative revision when mutations resolve out of order', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchImpl = async () => new Promise<Response>((resolve) => { resolvers.push(resolve); });
    const first = usePermissionStore.getState().setSessionMode('first', 'auto');
    const second = usePermissionStore.getState().setSessionMode('second', 'auto');

    resolvers[1](json({ sessions: { first: true, second: true }, revision: 2 }));
    await second;
    resolvers[0](json({ sessions: { first: true }, revision: 1 }));
    await first;

    expect(usePermissionStore.getState().modes).toEqual({ first: 'auto', second: 'auto' });
    expect(usePermissionStore.getState().saving).toBe(false);
  });

  test('ignores an older broadcast revision', () => {
    usePermissionStore.getState().applySnapshot({ modes: { current: 'auto' }, revision: 4 });
    usePermissionStore.getState().applySnapshot({ modes: { stale: 'auto' }, revision: 3 });

    expect(usePermissionStore.getState().modes).toEqual({ current: 'auto' });
  });
});

// An isolated space's server keeps the modes of its own sessions and answers their requests, so a
// space session's mode is written to that space and read from it, apart from the host's policy.
describe('permission modes of a session in an isolated space', () => {
  const SPACE = 'a1b2c3d4e5f6';
  const spaceDirectory = `/spaces/${SPACE}/repo`;

  beforeEach(() => {
    usePermissionStore.getState().reset();
    sessionMap = new Map([
      ['space-1', { id: 'space-1', directory: spaceDirectory }],
      ['host-1', { id: 'host-1', directory: '/project' }],
    ]);
    sessionDirectory = spaceDirectory;
  });

  test('a mode set in a space chat goes to the space and is read from its answer', async () => {
    const directories: Array<string | null | undefined> = [];
    fetchImpl = async (_input, init) => {
      directories.push(init?.directory);
      return json({ sessions: { 'space-1': true }, modes: { 'space-1': 'auto' }, revision: 1 });
    };
    await usePermissionStore.getState().setSessionMode('space-1', 'auto');
    expect(directories).toEqual([spaceDirectory]);
    expect(usePermissionStore.getState().modes).toEqual({});
    expect(usePermissionStore.getState().getSessionMode('space-1')).toBe('auto');
  });

  test('the host policy and a space policy never stand in for each other', () => {
    const { applySnapshot } = usePermissionStore.getState();
    applySnapshot({ modes: { 'host-1': 'auto', 'space-1': 'auto' }, revision: 5 });
    applySnapshot({ modes: { 'space-1': 'ask' }, revision: 1 }, undefined, SPACE);
    expect(usePermissionStore.getState().getSessionMode('host-1')).toBe('auto');
    expect(usePermissionStore.getState().getSessionMode('space-1')).toBe('ask');

    // The space numbers its own revisions: an older one of its own is ignored, the host's do not count.
    applySnapshot({ modes: { 'space-1': 'auto' }, revision: 3 }, undefined, SPACE);
    applySnapshot({ modes: { 'space-1': 'ask' }, revision: 2 }, undefined, SPACE);
    expect(usePermissionStore.getState().getSessionMode('space-1')).toBe('auto');
    expect(usePermissionStore.getState().modes).toEqual({ 'host-1': 'auto', 'space-1': 'auto' });
  });

  test('a space policy is read from that space, and one that cannot be read keeps what was known', async () => {
    const directories: Array<string | null | undefined> = [];
    fetchImpl = async (_input, init) => {
      directories.push(init?.directory);
      return json({ sessions: { 'space-1': true }, modes: { 'space-1': 'safety' }, revision: 4 });
    };
    await usePermissionStore.getState().refreshSpaceModes(SPACE);
    expect(directories).toEqual([`/spaces/${SPACE}`]);
    expect(usePermissionStore.getState().getSessionMode('space-1')).toBe('safety');

    fetchImpl = async () => json({}, 503);
    await usePermissionStore.getState().refreshSpaceModes(SPACE);
    expect(usePermissionStore.getState().getSessionMode('space-1')).toBe('safety');
  });
});
