import { describe, expect, mock, test } from 'bun:test';

let getImpl: (() => Promise<Response>) | null = null;
/** The last call's URL, method and body, so the version tests can assert them. */
let lastUrl = '';
let lastMethod = '';
let lastBody = '';

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (url: string, init?: { method?: string; body?: string }) => {
    lastUrl = url;
    lastMethod = init?.method ?? '';
    lastBody = init?.body ?? '';
    if (getImpl) return getImpl();
    throw new Error('unexpected fetch in goalObjectiveFiles test');
  }),
}));

const {
  deleteGoalObjectiveVersion,
  fetchGoalObjectiveContent,
  fetchGoalObjectiveSnapshot,
  fetchGoalObjectiveVersionContent,
  fetchGoalObjectiveVersions,
  writeGoalObjectiveFile,
} = await import('./goalObjectiveFiles');

const jsonResponse = (status: number, body: string) => new Response(body, {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('goal objective snapshot', () => {
  test('a readable file answers its content', async () => {
    getImpl = async () => jsonResponse(200, JSON.stringify({ content: 'Objective text' }));
    expect(await fetchGoalObjectiveSnapshot('session-1')).toEqual({ kind: 'content', content: 'Objective text' });
    expect(await fetchGoalObjectiveContent('session-1')).toBe('Objective text');
  });

  test('a 404 answers missing, the only confirmed-absence answer', async () => {
    getImpl = async () => jsonResponse(404, JSON.stringify({ error: 'objective not found' }));
    expect(await fetchGoalObjectiveSnapshot('session-1')).toEqual({ kind: 'missing' });
    expect(await fetchGoalObjectiveContent('session-1')).toBeNull();
  });

  test('a server error answers unavailable, never missing', async () => {
    getImpl = async () => jsonResponse(500, JSON.stringify({ error: 'boom' }));
    expect(await fetchGoalObjectiveSnapshot('session-1')).toEqual({ kind: 'unavailable' });
  });

  test('a network failure answers unavailable, never missing', async () => {
    getImpl = async () => {
      throw new Error('connection reset');
    };
    expect(await fetchGoalObjectiveSnapshot('session-1')).toEqual({ kind: 'unavailable' });
  });

  test('a malformed payload answers unavailable, never missing', async () => {
    getImpl = async () => jsonResponse(200, JSON.stringify({ nope: true }));
    expect(await fetchGoalObjectiveSnapshot('session-1')).toEqual({ kind: 'unavailable' });
  });
});

describe('goal objective versions (#1830)', () => {
  test('lists the versions, newest first, with no text', async () => {
    getImpl = async () => jsonResponse(200, JSON.stringify({
      versions: [{ id: 'v2', savedAt: 2 }, { id: 'v1', savedAt: 1 }],
    }));
    expect(await fetchGoalObjectiveVersions('session-1')).toEqual([
      { id: 'v2', savedAt: 2 },
      { id: 'v1', savedAt: 1 },
    ]);
    expect(lastUrl).toBe('/api/goals/objective/session-1/versions');
  });

  test('an unreadable list is null, distinct from an empty list', async () => {
    getImpl = async () => jsonResponse(500, '{}');
    expect(await fetchGoalObjectiveVersions('session-1')).toBeNull();
    getImpl = async () => jsonResponse(200, JSON.stringify({ versions: [] }));
    expect(await fetchGoalObjectiveVersions('session-1')).toEqual([]);
  });

  test('reads one version content, and null when it is gone', async () => {
    getImpl = async () => jsonResponse(200, JSON.stringify({ id: 'v1', savedAt: 1, content: 'older spec' }));
    expect(await fetchGoalObjectiveVersionContent('session-1', 'v1')).toBe('older spec');
    expect(lastUrl).toBe('/api/goals/objective/session-1/versions/v1');
    getImpl = async () => jsonResponse(404, '{}');
    expect(await fetchGoalObjectiveVersionContent('session-1', 'v1')).toBeNull();
  });

  test('sends record:false when a restore must not record a version', async () => {
    getImpl = async () => jsonResponse(200, JSON.stringify({ ok: true, length: 3, versionId: null }));
    const write = await writeGoalObjectiveFile('session-1', 'old', { record: false });
    expect(write).toEqual({ saved: true, truncated: false, versionId: null });
    expect(lastMethod).toBe('PUT');
    expect(JSON.parse(lastBody || '{}')).toEqual({ content: 'old', record: false });
  });

  test('returns the recorded version id from a normal save', async () => {
    getImpl = async () => jsonResponse(200, JSON.stringify({ ok: true, length: 3, versionId: 'v7' }));
    expect(await writeGoalObjectiveFile('session-1', 'new')).toEqual({ saved: true, truncated: false, versionId: 'v7' });
    expect(JSON.parse(lastBody || '{}')).toEqual({ content: 'new' });
  });

  test('deletes one version by id', async () => {
    getImpl = async () => jsonResponse(200, JSON.stringify({ ok: true }));
    await deleteGoalObjectiveVersion('session-1', 'v3');
    expect(lastUrl).toBe('/api/goals/objective/session-1/versions/v3');
    expect(lastMethod).toBe('DELETE');
  });
});
