import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { selectAutoReviewRun, useAutoReviewStore, type AutoReviewRun } from './useAutoReviewStore';

const SPACE = '0123456789ab';
const SPACE_DIRECTORY = `/spaces/${SPACE}/repo`;
const originalResolver = getRuntimeUrlResolver();
const originalFetch = globalThis.fetch;

type Seen = { method: string; path: string; directory: string | null };
let seen: Seen[] = [];
let answer: (request: Request) => Response | Promise<Response> = () => Response.json({ revision: 0, runs: [] });

const run = (sessionID: string, extra: Partial<AutoReviewRun> = {}): AutoReviewRun => ({
  originalSessionID: sessionID,
  reviewSessionID: `${sessionID}-review`,
  directory: '/repo',
  status: 'running',
  step: 'review',
  round: 0,
  maxRounds: 15,
  startedAt: 1,
  updatedAt: 1,
  ...extra,
});

const update = (revision: number, sessionID: string, value: AutoReviewRun | null, directory = '/repo', spaceId?: string) => ({
  revision,
  originalSessionID: sessionID,
  directory,
  run: value,
  spaceId,
});

/** What a chat in `directory` shows for `sessionID`. */
const shown = (sessionID: string, directory = '/repo') => selectAutoReviewRun(sessionID, directory)(useAutoReviewStore.getState());

beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://auto-review.example' });
  useAutoReviewStore.getState().resetForRuntimeSwitch();
  seen = [];
  answer = () => Response.json({ revision: 0, runs: [] });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const directory = request.headers.get('x-opencode-directory');
    seen.push({ method: request.method, path: url.pathname, directory: directory === null ? null : decodeURIComponent(directory) });
    return answer(request);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(originalResolver);
});

describe('auto-review projection', () => {
  test('a snapshot sets the host runs and an older broadcast does not undo a newer one', async () => {
    answer = () => Response.json({ revision: 5, runs: [run('ses_a')] });
    await useAutoReviewStore.getState().hydrate();
    expect(shown('ses_a')?.status).toBe('running');

    const store = useAutoReviewStore.getState();
    store.applyUpdate(update(7, 'ses_a', run('ses_a', { status: 'clean' })), getRuntimeKey());
    store.applyUpdate(update(6, 'ses_a', run('ses_a', { step: 'implement' })), getRuntimeKey());
    store.applyUpdate(update(4, 'ses_b', run('ses_b')), getRuntimeKey());
    expect(shown('ses_a')?.status).toBe('clean');
    expect(shown('ses_b')).toBeNull();

    store.applyUpdate(update(8, 'ses_a', null), getRuntimeKey());
    expect(useAutoReviewStore.getState().runs).toEqual({});
  });

  test('a change is taken only from the server that owns the session', async () => {
    const store = useAutoReviewStore.getState();
    store.applyUpdate(update(1, 'ses_host', run('ses_host'), '/repo', SPACE), getRuntimeKey());
    store.applyUpdate(update(1, 'ses_space', run('ses_space', { directory: SPACE_DIRECTORY }), SPACE_DIRECTORY), getRuntimeKey());
    store.applyUpdate(update(1, 'ses_other', run('ses_other', { directory: '/repo' }), SPACE_DIRECTORY, SPACE), getRuntimeKey());
    store.applyUpdate(update(1, 'ses_kept', run('ses_kept', { directory: SPACE_DIRECTORY }), SPACE_DIRECTORY, SPACE), getRuntimeKey());
    store.applyUpdate(update(9, 'ses_late', run('ses_late')), 'another-runtime');
    expect(Object.values(useAutoReviewStore.getState().runs).map((entry) => entry.originalSessionID)).toEqual(['ses_kept']);
    expect(shown('ses_kept', SPACE_DIRECTORY)?.status).toBe('running');

    answer = () => Response.json({ revision: 3, runs: [] });
    await useAutoReviewStore.getState().refreshSpace(SPACE);
    expect(seen.at(-1)).toEqual({ method: 'GET', path: '/api/auto-review', directory: `/spaces/${SPACE}` });
    expect(useAutoReviewStore.getState().runs).toEqual({});
  });

  test('a space that names a host session cannot put a run on the host chat', async () => {
    answer = () => Response.json({ revision: 2, runs: [run('ses_host', { status: 'clean' })] });
    await useAutoReviewStore.getState().hydrate();

    answer = () => Response.json({ revision: 9, runs: [run('ses_host', { directory: SPACE_DIRECTORY })] });
    await useAutoReviewStore.getState().refreshSpace(SPACE);
    useAutoReviewStore.getState().applyUpdate(
      update(10, 'ses_host', run('ses_host', { directory: SPACE_DIRECTORY, status: 'failed' }), SPACE_DIRECTORY, SPACE),
      getRuntimeKey(),
    );

    expect(shown('ses_host')?.status).toBe('clean');
  });

  test('a stop that the server refuses puts the run back and reports it', async () => {
    useAutoReviewStore.getState().applyUpdate(update(2, 'ses_a', run('ses_a')), getRuntimeKey());
    answer = (request) => (request.method === 'DELETE'
      ? Response.json({ error: 'busy' }, { status: 500 })
      : Response.json({ revision: 2, runs: [run('ses_a')] }));

    const removing = useAutoReviewStore.getState().removeRun('ses_a', '/repo');
    expect(shown('ses_a')).toBeNull();
    await expect(removing).rejects.toThrow('busy');
    expect(shown('ses_a')?.status).toBe('running');
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual(['DELETE /api/auto-review/runs/ses_a', 'GET /api/auto-review']);
  });

  test('a refused start names the reason the server gave', async () => {
    answer = () => Response.json({ error: 'an auto-review is already running for this session' }, { status: 409 });
    await expect(useAutoReviewStore.getState().startRun({
      originalSessionID: 'ses_a',
      reviewSessionID: 'ses_r',
      directory: '/repo',
      prompts: { reviewStart: 'r', reviewRules: 'rules', feedbackToImplementer: 'f', responseToReviewer: 'i' },
    })).rejects.toThrow('already running');
    expect(useAutoReviewStore.getState().runs).toEqual({});
  });
});
