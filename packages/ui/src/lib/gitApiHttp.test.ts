import { describe, expect, test } from 'bun:test';
import {
  abortCherryPick,
  abortMerge,
  abortRebase,
  abortRevert,
  applyGitStash,
  checkoutBranch,
  checkoutCommit,
  cherryPick,
  continueCherryPick,
  continueMerge,
  continueRebase,
  continueRevert,
  createBranch,
  createGitTag,
  deleteGitBranch,
  deleteRemoteBranch,
  dropGitStash,
  getGitBranches,
  getGitDiff,
  getGitFileDiff,
  getGitRangeDiff,
  getGitRangeFiles,
  getGitCommitDiff,
  getCommitFiles,
  getGitLog,
  getGitHistory,
  getGitHistoryMergeBase,
  getGitHistoryRefs,
  getGitStatus,
  getCommitFileDiff,
  gitFetch,
  gitPush,
  listGitDirectories,
  merge,
  popGitStash,
  rebase,
  removeRemote,
  renameBranch,
  resetToCommit,
  revertCommit,
  stageGitFile,
  stageGitFiles,
  stashGitChanges,
  unstageGitFile,
  unstageGitFiles,
} from './gitApiHttp';
import type {
  GitCommitChangesRequest,
  GitCommitFilePreviewRequest,
  GitStatus,
} from './api/types';
import { sessionEvents } from './sessionEvents';
import { gitPushScopeKey, subscribeGitPush } from './gitPushEvents';
import { getRuntimeKey } from './runtime-switch';
import { GitPathUnavailableError } from './api/git-path-diff';
import { GitHistoryRequestError, STALE_GIT_HISTORY_CURSOR_CODE } from './gitHistoryError';

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const previousFetch = globalThis.fetch;
const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

test('only a confirmed successful push invalidates published PR snapshots', async () => {
  const events: string[] = [];
  const unsubscribe = subscribeGitPush((scope) => { events.push(scope); });
  installWindowMock();
  try {
    globalThis.fetch = Object.assign(async () => Response.json({ error: 'Rejected' }, { status: 500 }), previousFetch);
    await expect(gitPush('/repo')).rejects.toThrow('Rejected');
    expect(events).toEqual([]);
    globalThis.fetch = Object.assign(async () => Response.json({ success: false }), previousFetch);
    await gitPush('/repo');
    expect(events).toEqual([]);
    globalThis.fetch = Object.assign(async () => Response.json({ success: true }), previousFetch);
    await gitPush('/repo');
    expect(events).toEqual([gitPushScopeKey('/repo', getRuntimeKey())]);
    await gitFetch('/repo');
    expect(events).toHaveLength(1);
  } finally {
    unsubscribe();
    restoreMocks();
  }
});

const installFetchMock = () => {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
};

const installWindowMock = () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'http://localhost:3000' },
    },
  });
};

const restoreMocks = () => {
  globalThis.fetch = previousFetch;
  if (previousWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
};

const captureError = async <T,>(callback: () => Promise<T>): Promise<unknown> => {
  try {
    await callback();
    return null;
  } catch (error) {
    return error;
  }
};

test('nested repository discovery scopes the workspace to the requested root', async () => {
  installWindowMock();
  const root = '/projects/plugin collection';
  const repositories = [`${root}/first`, `${root}/second`];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    expect(url.pathname).toBe('/api/fs/git-dirs');
    expect(url.searchParams.get('path')).toBe(root);
    if (url.searchParams.get('directory') !== root) {
      return Response.json({ error: 'Path is outside of active workspace' }, { status: 400 });
    }
    return Response.json({ repositories: repositories.map((path) => ({ path })) });
  }, previousFetch);
  try {
    expect(await listGitDirectories(root)).toEqual(repositories);
  } finally {
    restoreMocks();
  }
});

describe('gitApiHttp index mutations', () => {
  test('sends create tag payloads with the commit hash', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await createGitTag('/repo', 'v1.2.3', '0123456789abcdef0123456789abcdef01234567');

      expect(calls).toHaveLength(1);
      expect(String(calls[0].input)).toBe('/api/git/tags?directory=%2Frepo');
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({
        name: 'v1.2.3',
        commitHash: '0123456789abcdef0123456789abcdef01234567',
      });
    } finally {
      restoreMocks();
    }
  });

  test('sends bulk stage payloads as paths', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await stageGitFiles('/repo', ['a.ts', 'b.ts']);

      expect(calls).toHaveLength(1);
      expect(String(calls[0].input)).toBe('/api/git/stage?directory=%2Frepo');
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ paths: ['a.ts', 'b.ts'] });
    } finally {
      restoreMocks();
    }
  });

  test('sends bulk unstage payloads as paths', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await unstageGitFiles('/repo', ['a.ts', 'b.ts']);

      expect(calls).toHaveLength(1);
      expect(String(calls[0].input)).toBe('/api/git/unstage?directory=%2Frepo');
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ paths: ['a.ts', 'b.ts'] });
    } finally {
      restoreMocks();
    }
  });

  test('single-file helpers use the bulk paths payload shape', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await stageGitFile('/repo', 'a.ts');
      await unstageGitFile('/repo', 'b.ts');

      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ paths: ['a.ts'] });
      expect(JSON.parse(String(calls[1].init?.body))).toEqual({ paths: ['b.ts'] });
    } finally {
      restoreMocks();
    }
  });

  test('rejects empty bulk path lists before fetching', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      const stageError = await captureError(() => stageGitFiles('/repo', [' ', '']));
      const unstageError = await captureError(() => unstageGitFiles('/repo', []));

      expect(stageError).toBeInstanceOf(Error);
      expect((stageError as Error).message).toBe('path is required to stage git changes');
      expect(unstageError).toBeInstanceOf(Error);
      expect((unstageError as Error).message).toBe('path is required to unstage git changes');
      expect(calls).toHaveLength(0);
    } finally {
      restoreMocks();
    }
  });
});

describe('gitApiHttp branch comparisons', () => {
  test('sends commit hashes and rename paths without trimming', async () => {
    installWindowMock();
    const urls: URL[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      urls.push(url);
      return Response.json(url.pathname.endsWith('/commit-diff') ? { diff: 'commit patch' } : { files: [{ path: 'incomplete' }] });
    }, previousFetch);
    try {
      const hash = 'a'.repeat(40);
      expect(await getGitCommitDiff('/repo', { hash, path: ' new\nfile.ts', previousPath: 'old.ts', contextLines: 20 }))
        .toEqual({ diff: 'commit patch' });
      expect(urls[0].pathname).toBe('/api/git/commit-diff');
      expect(urls[0].searchParams.get('hash')).toBe(hash);
      expect(urls[0].searchParams.get('path')).toBe(' new\nfile.ts');
      expect(urls[0].searchParams.get('previousPath')).toBe('old.ts');
      expect(urls[0].searchParams.get('context')).toBe('20');
      await expect(getCommitFiles('/repo', { commitHash: hash, parentHash: null })).rejects.toThrow();
      await expect(getGitLog('/repo', { maxCount: 50, to: 'refs/heads/feature' })).rejects.toThrow();
      expect(urls[2].searchParams.get('maxCount')).toBe('50');
      expect(urls[2].searchParams.get('to')).toBe('refs/heads/feature');
      expect(urls[2].searchParams.has('all')).toBe(false);
    } finally {
      restoreMocks();
    }
  });

  test('sends the exact selected refs and working-tree option to both range endpoints', async () => {
    installWindowMock();
    const urls: URL[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      urls.push(url);
      return Response.json(url.pathname.endsWith('/range-files')
        ? { files: [{ path: 'new.ts', status: 'A' }] }
        : { diff: 'current patch' });
    }, previousFetch);
    try {
      const options = { base: 'refs/heads/parent', head: 'child', includeWorkingTree: true };
      expect(await getGitRangeDiff('/repo', options)).toEqual({ diff: 'current patch' });
      expect(await getGitRangeFiles('/repo', options)).toEqual([{ path: 'new.ts', status: 'A' }]);
      expect(urls).toHaveLength(2);
      for (const url of urls) {
        expect(url.searchParams.get('base')).toBe('refs/heads/parent');
        expect(url.searchParams.get('head')).toBe('child');
        expect(url.searchParams.get('includeWorkingTree')).toBe('true');
      }
    } finally {
      restoreMocks();
    }
  });

  test('rejects malformed file lists and preserves the server ref error', async () => {
    installWindowMock();
    globalThis.fetch = Object.assign(async () => Response.json({ files: [{ path: 'new.ts' }] }), previousFetch);
    const options = { base: 'missing', head: 'child', includeWorkingTree: true };
    try {
      await expect(getGitRangeFiles('/repo', options)).rejects.toThrow();
      globalThis.fetch = Object.assign(async () => Response.json({ error: 'Fetch the selected ref first.' }, { status: 500 }), previousFetch);
      await expect(getGitRangeDiff('/repo', options)).rejects.toThrow('Fetch the selected ref first.');
      await expect(getGitRangeFiles('/repo', options)).rejects.toThrow('Fetch the selected ref first.');
    } finally {
      restoreMocks();
    }
  });

  test('reports a status path that no longer resolves as unavailable, not as a failed request', async () => {
    installWindowMock();
    try {
      for (const [status, code] of [[404, 'path_not_found'], [422, 'nested_repository']] as const) {
        globalThis.fetch = Object.assign(async () => Response.json({ error: `unavailable: ${code}`, code }, { status }), previousFetch);
        for (const request of [() => getGitDiff('/repo', { path: 'nested/' }), () => getGitFileDiff('/repo', { path: 'nested/' })]) {
          const error = await captureError(async () => { await request(); });
          expect(error instanceof GitPathUnavailableError ? [error.reason, error.message] : error).toEqual([code, `unavailable: ${code}`]);
        }
      }
      // A 404 without the route's body is some other failure.
      globalThis.fetch = Object.assign(async () => new Response('Not Found', { status: 404, statusText: 'Not Found' }), previousFetch);
      const error = await captureError(async () => { await getGitDiff('/repo', { path: 'file.ts' }); });
      expect(error instanceof GitPathUnavailableError).toBe(false);
      expect(error instanceof Error ? error.message : error).toBe('Failed to get git diff: Not Found');
    } finally {
      restoreMocks();
    }
  });

  test('carries submodule state and treats its absence from an older server as an ordinary path', async () => {
    installWindowMock();
    const submodule = { headCommit: 'a'.repeat(40), indexCommit: 'a'.repeat(40), worktreeCommit: 'a'.repeat(40), hasTrackedChanges: false, hasUntrackedFiles: true, hasConflict: false };
    try {
      globalThis.fetch = Object.assign(async () => Response.json({ diff: '', submodule }), previousFetch);
      expect(await getGitDiff('/repo', { path: 'sub' })).toEqual({ diff: '', submodule });
      globalThis.fetch = Object.assign(async () => Response.json({ diff: 'patch' }), previousFetch);
      expect(await getGitDiff('/repo', { path: 'file.ts' })).toEqual({ diff: 'patch', submodule: null });
      globalThis.fetch = Object.assign(async () => Response.json({ original: 'a', modified: 'b', path: 'file.ts', isBinary: false }), previousFetch);
      expect(await getGitFileDiff('/repo', { path: 'file.ts' })).toEqual({ original: 'a', modified: 'b', path: 'file.ts', isBinary: false, submodule: null });
    } finally {
      restoreMocks();
    }
  });
});

describe('gitApiHttp status cache', () => {
  test('a Git refresh hint invalidates the cached status before listeners fetch', async () => {
    installWindowMock();
    let statusRequestCount = 0;
    globalThis.fetch = async () => {
      statusRequestCount += 1;
      return jsonResponse(statusPayload({ behind: statusRequestCount }));
    };

    try {
      const directory = '/repo-cache-tool-mutation';
      const first = await getGitStatus(directory);
      sessionEvents.requestGitRefresh({ directory });
      const afterMutation = await getGitStatus(directory);

      expect(first.behind).toBe(1);
      expect(afterMutation.behind).toBe(2);
      expect(statusRequestCount).toBe(2);
    } finally {
      restoreMocks();
    }
  });

  test('invalidates cached status after fetch', async () => {
    installWindowMock();
    const calls: FetchCall[] = [];
    let statusRequestCount = 0;
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.startsWith('/api/git/status')) {
        statusRequestCount += 1;
        return new Response(JSON.stringify({
          current: 'main',
          tracking: 'origin/main',
          ahead: 0,
          behind: statusRequestCount === 1 ? 0 : 2,
          files: [],
          isClean: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const directory = '/repo-cache-fetch';
      const first = await getGitStatus(directory);
      const cached = await getGitStatus(directory);
      await gitFetch(directory, { remote: 'origin' });
      const afterFetch = await getGitStatus(directory);

      expect(first.behind).toBe(0);
      expect(cached.behind).toBe(0);
      expect(afterFetch.behind).toBe(2);
      expect(statusRequestCount).toBe(2);
      expect(calls.map((call) => String(call.input))).toEqual([
        '/api/git/status?directory=%2Frepo-cache-fetch',
        '/api/git/fetch?directory=%2Frepo-cache-fetch',
        '/api/git/status?directory=%2Frepo-cache-fetch',
      ]);
    } finally {
      restoreMocks();
    }
  });

  test('fresh status bypasses an unexpired cached snapshot', async () => {
    installWindowMock();
    let statusRequestCount = 0;
    globalThis.fetch = (async () => {
      statusRequestCount += 1;
      return jsonResponse(statusPayload({ behind: statusRequestCount }));
    }) as typeof fetch;

    try {
      const directory = '/repo-cache-fresh';
      const first = await getGitStatus(directory);
      const cached = await getGitStatus(directory);
      const fresh = await getGitStatus(directory, { fresh: true });

      expect(first.behind).toBe(1);
      expect(cached.behind).toBe(1);
      expect(fresh.behind).toBe(2);
      expect(statusRequestCount).toBe(2);
    } finally {
      restoreMocks();
    }
  });

  test('fresh status cannot be replaced in cache by an older in-flight response', async () => {
    installWindowMock();
    const statusResolvers: Array<(response: Response) => void> = [];
    // SAFETY: the mock accepts the same arguments as fetch and always returns
    // a pending Response promise controlled by this test.
    globalThis.fetch = (async () => new Promise<Response>((resolve) => {
      statusResolvers.push(resolve);
    })) as typeof fetch;

    try {
      const directory = '/repo-cache-fresh-race';
      const older = getGitStatus(directory);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const fresh = getGitStatus(directory, { fresh: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(statusResolvers).toHaveLength(2);
      statusResolvers[1](jsonResponse(statusPayload({ current: 'fresh' })));
      statusResolvers[0](jsonResponse(statusPayload({ current: 'stale' })));

      expect((await fresh).current).toBe('fresh');
      expect((await older).current).toBe('stale');
      expect((await getGitStatus(directory)).current).toBe('fresh');
      expect(statusResolvers).toHaveLength(2);
    } finally {
      restoreMocks();
    }
  });
});

const statusPayload = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  ...overrides,
});

const jsonResponse = <T>(payload: T) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const installStatusMutationFetchMock = () => {
  // SAFETY: `statusUrls` starts empty and only ever receives request URLs, which
  // are strings; the annotation names that element type up front.
  const mock = {
    statusUrls: [] as string[],
    behind: 0,
  };
  // SAFETY: the mock receives only the (input, init) pair production code passes
  // and always resolves to a Response, so it honours the fetch contract; the
  // assertion supplies the overload signatures a plain arrow function cannot.
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.startsWith('/api/git/status')) {
      mock.statusUrls.push(url);
      return jsonResponse(statusPayload({ behind: mock.behind }));
    }
    return jsonResponse({ success: true });
  }) as typeof fetch;
  return mock;
};

/**
 * Seeds the status cache, performs the mutation, and asserts the next status
 * read issues a fresh request that observes the post-mutation state instead of
 * serving the pre-mutation cache entry.
 */
const expectStatusInvalidatedBy = async <T>(
  directory: string,
  mutate: () => Promise<T>
): Promise<void> => {
  const mock = installStatusMutationFetchMock();

  const seeded = await getGitStatus(directory);
  expect(seeded.behind).toBe(0);

  mock.behind = 2;
  const cached = await getGitStatus(directory);
  expect(cached.behind).toBe(0);
  expect(mock.statusUrls).toHaveLength(1);

  await mutate();

  const refreshed = await getGitStatus(directory);
  expect(refreshed.behind).toBe(2);
  expect(mock.statusUrls).toHaveLength(2);
};

describe('gitApiHttp post-mutation status invalidation (#2281)', () => {
  test('checkout and branch mutations invalidate cached status', async () => {
    installWindowMock();
    try {
      await expectStatusInvalidatedBy('/repo-2281-checkout', () => checkoutBranch('/repo-2281-checkout', 'feature'));
      await expectStatusInvalidatedBy('/repo-2281-create-branch', () => createBranch('/repo-2281-create-branch', 'feature/new'));
      await expectStatusInvalidatedBy('/repo-2281-rename-branch', () => renameBranch('/repo-2281-rename-branch', 'old', 'new'));
      await expectStatusInvalidatedBy('/repo-2281-delete-branch', () => deleteGitBranch('/repo-2281-delete-branch', { branch: 'feature/old' }));
    } finally {
      restoreMocks();
    }
  });

  test('stash lifecycle mutations invalidate cached status', async () => {
    installWindowMock();
    try {
      await expectStatusInvalidatedBy('/repo-2281-stash', () => stashGitChanges('/repo-2281-stash', { message: 'WIP' }));
      await expectStatusInvalidatedBy('/repo-2281-stash-apply', () => applyGitStash('/repo-2281-stash-apply', { ref: 'stash@{0}' }));
      await expectStatusInvalidatedBy('/repo-2281-stash-pop', () => popGitStash('/repo-2281-stash-pop', { ref: 'stash@{0}' }));
      await expectStatusInvalidatedBy('/repo-2281-stash-drop', () => dropGitStash('/repo-2281-stash-drop', { ref: 'stash@{0}' }));
    } finally {
      restoreMocks();
    }
  });

  test('merge and rebase lifecycle mutations invalidate cached status', async () => {
    installWindowMock();
    try {
      await expectStatusInvalidatedBy('/repo-2281-merge', () => merge('/repo-2281-merge', { branch: 'feature' }));
      await expectStatusInvalidatedBy('/repo-2281-merge-abort', () => abortMerge('/repo-2281-merge-abort'));
      await expectStatusInvalidatedBy('/repo-2281-merge-continue', () => continueMerge('/repo-2281-merge-continue'));
      await expectStatusInvalidatedBy('/repo-2281-rebase', () => rebase('/repo-2281-rebase', { onto: 'main' }));
      await expectStatusInvalidatedBy('/repo-2281-rebase-abort', () => abortRebase('/repo-2281-rebase-abort'));
      await expectStatusInvalidatedBy('/repo-2281-rebase-continue', () => continueRebase('/repo-2281-rebase-continue'));
      await expectStatusInvalidatedBy('/repo-2281-cherry-pick-abort', () => abortCherryPick('/repo-2281-cherry-pick-abort'));
      await expectStatusInvalidatedBy('/repo-2281-cherry-pick-continue', () => continueCherryPick('/repo-2281-cherry-pick-continue'));
      await expectStatusInvalidatedBy('/repo-2281-revert-abort', () => abortRevert('/repo-2281-revert-abort'));
      await expectStatusInvalidatedBy('/repo-2281-revert-continue', () => continueRevert('/repo-2281-revert-continue'));
    } finally {
      restoreMocks();
    }
  });

  test('history mutations invalidate cached status', async () => {
    installWindowMock();
    try {
      await expectStatusInvalidatedBy('/repo-2281-checkout-commit', () => checkoutCommit('/repo-2281-checkout-commit', 'abc123'));
      await expectStatusInvalidatedBy('/repo-2281-cherry-pick', () => cherryPick('/repo-2281-cherry-pick', 'abc123'));
      await expectStatusInvalidatedBy('/repo-2281-revert-commit', () => revertCommit('/repo-2281-revert-commit', 'abc123'));
      await expectStatusInvalidatedBy('/repo-2281-reset', () => resetToCommit('/repo-2281-reset', 'abc123', 'mixed'));
    } finally {
      restoreMocks();
    }
  });

  test('remote-side mutations invalidate cached status', async () => {
    installWindowMock();
    try {
      await expectStatusInvalidatedBy('/repo-2281-delete-remote-branch', () => deleteRemoteBranch('/repo-2281-delete-remote-branch', { branch: 'feature', remote: 'origin' }));
      await expectStatusInvalidatedBy('/repo-2281-remove-remote', () => removeRemote('/repo-2281-remove-remote', { remote: 'origin' }));
    } finally {
      restoreMocks();
    }
  });

  test('a failed mutation does not invalidate cached status', async () => {
    installWindowMock();
    const statusUrls: string[] = [];
    // SAFETY: see installStatusMutationFetchMock - the mock honours the fetch
    // contract; the assertion supplies its overload signatures.
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.startsWith('/api/git/status')) {
        statusUrls.push(url);
        return jsonResponse(statusPayload());
      }
      return new Response(JSON.stringify({ error: 'checkout failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const directory = '/repo-2281-failed-checkout';
      await getGitStatus(directory);

      const error = await captureError(async () => {
        await checkoutBranch(directory, 'feature');
      });
      expect(error).toBeInstanceOf(Error);
      // SAFETY: the assertion above established that `error` is an Error.
      expect((error as Error).message).toBe('checkout failed');

      await getGitStatus(directory);
      expect(statusUrls).toHaveLength(1);
    } finally {
      restoreMocks();
    }
  });

  test('a status request admitted before a mutation cannot satisfy the post-mutation refresh', async () => {
    installWindowMock();
    const statusResolvers: Array<(response: Response) => void> = [];
    const statusUrls: string[] = [];
    // SAFETY: see installStatusMutationFetchMock - the mock honours the fetch
    // contract; the assertion supplies its overload signatures.
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.startsWith('/api/git/status')) {
        statusUrls.push(url);
        return new Promise<Response>((resolve) => {
          statusResolvers.push(resolve);
        });
      }
      return jsonResponse({ success: true });
    }) as typeof fetch;

    try {
      const directory = '/repo-2281-deferred';
      const preMutationRead = getGitStatus(directory);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(statusUrls).toHaveLength(1);

      await checkoutBranch(directory, 'feature');

      const postMutationRead = getGitStatus(directory);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(statusUrls).toHaveLength(2);

      statusResolvers[1](jsonResponse(statusPayload({ current: 'feature' })));
      statusResolvers[0](jsonResponse(statusPayload({ current: 'main' })));

      const [preMutationStatus, postMutationStatus] = await Promise.all([preMutationRead, postMutationRead]);
      expect(preMutationStatus.current).toBe('main');
      expect(postMutationStatus.current).toBe('feature');

      // The late pre-mutation response must not repopulate the cache.
      const cachedRead = await getGitStatus(directory);
      expect(cachedRead.current).toBe('feature');
      expect(statusUrls).toHaveLength(2);
    } finally {
      restoreMocks();
    }
  });
});

describe('gitApiHttp request priority', () => {
  test('leaves low-level reads outside the background policy', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await getGitBranches('/repo-interactive');

      expect(calls).toHaveLength(1);
      expect(calls[0].init?.priority).toBe(undefined);
    } finally {
      restoreMocks();
    }
  });
});

describe('gitApiHttp history requests', () => {
  test('serializes repeated refs without comma ambiguity', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await getGitHistoryRefs('/repo');
      await getGitHistory('/repo', { refs: ['HEAD', 'refs/heads/main'], cursor: 'cursor', limit: 25 });
      await getGitHistoryMergeBase('/repo', { refs: ['HEAD', 'refs/heads/main'] });

      expect(String(calls[0].input)).toBe('/api/git/history/refs?directory=%2Frepo');
      expect(String(calls[1].input)).toBe('/api/git/history?directory=%2Frepo&refs=HEAD&refs=refs%2Fheads%2Fmain&cursor=cursor&limit=25');
      expect(String(calls[2].input)).toBe('/api/git/history/merge-base?directory=%2Frepo&refs=HEAD&refs=refs%2Fheads%2Fmain');
    } finally {
      restoreMocks();
    }
  });

  test('preserves the structured refs error returned by the server', async () => {
    installWindowMock();
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: 'Directory does not appear to be a git repository',
    }), {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    try {
      const error = await captureError(() => getGitHistoryRefs('/tmp/not-a-repo'));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Directory does not appear to be a git repository');
    } finally {
      restoreMocks();
    }
  });

  test('falls back to the status text when the refs error body is unusable', async () => {
    installWindowMock();

    const cases = [
      new Response('{"error":', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(JSON.stringify({}), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(JSON.stringify({ error: '   ' }), {
        status: 504,
        statusText: 'Gateway Timeout',
        headers: { 'Content-Type': 'application/json' },
      }),
    ];

    try {
      for (const response of cases) {
        globalThis.fetch = (async () => response.clone()) as typeof fetch;
        const error = await captureError(() => getGitHistoryRefs('/tmp/not-a-repo'));
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(`Failed to get git history refs: ${response.statusText}`);
      }
    } finally {
      restoreMocks();
    }
  });

  test('serializes the all selector without explicit refs', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await getGitHistory('/repo', { all: true, cursor: 'cursor', limit: 25 });

      expect(String(calls[0].input)).toBe('/api/git/history?directory=%2Frepo&all=true&cursor=cursor&limit=25');
    } finally {
      restoreMocks();
    }
  });

  test('preserves structured stale cursor history errors from the server', async () => {
    installWindowMock();
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: 'stale cursor',
      code: STALE_GIT_HISTORY_CURSOR_CODE,
    }), {
      status: 409,
      statusText: 'Conflict',
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    try {
      const error = await captureError(() => getGitHistory('/repo', { refs: ['HEAD'] }));
      expect(error).toBeInstanceOf(GitHistoryRequestError);
      expect((error as GitHistoryRequestError).message).toBe('stale cursor');
      expect((error as GitHistoryRequestError).status).toBe(409);
      expect((error as GitHistoryRequestError).code).toBe(STALE_GIT_HISTORY_CURSOR_CODE);
    } finally {
      restoreMocks();
    }
  });

  test('falls back to the status text when the history error body is unusable', async () => {
    installWindowMock();

    const cases = [
      new Response('{"error":', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(JSON.stringify({}), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      }),
    ];

    try {
      for (const response of cases) {
        globalThis.fetch = (async () => response.clone()) as typeof fetch;
        const error = await captureError(() => getGitHistory('/repo', { refs: ['HEAD'] }));
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(`Failed to get git history: ${response.statusText}`);
      }
    } finally {
      restoreMocks();
    }
  });

  test('accepts object requests for commit file history helpers', async () => {
    installWindowMock();
    const calls: FetchCall[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      const url = new URL(String(input), 'http://localhost');
      return Response.json(url.pathname.endsWith('/commit-files')
        ? { files: [] }
        : { status: 'ready', original: '', modified: '' });
    }, previousFetch);
    const commitHash = 'a'.repeat(40);
    const parentHash = 'b'.repeat(40);
    try {
      const changesRequest: GitCommitChangesRequest = {
        commitHash,
        parentHash: null,
      };
      const previewRequest: GitCommitFilePreviewRequest = {
        commitHash,
        parentHash,
        originalPath: null,
        modifiedPath: 'new/name.ts',
      };

      await getCommitFiles('/repo', changesRequest);
      await getCommitFileDiff('/repo', previewRequest);

      expect(String(calls[0].input)).toBe(`/api/git/commit-files?directory=%2Frepo&commitHash=${commitHash}&parentHash=__ROOT__`);
      expect(String(calls[1].input)).toBe(`/api/git/commit-file-diff?directory=%2Frepo&commitHash=${commitHash}&parentHash=${parentHash}&originalPath=__ROOT__&modifiedPath=new%2Fname.ts`);
    } finally {
      restoreMocks();
    }
  });

  test('preserves JSON error details for commit file previews', async () => {
    installWindowMock();
    const request: GitCommitFilePreviewRequest = {
      commitHash: 'a'.repeat(40),
      parentHash: null,
      originalPath: null,
      modifiedPath: 'file.ts',
    };
    globalThis.fetch = Object.assign(
      async () => Response.json({ error: 'The selected commit is unavailable.' }, { status: 404 }),
      previousFetch
    );

    try {
      await expect(getCommitFileDiff('/repo', request))
        .rejects.toThrow('The selected commit is unavailable.');
    } finally {
      restoreMocks();
    }
  });

  test('accepts ready and too-large commit file preview responses', async () => {
    installWindowMock();
    const request: GitCommitFilePreviewRequest = {
      commitHash: 'a'.repeat(40),
      parentHash: null,
      originalPath: null,
      modifiedPath: 'file.ts',
    };
    const responses = [
      Response.json({ status: 'ready', original: 'before', modified: 'after' }),
      Response.json({ status: 'too-large', totalBytes: 200_000, maxBytes: 100_000 }),
    ];
    globalThis.fetch = Object.assign(async () => responses.shift()!, previousFetch);

    try {
      expect(await getCommitFileDiff('/repo', request))
        .toEqual({ status: 'ready', original: 'before', modified: 'after' });
      expect(await getCommitFileDiff('/repo', request))
        .toEqual({ status: 'too-large', totalBytes: 200_000, maxBytes: 100_000 });
    } finally {
      restoreMocks();
    }
  });

  test('rejects malformed commit file preview responses', async () => {
    installWindowMock();
    const request: GitCommitFilePreviewRequest = {
      commitHash: 'a'.repeat(40),
      parentHash: null,
      originalPath: null,
      modifiedPath: 'file.ts',
    };
    globalThis.fetch = Object.assign(
      async () => Response.json({ status: 'ready', original: 'before', modified: 1 }),
      previousFetch
    );

    try {
      await expect(getCommitFileDiff('/repo', request)).rejects.toThrow();
    } finally {
      restoreMocks();
    }
  });
});
