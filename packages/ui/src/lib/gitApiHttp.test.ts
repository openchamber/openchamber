import { describe, expect, test } from 'bun:test';
import {
  abortMerge,
  abortRebase,
  applyGitStash,
  checkoutBranch,
  checkoutCommit,
  cherryPick,
  continueMerge,
  continueRebase,
  createBranch,
  deleteGitBranch,
  deleteRemoteBranch,
  dropGitStash,
  getGitBranches,
  getGitStatus,
  gitFetch,
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
import type { GitStatus } from './api/types';

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const previousFetch = globalThis.fetch;
const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

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

const captureError = async (callback: () => Promise<void>): Promise<unknown> => {
  try {
    await callback();
    return null;
  } catch (error) {
    return error;
  }
};

describe('gitApiHttp index mutations', () => {
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

describe('gitApiHttp status cache', () => {
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
