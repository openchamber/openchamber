import { describe, expect, test } from 'bun:test';
import {
  cancelNetworkOperation,
  executeNetworkOperation,
  getNetworkOperation,
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
  dropGitStash,
  getGitBranches,
  getGitDiff,
  getGitFileDiff,
  getGitRangeDiff,
  getGitRangeFiles,
  getGitCommitDiff,
  getCommitFiles,
  getGitLog,
  getGitStatus,
  getGitWorktreeBootstrapStatus,
  gitRemoteListSchema,
  gitFetch,
  gitNetworkOperationSchema,
  planNetworkOperation,
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
import { gitIdentitySummarySchema } from './api/git-identity';
import {
  GitNetworkOperationRequestError,
  type GitNetworkOperation,
  type GitNetworkOperationPlan,
  type GitNetworkOperationRequest,
  type GitNetworkOperationStep,
} from './api/types';
import { switchRuntimeEndpoint } from './runtime-switch';

const ENDPOINT_FINGERPRINT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DESTINATION_FINGERPRINT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('renderer Git DTO contracts', () => {
  test('accepts only redacted remote display URLs', () => {
    expect(gitRemoteListSchema.parse([{
      name: 'origin',
      fetchUrl: 'https://example.com/team/repo.git',
      pushUrl: 'git@example.com:team/repo.git',
    }])).toHaveLength(1);
    for (const url of [
      'https://token@example.com/team/repo.git',
      'https://example.com/team/repo.git?token=secret',
      'https://example.com/team/repo.git#secret',
      'https://token:secret@',
    ]) {
      expect(gitRemoteListSchema.safeParse([{ name: 'origin', fetchUrl: url, pushUrl: '' }]).success).toBe(false);
    }
  });

  test('rejects transport configuration from author summaries', () => {
    expect(gitIdentitySummarySchema.parse({ userName: 'Author', userEmail: 'author@example.com' }))
      .toEqual({ userName: 'Author', userEmail: 'author@example.com' });
    expect(gitIdentitySummarySchema.safeParse({
      userName: 'Author',
      userEmail: 'author@example.com',
      sshCommand: 'ssh -i /private/key',
    }).success).toBe(false);
  });
});

describe('remote Fetch operation contract', () => {
  const request: GitNetworkOperationRequest = {
    operation: 'fetch', fetchScope: 'remote', directory: '/repo-remote-fetch',
    repositoryId: 'repository-one', bindingRevision: 2, configRevision: 'config-one',
    remote: { name: 'upstream', endpoint: { displayUrl: 'https://example.com/team/repo.git', fingerprint: ENDPOINT_FINGERPRINT } },
    transportMode: 'system',
  };
  const plan = {
    operationId: 'remote-fetch-one', runtimeIdentity: { id: 'runtime-one', platform: 'web' },
    transport: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } },
    target: {
      operation: 'fetch', fetchScope: 'remote', repositoryId: request.repositoryId, bindingRevision: request.bindingRevision,
      configRevision: request.configRevision, remote: request.remote, force: true,
    },
    completedSteps: [], state: 'planned',
  };

  test('preserves remote Fetch lifecycle metadata in the shared public parser', () => {
    expect(gitNetworkOperationSchema.parse(plan)).toEqual(plan);
    const completion = { ...plan, state: 'succeeded', completedSteps: ['validated', 'transferred'] };
    expect(gitNetworkOperationSchema.parse(completion)).toEqual(completion);
    const partial = {
      ...completion, state: 'partial', error: { code: 'TRANSPORT_FAILED', message: 'Safe failure' },
    };
    expect(gitNetworkOperationSchema.parse(partial)).toEqual(partial);
    for (const extra of [{ sourceRef: 'refs/*' }, { destinationRef: 'refs/*' }, { refspec: '+refs/*:refs/*' }, { force: 'yes' }]) {
      expect(gitNetworkOperationSchema.safeParse({ ...plan, target: { ...plan.target, ...extra } }).success).toBe(false);
    }
  });

  test('parses anonymous metadata without an actor, credential, or System verification', () => {
    const anonymous = { ...plan, transport: { mode: 'anonymous', verification: { status: 'anonymous' } } };
    expect(gitNetworkOperationSchema.parse(anonymous)).toEqual(anonymous);
    for (const extra of [{ actor: { kind: 'ssh-key', fingerprint: `SHA256:${'a'.repeat(43)}` } },
      { credentialId: 'private' }, { verification: { status: 'verified', method: 'credential' } },
      { verification: { status: 'unverified', reason: 'system-credentials' } }]) {
      expect(gitNetworkOperationSchema.safeParse({ ...anonymous, transport: { ...anonymous.transport, ...extra } }).success).toBe(false);
    }
  });

  test('sends remote scope without refs and validates the returned remote authority before execution', async () => {
    installWindowMock();
    const calls: FetchCall[] = [];
    // SAFETY: This fetch double implements the request arguments and always returns a Response.
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      return Response.json(String(input).endsWith('/execute')
        ? { ...plan, state: 'succeeded', completedSteps: ['validated', 'transferred'] } : plan);
    }) as typeof fetch;
    try {
      expect(calls).toHaveLength(0);
      const planned = await planNetworkOperation(request);
      expect(calls).toHaveLength(1);
      expect(calls[0].init?.body).toBe(JSON.stringify(request));
      expect((await executeNetworkOperation(planned.operationId)).state).toBe('succeeded');
      expect(calls).toHaveLength(2);
      expect(String(calls[1].input)).toBe('/api/git/network-operations/remote-fetch-one/execute');
    } finally {
      restoreMocks();
    }
  });
});
import type { GitStatus } from './api/types';
import { sessionEvents } from './sessionEvents';
import { gitPushScopeKey, subscribeGitPush } from './gitPushEvents';
import { getRuntimeKey } from './runtime-switch';
import { GitPathUnavailableError } from './api/git-path-diff';

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
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'http://localhost:3000' },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
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

const networkOperation = (
  state: GitNetworkOperation['state'],
  operation: 'push' | 'fetch' | 'pull' | 'sync' | 'clone' = 'push',
  operationId = 'operation-one',
 ) => {
  const base = {
    operationId,
    runtimeIdentity: { id: 'runtime-one', platform: 'web' },
    transport: operation === 'sync' ? {
      fetch: { mode: 'managed', verification: { status: 'verified', method: 'credential' } },
      push: { mode: 'managed', verification: { status: 'verified', method: 'credential' } },
    } : {
      mode: 'managed',
      verification: { status: 'verified', method: 'credential' },
    },
    target: operation === 'clone' ? {
      operation: 'clone',
      remote: { displayUrl: 'https://example.com/team/repo.git', fingerprint: ENDPOINT_FINGERPRINT },
      destination: { displayName: 'repo', fingerprint: DESTINATION_FINGERPRINT },
    } : operation === 'sync' ? {
      operation: 'sync',
      repositoryId: 'repository-one',
      bindingRevision: 2,
      configRevision: 'config-one',
      fetch: {
        name: 'upstream',
        endpoint: { displayUrl: 'https://example.com/team/repo.git', fingerprint: ENDPOINT_FINGERPRINT },
        sourceRef: 'refs/heads/main',
        destinationRef: 'refs/remotes/upstream/main',
      },
      pull: { destinationRef: 'refs/heads/main' },
      push: {
        name: 'origin',
        endpoint: { displayUrl: 'https://example.com/team/repo.git', fingerprint: ENDPOINT_FINGERPRINT },
        sourceRef: 'refs/heads/main',
        destinationRef: 'refs/heads/main',
      },
    } : {
      operation,
      repositoryId: 'repository-one',
      bindingRevision: 2,
      configRevision: 'config-one',
      remote: {
        name: 'origin',
        endpoint: { displayUrl: 'https://example.com/team/repo.git', fingerprint: ENDPOINT_FINGERPRINT },
      },
      sourceRef: 'refs/heads/main',
      destinationRef: 'refs/heads/main',
    },
    completedSteps: state === 'planned' ? [] : ['validated'],
    stepResults: operation === 'sync' && state !== 'planned' && state !== 'running' ? [
      { step: 'fetch', status: 'succeeded' },
      { step: 'pull', status: 'succeeded' },
      { step: 'push', status: state === 'succeeded' ? 'succeeded' : 'failed' },
    ] : undefined,
  };
  if (state === 'failed' || state === 'partial' || state === 'cancelled' || state === 'outcome-unknown' || state === 'conflicted') {
    const code = {
      failed: 'TRANSPORT_FAILED',
      partial: 'TRANSPORT_FAILED',
      cancelled: 'CANCELLED',
      'outcome-unknown': 'OUTCOME_UNKNOWN',
      conflicted: 'CONFLICT',
    }[state];
    return {
      ...base,
      state,
      error: { code, message: 'Safe failure' },
    };
  }
  return { ...base, state };
};

const pushRequest: GitNetworkOperationRequest = {
  operation: 'push',
  directory: '/repo-network',
  repositoryId: 'repository-one',
  bindingRevision: 2,
  configRevision: 'config-one',
  remote: {
    name: 'origin',
    endpoint: { displayUrl: 'https://example.com/team/repo.git', fingerprint: ENDPOINT_FINGERPRINT },
  },
  sourceRef: 'refs/heads/main',
  destinationRef: 'refs/heads/main',
  transportMode: 'managed',
};

const systemPushRequest: GitNetworkOperationRequest = {
  ...pushRequest,
  transportMode: 'system',
  acknowledgeSystemTransport: true,
};

const syncRequest: GitNetworkOperationRequest = {
  operation: 'sync',
  directory: '/repo-network',
  repositoryId: 'repository-one',
  bindingRevision: 2,
  configRevision: 'config-one',
  fetch: {
    remote: {
      name: 'upstream',
      endpoint: { displayUrl: 'https://example.com/team/repo.git', fingerprint: ENDPOINT_FINGERPRINT },
    },
    sourceRef: 'refs/heads/main',
    destinationRef: 'refs/remotes/upstream/main',
    transportMode: 'managed',
  },
  pull: { destinationRef: 'refs/heads/main' },
  push: {
    remote: {
      name: 'origin',
      endpoint: { displayUrl: 'https://example.com/team/repo.git', fingerprint: ENDPOINT_FINGERPRINT },
    },
    sourceRef: 'refs/heads/main',
    destinationRef: 'refs/heads/main',
    transportMode: 'managed',
  },
};

describe('gitApiHttp worktree bootstrap', () => {
  test('preserves structured hydration failures', async () => {
    installWindowMock();
    try {
      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        status: 'failed', phase: 'directory-created', error: 'Git LFS is required',
        errorCode: 'GIT_LFS_CLIENT_MISSING', updatedAt: 12,
        hydration: {
          status: 'client-missing', submodules: [{ path: 'vendor/ready', status: 'succeeded' }],
          lfs: [{
            path: '.', status: 'client-missing',
            error: { code: 'GIT_LFS_CLIENT_MISSING', message: 'Git LFS is required' },
          }],
        },
      })) as typeof fetch;

      expect(await getGitWorktreeBootstrapStatus('/repository')).toEqual({
        status: 'failed', phase: 'directory-created', error: 'Git LFS is required',
        errorCode: 'GIT_LFS_CLIENT_MISSING', updatedAt: 12,
        hydration: {
          status: 'client-missing',
          submodules: [{ path: 'vendor/ready', status: 'succeeded' }],
          lfs: [{
            path: '.', status: 'client-missing',
            error: { code: 'GIT_LFS_CLIENT_MISSING', message: 'Git LFS is required' },
          }],
        },
      });
    } finally {
      restoreMocks();
    }
  });
});

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
  test('sends commit hashes and rename paths without trimming and rejects incomplete commit lists', async () => {
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
      await expect(getCommitFiles('/repo', hash)).rejects.toThrow();
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
    // SAFETY: This test double implements the fetch arguments and always returns a Response.
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

describe('gitApiHttp network operations', () => {
  test('serializes plan and execute routes and invalidates status only after successful execute', async () => {
    installWindowMock();
    const calls: FetchCall[] = [];
    let statusRequestCount = 0;
    // SAFETY: This test double implements the fetch arguments and always returns a Response.
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.startsWith('/api/git/status')) {
        statusRequestCount += 1;
        return Response.json({
          current: 'main', tracking: null, ahead: 0, behind: statusRequestCount, files: [], isClean: true,
        });
      }
      if (url.endsWith('/execute')) return Response.json(networkOperation('succeeded', 'push', 'operation-success'));
      return Response.json(networkOperation('planned', 'push', 'operation-success'));
    }) as typeof fetch;

    try {
      await getGitStatus(pushRequest.directory);
      const plan = await planNetworkOperation(pushRequest);
      await executeNetworkOperation(plan.operationId);
      const status = await getGitStatus(pushRequest.directory);

      expect(status.behind).toBe(2);
      expect(String(calls[1].input)).toBe('/api/git/network-operations');
      expect(calls[1].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[1].init?.body))).toEqual(pushRequest);
      expect(String(calls[2].input)).toBe('/api/git/network-operations/operation-success/execute');
    } finally {
      restoreMocks();
    }
  });

  test('serializes system transport acknowledgement without expecting it in the public plan', async () => {
    installWindowMock();
    const calls: FetchCall[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        ...networkOperation('planned', 'push', 'operation-system-ack'),
        transport: { mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' } },
      });
    }) as typeof fetch;
    try {
      await planNetworkOperation(systemPushRequest);
      expect(JSON.parse(String(calls[0].init?.body))).toEqual(systemPushRequest);
    } finally {
      restoreMocks();
    }
  });

  test('validates separate sync targets and complete terminal step results', async () => {
    installWindowMock();
    let terminal = false;
    // SAFETY: This test double implements the fetch arguments and always returns a Response.
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith('/execute')) terminal = true;
      return Response.json(networkOperation(terminal ? 'succeeded' : 'planned', 'sync', 'operation-sync'));
    }) as typeof fetch;
    try {
      const plan = await planNetworkOperation(syncRequest);
      if (plan.target.operation !== 'sync') throw new Error('Expected sync target');
      expect(plan.target.fetch.name).toBe('upstream');
      expect(plan.target.fetch.destinationRef).toBe('refs/remotes/upstream/main');
      expect(plan.target.push.name).toBe('origin');
      expect(plan.target.push.destinationRef).toBe('refs/heads/main');
      const result = await executeNetworkOperation(plan.operationId);
      expect(result.state).toBe('succeeded');
      expect(result.stepResults?.map(({ step, status }) => ({ step, status }))).toEqual([
        { step: 'fetch', status: 'succeeded' },
        { step: 'pull', status: 'succeeded' },
        { step: 'push', status: 'succeeded' },
      ]);
    } finally {
      restoreMocks();
    }
  });

  test('does not invalidate untracked status reads', async () => {
    installWindowMock();
    let statusRequestCount = 0;
    // SAFETY: This test double implements the fetch arguments and always returns a Response.
    globalThis.fetch = (async (input) => {
      if (String(input).startsWith('/api/git/status')) {
        statusRequestCount += 1;
        return Response.json({
          current: 'main', tracking: null, ahead: 0, behind: 0, files: [], isClean: true,
        });
      }
      return Response.json(networkOperation('succeeded'));
    }) as typeof fetch;

    try {
      await getGitStatus('/repo-network-poll');
      await getNetworkOperation('operation-one');
      await cancelNetworkOperation('operation-one');
      await getGitStatus('/repo-network-poll');
      expect(statusRequestCount).toBe(1);
    } finally {
      restoreMocks();
    }
  });

  test('does not invalidate status after a failed execute response', async () => {
    installWindowMock();
    let statusRequestCount = 0;
    const request = { ...pushRequest, directory: '/repo-network-failed' };
    // SAFETY: This test double implements the fetch arguments and always returns a Response.
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.startsWith('/api/git/status')) {
        statusRequestCount += 1;
        return Response.json({
          current: 'main', tracking: null, ahead: 0, behind: 0, files: [], isClean: true,
        });
      }
      if (url.endsWith('/execute')) return Response.json(networkOperation('failed', 'push', 'operation-failed'));
      return Response.json(networkOperation('planned', 'push', 'operation-failed'));
    }) as typeof fetch;

    try {
      await getGitStatus(request.directory);
      const plan = await planNetworkOperation(request);
      await executeNetworkOperation(plan.operationId);
      await getGitStatus(request.directory);
      expect(statusRequestCount).toBe(1);
    } finally {
      restoreMocks();
    }
  });

  test('rejects malformed or non-redacted operation responses', async () => {
    installWindowMock();
    // SAFETY: This test double accepts every fetch call and always returns a Response.
    globalThis.fetch = (async () => Response.json({
      ...networkOperation('planned'),
      rawEndpoint: 'https://token@example.com/team/repo.git',
    })) as typeof fetch;

    try {
      const error = await captureError(async () => {
        await planNetworkOperation(pushRequest);
      });
      expect(error).toBeInstanceOf(Error);
    } finally {
      restoreMocks();
    }
  });

  test('rejects credential and query-bearing endpoint displays in tracked and reloaded snapshots', async () => {
    installWindowMock();
    const unsafeDisplays = [
      'https://user@example.com/team/repo.git',
      'https://example.com/team/repo.git?access_token=secret',
      'ssh://example.com/team/repo.git#private',
      'git@example.com:team/repo.git?access_token=secret',
    ];
    try {
      for (const [index, displayUrl] of unsafeDisplays.entries()) {
        const operationId = `operation-unsafe-${index}`;
        const base = networkOperation('planned', 'push', operationId);
        if (base.target.operation !== 'push') throw new Error('Expected push operation fixture');
        const remote = base.target.remote;
        if (!remote) throw new Error('Expected push remote fixture');
        const unsafe = {
          ...base,
          target: {
            ...base.target,
            remote: {
              ...remote,
              endpoint: { ...remote.endpoint, displayUrl },
            },
          },
        };
        globalThis.fetch = (async () => Response.json(unsafe)) as typeof fetch;
        await expect(planNetworkOperation(pushRequest)).rejects.toThrow();
        await expect(getNetworkOperation(operationId)).rejects.toThrow();
      }
    } finally {
      restoreMocks();
    }
  });

  test('accepts a strict SCP endpoint display in tracked and reloaded snapshots', async () => {
    installWindowMock();
    const operationId = 'operation-scp-display';
    const scpRequest: GitNetworkOperationRequest = {
      ...pushRequest,
      forceWithLease: { expectedRemoteSha: 'a'.repeat(40) },
      remote: {
        name: 'origin',
        endpoint: { displayUrl: 'git@example.com:team/repo.git', fingerprint: ENDPOINT_FINGERPRINT },
      },
    };
    const scpTarget = {
      operation: 'push' as const,
      repositoryId: scpRequest.repositoryId,
      bindingRevision: scpRequest.bindingRevision,
      configRevision: scpRequest.configRevision,
      remote: scpRequest.remote,
      sourceRef: scpRequest.sourceRef,
      destinationRef: scpRequest.destinationRef,
      forceWithLease: scpRequest.forceWithLease,
    };
    const scpOperation: GitNetworkOperationPlan = {
      operationId,
      runtimeIdentity: { id: 'runtime-one', platform: 'web' },
      transport: { mode: 'managed', verification: { status: 'verified', method: 'credential' } },
      target: scpTarget,
      completedSteps: [],
      state: 'planned',
    };
    let trackedReads = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes(operationId)) {
        trackedReads += 1;
        if (trackedReads === 1) return Response.json({
          ...scpOperation,
          state: 'running',
          transport: {
            ...scpOperation.transport,
            actor: { kind: 'provider', provider: 'github', instance: 'github.com', accountId: 'github.com#42' },
          },
        });
        const target = { ...scpTarget, forceWithLease: undefined };
        return Response.json({
          ...scpOperation,
          state: 'outcome-unknown',
          error: { code: 'OUTCOME_UNKNOWN', message: 'Inspect repository state' },
          target: {
            ...target,
            remote: { ...target.remote, endpoint: { ...target.remote.endpoint, displayUrl: 'example.com:team/repo.git' } },
          },
        });
      }
      if (String(input).includes('operation-untracked-scp')) {
        return Response.json({ ...scpOperation, operationId: 'operation-untracked-scp' });
      }
      return Response.json(scpOperation);
    }) as typeof fetch;
    try {
      expect((await planNetworkOperation(scpRequest)).operationId).toBe(operationId);
      expect((await getNetworkOperation(operationId)).state).toBe('running');
      expect((await getNetworkOperation(operationId)).state).toBe('outcome-unknown');
      const reloaded = await getNetworkOperation('operation-untracked-scp');
      expect(reloaded.target.operation).toBe('push');
      if (reloaded.target.operation === 'push') {
        expect(reloaded.target.remote.endpoint.displayUrl).toBe('git@example.com:team/repo.git');
      }
    } finally {
      restoreMocks();
    }
  });

  test('preserves strict route error codes and rejects malformed error envelopes', async () => {
    installWindowMock();
    try {
      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        error: 'Git network operations are unavailable',
        code: 'RUNTIME_UNSUPPORTED',
      }, { status: 501 })) as typeof fetch;
      const routeError = await captureError(async () => {
        await executeNetworkOperation('operation-one');
      });
      expect(routeError).toBeInstanceOf(GitNetworkOperationRequestError);
      if (!(routeError instanceof GitNetworkOperationRequestError)) {
        throw new Error('Expected a typed Git network operation error');
      }
      expect(routeError.code).toBe('RUNTIME_UNSUPPORTED');
      expect(routeError.message).toBe('Git network operations are unavailable');
      expect(routeError.status).toBe(501);

      globalThis.fetch = (async () => Response.json({
        error: 'System Git transport acknowledgement is required',
        code: 'ACKNOWLEDGEMENT_REQUIRED',
      }, { status: 409 })) as typeof fetch;
      const acknowledgementError = await captureError(async () => {
        await planNetworkOperation(systemPushRequest);
      });
      expect(acknowledgementError).toBeInstanceOf(GitNetworkOperationRequestError);
      if (acknowledgementError instanceof GitNetworkOperationRequestError) {
        expect(acknowledgementError.code).toBe('ACKNOWLEDGEMENT_REQUIRED');
        expect(acknowledgementError.status).toBe(409);
      }

      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        error: 'unsafe shape',
        code: 'RUNTIME_UNSUPPORTED',
        detail: 'must not pass through',
      }, { status: 501 })) as typeof fetch;
      const malformedError = await captureError(async () => {
        await executeNetworkOperation('operation-one');
      });
      expect(malformedError).toBeInstanceOf(Error);
      expect(malformedError instanceof GitNetworkOperationRequestError).toBe(false);
    } finally {
      restoreMocks();
    }
  });

  test('accepts the server maximum redacted error message length', async () => {
    installWindowMock();
    const message = 'x'.repeat(8192);
    try {
      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        error: message,
        code: 'TRANSPORT_FAILED',
      }, { status: 502 })) as typeof fetch;
      const routeError = await captureError(async () => {
        await executeNetworkOperation('operation-max-route-error');
      });
      expect(routeError).toBeInstanceOf(GitNetworkOperationRequestError);
      if (!(routeError instanceof GitNetworkOperationRequestError)) {
        throw new Error('Expected a typed Git network operation error');
      }
      expect(routeError.message).toBe(message);

      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        ...networkOperation('failed', 'push', 'operation-max-snapshot-error'),
        error: { code: 'TRANSPORT_FAILED', message },
      })) as typeof fetch;
      const operation = await getNetworkOperation('operation-max-snapshot-error');
      expect(operation.state).toBe('failed');
      if (operation.state === 'failed') expect(operation.error.message).toBe(message);

      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        ...networkOperation('failed', 'push', 'operation-oversize-error'),
        error: { code: 'TRANSPORT_FAILED', message: `${message}x` },
      })) as typeof fetch;
      await expect(getNetworkOperation('operation-oversize-error')).rejects.toThrow();
    } finally {
      restoreMocks();
    }
  });

  test('enforces the server error-code registry for each terminal state', async () => {
    installWindowMock();
    const allowed = [
      { state: 'failed', codes: [
        'INVALID_REQUEST',
        'AUTHENTICATION_REQUIRED',
        'AUTHENTICATION_FAILED',
        'TRANSPORT_FAILED',
        'RUNTIME_UNSUPPORTED',
        'UNKNOWN',
      ] },
      { state: 'cancelled', codes: ['CANCELLED', 'TIMEOUT'] },
      { state: 'outcome-unknown', codes: ['OUTCOME_UNKNOWN'] },
      { state: 'conflicted', codes: ['STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED', 'CONFLICT'] },
    ] as const;
    try {
      for (const { state, codes } of allowed) {
        for (const code of codes) {
          const operationId = `operation-${state}-${code.toLowerCase()}`;
          // SAFETY: This test double accepts every fetch call and always returns a Response.
          globalThis.fetch = (async () => Response.json({
            ...networkOperation(state, 'push', operationId),
            error: { code, message: 'Safe failure' },
          })) as typeof fetch;
          const operation = await getNetworkOperation(operationId);
          expect(operation.state).toBe(state);
          if ('error' in operation) expect(operation.error.code).toBe(code);
        }
      }

      const rejected = [
        { state: 'failed', code: 'CONFLICT' },
        { state: 'cancelled', code: 'TRANSPORT_FAILED' },
        { state: 'outcome-unknown', code: 'TIMEOUT' },
        { state: 'conflicted', code: 'OUTCOME_UNKNOWN' },
      ] as const;
      for (const { state, code } of rejected) {
        const operationId = `operation-invalid-${state}`;
        // SAFETY: This test double accepts every fetch call and always returns a Response.
        globalThis.fetch = (async () => Response.json({
          ...networkOperation(state, 'push', operationId),
          error: { code, message: 'Invalid pairing' },
        })) as typeof fetch;
        await expect(getNetworkOperation(operationId)).rejects.toThrow();
      }
    } finally {
      restoreMocks();
    }
  });

  test('retains a terminal tombstone and rejects later active snapshots', async () => {
    installWindowMock();
    const operationId = 'operation-out-of-order';
    let state: GitNetworkOperation['state'] = 'planned';
    // SAFETY: This test double accepts every fetch call and always returns a Response.
    globalThis.fetch = (async () => Response.json(networkOperation(state, 'push', operationId))) as typeof fetch;
    try {
      const plan = await planNetworkOperation(pushRequest);
      state = 'succeeded';
      await getNetworkOperation(plan.operationId);
      state = 'running';
      await expect(executeNetworkOperation(plan.operationId)).rejects.toThrow('Malformed Git network operation response');
      state = 'planned';
      await expect(planNetworkOperation(pushRequest)).rejects.toThrow('Malformed Git network operation plan response');
    } finally {
      restoreMocks();
    }
  });

  test('prunes only a matching tracker after an authoritative NOT_FOUND envelope', async () => {
    installWindowMock();
    const operationId = 'operation-not-found';
    let response = Response.json(networkOperation('planned', 'push', operationId));
    // SAFETY: This test double accepts every fetch call and always returns a Response.
    globalThis.fetch = (async () => response.clone()) as typeof fetch;
    try {
      await planNetworkOperation(pushRequest);
      response = Response.json({ error: 'Git network operation was not found', code: 'NOT_FOUND' }, { status: 404 });
      const notFound = await captureError(async () => {
        await getNetworkOperation(operationId);
      });
      expect(notFound).toBeInstanceOf(GitNetworkOperationRequestError);
      if (!(notFound instanceof GitNetworkOperationRequestError)) {
        throw new Error('Expected a typed Git network operation error');
      }
      expect(notFound.code).toBe('NOT_FOUND');
      expect(notFound.status).toBe(404);

      response = Response.json({
        ...networkOperation('running', 'push', operationId),
        runtimeIdentity: { id: 'replacement-server', platform: 'web' },
      });
      expect((await getNetworkOperation(operationId)).state).toBe('running');
    } finally {
      restoreMocks();
    }
  });

  test('does not prune tracking for a malformed NOT_FOUND payload', async () => {
    installWindowMock();
    const operationId = 'operation-malformed-not-found';
    let response = Response.json(networkOperation('planned', 'push', operationId));
    // SAFETY: This test double accepts every fetch call and always returns a Response.
    globalThis.fetch = (async () => response.clone()) as typeof fetch;
    try {
      await planNetworkOperation(pushRequest);
      response = Response.json({
        error: 'Git network operation was not found',
        code: 'NOT_FOUND',
        detail: 'unexpected',
      }, { status: 404 });
      await expect(getNetworkOperation(operationId)).rejects.toThrow();

      response = Response.json({
        ...networkOperation('running', 'push', operationId),
        runtimeIdentity: { id: 'replacement-server', platform: 'web' },
      });
      await expect(getNetworkOperation(operationId)).rejects.toThrow('Malformed Git network operation response');
    } finally {
      restoreMocks();
    }
  });

  test('expires abandoned and terminal tracking on the server retention windows', async () => {
    installWindowMock();
    const originalNow = Date.now;
    let now = originalNow();
    let response = Response.json(networkOperation('planned', 'push', 'operation-abandoned'));
    Date.now = () => now;
    // SAFETY: This test double accepts every fetch call and always returns a Response.
    globalThis.fetch = (async () => response.clone()) as typeof fetch;
    try {
      await planNetworkOperation(pushRequest);
      now += 15 * 60 * 1000 + 1;
      response = Response.json({
        ...networkOperation('running', 'push', 'operation-abandoned'),
        runtimeIdentity: { id: 'replacement-server', platform: 'web' },
      });
      expect((await getNetworkOperation('operation-abandoned')).state).toBe('running');

      response = Response.json(networkOperation('planned', 'push', 'operation-expired-terminal'));
      await planNetworkOperation(pushRequest);
      response = Response.json(networkOperation('succeeded', 'push', 'operation-expired-terminal'));
      await getNetworkOperation('operation-expired-terminal');
      now += 60 * 60 * 1000 + 1;
      response = Response.json({
        ...networkOperation('running', 'push', 'operation-expired-terminal'),
        runtimeIdentity: { id: 'replacement-server', platform: 'web' },
      });
      expect((await getNetworkOperation('operation-expired-terminal')).state).toBe('running');
    } finally {
      Date.now = originalNow;
      restoreMocks();
    }
  });

  test('bounds tracking to the server registry capacity', async () => {
    installWindowMock();
    let response = Response.json(networkOperation('planned', 'push', 'operation-capacity-oldest'));
    // SAFETY: This test double accepts every fetch call and always returns a Response.
    globalThis.fetch = (async () => response.clone()) as typeof fetch;
    try {
      await planNetworkOperation(pushRequest);
      response = Response.json(networkOperation('succeeded', 'push', 'operation-capacity-oldest'));
      await getNetworkOperation('operation-capacity-oldest');

      for (let index = 0; index < 256; index += 1) {
        const operationId = `operation-capacity-${index}`;
        response = Response.json(networkOperation('planned', 'push', operationId));
        await planNetworkOperation(pushRequest);
      }

      response = Response.json(networkOperation('running', 'push', 'operation-capacity-oldest'));
      expect((await getNetworkOperation('operation-capacity-oldest')).state).toBe('running');
    } finally {
      restoreMocks();
    }
  });

  test('rejects response IDs and planned authority that do not match the request', async () => {
    installWindowMock();
    try {
      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        ...networkOperation('succeeded'),
        operationId: 'operation-two',
      })) as typeof fetch;
      await expect(executeNetworkOperation('operation-one')).rejects.toThrow('Malformed Git network operation response');

      const mismatchedTarget = {
        operation: 'push',
        repositoryId: pushRequest.repositoryId,
        bindingRevision: pushRequest.bindingRevision,
        configRevision: pushRequest.configRevision,
        remote: pushRequest.remote,
        sourceRef: pushRequest.sourceRef,
        destinationRef: 'refs/heads/other',
      };
      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        ...networkOperation('planned'),
        target: mismatchedTarget,
      })) as typeof fetch;
      await expect(planNetworkOperation(pushRequest)).rejects.toThrow('Malformed Git network operation plan response');
    } finally {
      restoreMocks();
    }
  });

  test('invalidates status when polling observes tracked completion', async () => {
    installWindowMock();
    let statusRequestCount = 0;
    let operationState: GitNetworkOperation['state'] = 'planned';
    const request = { ...pushRequest, directory: '/repo-network-poll-completion' };
    // SAFETY: This test double implements the fetch arguments and always returns a Response.
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.startsWith('/api/git/status')) {
        statusRequestCount += 1;
        return Response.json({
          current: 'main', tracking: null, ahead: 0, behind: statusRequestCount, files: [], isClean: true,
        });
      }
       if (url === '/api/git/network-operations') return Response.json(networkOperation('planned', 'push', 'operation-poll'));
       return Response.json(networkOperation(operationState, 'push', 'operation-poll'));
    }) as typeof fetch;

    try {
      await getGitStatus(request.directory);
      const plan = await planNetworkOperation(request);
      operationState = 'succeeded';
      await getNetworkOperation(plan.operationId);
      const status = await getGitStatus(request.directory);
      expect(status.behind).toBe(2);
      await getNetworkOperation(plan.operationId);
      expect((await getGitStatus(request.directory)).behind).toBe(2);
      expect(statusRequestCount).toBe(2);
    } finally {
      restoreMocks();
    }
  });

  test('invalidates only cancellation and failure outcomes that can change local state', async () => {
    installWindowMock();
    const cases: Array<{
      operation: 'pull' | 'fetch';
      state: 'cancelled' | 'conflicted' | 'outcome-unknown' | 'failed';
      steps: GitNetworkOperationStep[];
      invalidates: boolean;
    }> = [
      { operation: 'pull', state: 'cancelled', steps: [], invalidates: false },
      { operation: 'fetch', state: 'cancelled', steps: ['transferred'], invalidates: true },
      { operation: 'pull', state: 'cancelled', steps: ['transferred'], invalidates: true },
      { operation: 'pull', state: 'conflicted', steps: ['transferred'], invalidates: true },
      { operation: 'pull', state: 'outcome-unknown', steps: ['updated-local-repository'], invalidates: true },
      { operation: 'pull', state: 'failed', steps: ['transferred', 'cleaned-up'], invalidates: true },
      { operation: 'pull', state: 'failed', steps: [], invalidates: false },
    ];

    try {
      for (const [index, current] of cases.entries()) {
        const directory = `/repo-terminal-${index}`;
        const operationId = `operation-terminal-${index}`;
        const request: GitNetworkOperationRequest = current.operation === 'fetch'
          ? { ...pushRequest, operation: 'fetch', directory }
          : { ...pushRequest, operation: 'pull', directory };
        let statusRequestCount = 0;
        // SAFETY: This test double implements the fetch arguments and always returns a Response.
        globalThis.fetch = (async (input) => {
          const url = String(input);
          if (url.startsWith('/api/git/status')) {
            statusRequestCount += 1;
            return Response.json({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], isClean: true });
          }
          if (url === '/api/git/network-operations') {
            return Response.json(networkOperation('planned', current.operation, operationId));
          }
          return Response.json({
            ...networkOperation(current.state, current.operation, operationId),
            completedSteps: current.steps,
          });
        }) as typeof fetch;

        await getGitStatus(directory);
        const plan = await planNetworkOperation(request);
        await cancelNetworkOperation(plan.operationId);
        await getGitStatus(directory);
        expect(statusRequestCount).toBe(current.invalidates ? 2 : 1);
      }
    } finally {
      restoreMocks();
    }
  });

  test('accepts precise managed actor metadata and rejects it on system transport', async () => {
    installWindowMock();
    const providerActor = {
      kind: 'provider' as const,
      provider: 'github',
      instance: 'github.com',
      accountId: 'account-one',
      login: 'octocat',
    };
    try {
      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        ...networkOperation('planned', 'push', 'operation-actor'),
        transport: {
          mode: 'managed',
          verification: { status: 'verified', method: 'credential' },
          actor: providerActor,
        },
      })) as typeof fetch;
      const plan = await planNetworkOperation(pushRequest);
      if (!('mode' in plan.transport)) throw new Error('Expected one Git transport');
      expect(plan.transport.mode).toBe('managed');
      if (plan.transport.mode === 'managed') {
        expect(plan.transport.actor).toEqual(providerActor);
      }

      // SAFETY: This test double accepts every fetch call and always returns a Response.
      globalThis.fetch = (async () => Response.json({
        ...networkOperation('planned', 'push', 'operation-actor'),
        transport: {
          mode: 'system',
          verification: { status: 'unverified', reason: 'system-credentials' },
          actor: providerActor,
        },
      })) as typeof fetch;
      await expect(planNetworkOperation({ ...pushRequest, transportMode: 'system' })).rejects.toThrow();
    } finally {
      restoreMocks();
    }
  });

  test('rejects invalid fingerprints, revisions, refs, and lease SHAs', async () => {
    installWindowMock();
    const invalidOperations = [
      { ...networkOperation('planned'), operationId: '' },
      {
        ...networkOperation('planned'),
        target: { ...networkOperation('planned').target, bindingRevision: 0 },
      },
      {
        ...networkOperation('planned'),
        target: { ...networkOperation('planned').target, sourceRef: '' },
      },
      {
        ...networkOperation('planned'),
        target: {
          ...networkOperation('planned').target,
          remote: {
            name: 'origin',
            endpoint: { displayUrl: 'https://example.com/team/repo.git', fingerprint: 'not-a-fingerprint' },
          },
        },
      },
      {
        ...networkOperation('planned'),
        target: { ...networkOperation('planned').target, forceWithLease: { expectedRemoteSha: 'abc123' } },
      },
    ];

    try {
      for (const operation of invalidOperations) {
        // SAFETY: This test double accepts every fetch call and always returns a Response.
        globalThis.fetch = (async () => Response.json(operation)) as typeof fetch;
        await expect(planNetworkOperation(pushRequest)).rejects.toThrow();
      }
    } finally {
      restoreMocks();
    }
  });

  test('keeps clone planning distinct and sends its pre-repository fields', async () => {
    installWindowMock();
    const calls: FetchCall[] = [];
    // SAFETY: This test double implements the fetch arguments and always returns a Response.
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      const operation = networkOperation('planned', 'clone', 'operation-clone');
      return Response.json({
        ...operation,
        target: {
          ...operation.target,
          remote: { ...operation.target.remote, displayUrl: 'https://example.com/team/repo.git' },
        },
      });
    }) as typeof fetch;
    const request: GitNetworkOperationRequest = {
      operation: 'clone',
      remoteUrl: 'https://example.com/team/repo.git',
      destinationPath: '/new/repo',
      transportMode: 'managed',
      credentialAccount: { provider: 'gitlab', instance: 'https://example.com', accountId: 'account-two' },
      gitIdentityId: 'identity-one',
    };

    try {
      await planNetworkOperation(request);
      expect(JSON.parse(String(calls[0].init?.body))).toEqual(request);
      expect(JSON.parse(String(calls[0].init?.body)).repositoryId).toBe(undefined);
    } finally {
      restoreMocks();
    }
  });

  test('accepts partial clone only with authoritative completed-checkout evidence', () => {
    const operation = { ...networkOperation('planned', 'clone', 'retained-clone'), state: 'partial',
      error: { code: 'UNKNOWN', message: 'Checkout retained. Finish Git setup.' } };
    expect(gitNetworkOperationSchema.safeParse({ ...operation, completedSteps: ['transferred'] }).success).toBe(false);
    expect(gitNetworkOperationSchema.safeParse({ ...operation, completedSteps: ['transferred', 'checked-out'] }).success).toBe(true);
  });

  test('accepts bounded checkout hydration results and rejects absolute checkout paths', () => {
    const endpoint = { displayUrl: 'https://modules.example/team/library.git', fingerprint: 'e'.repeat(43) };
    const operation = {
      ...networkOperation('planned'),
      target: {
        operation: 'checkout-hydration', repositoryId: 'repository-one', bindingRevision: 2,
        configRevision: 'config-one', remote: { name: 'origin', endpoint },
        requirements: [{ kind: 'submodule', path: 'vendor/library', endpoint }],
      },
    };
    expect(gitNetworkOperationSchema.safeParse(operation).success).toBe(true);
    expect(gitNetworkOperationSchema.safeParse({
      ...operation,
      target: { ...operation.target, requirements: [{ kind: 'submodule', path: '/private/library', endpoint }] },
    }).success).toBe(false);
    expect(gitNetworkOperationSchema.safeParse({
      ...operation,
      target: { ...operation.target, requirements: [{ kind: 'submodule', path: 'vendor/library\nother', endpoint }] },
    }).success).toBe(false);
    expect(gitNetworkOperationSchema.safeParse({
      ...operation,
      target: { ...operation.target, requirements: [{
        kind: 'submodule', path: 'vendor/library', endpoint: { ...endpoint, displayUrl: 'https://token@modules.example/team/library.git' },
      }] },
    }).success).toBe(false);
    expect(gitNetworkOperationSchema.safeParse({
      ...operation,
      state: 'failed', error: { code: 'AUTHENTICATION_REQUIRED', message: 'Grant required' },
      hydration: {
        status: 'authorization-required',
        submodules: [{ path: '/private/library', status: 'authorization-required', endpoint,
          error: { code: 'AUTHENTICATION_REQUIRED', message: 'Grant required' } }],
        lfs: [],
      },
    }).success).toBe(false);
    expect(gitNetworkOperationSchema.safeParse({
      ...operation,
      state: 'succeeded',
      hydration: {
        status: 'failed',
        submodules: [{ path: 'vendor/library', status: 'failed', error: { code: 'TRANSPORT_FAILED', message: 'Failed' } }],
        lfs: [],
      },
    }).success).toBe(false);
  });

  test('rejects a stale-runtime completion without invalidating the active runtime cache', async () => {
    installWindowMock();
    let resolveExecute: (response: Response) => void = () => {
      throw new Error('execute request did not start');
    };
    const statusRequests = new Map<string, number>();
    // SAFETY: This test double implements the fetch arguments and always returns a Response.
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/auth/url-token')) return Response.json({});
      if (url.includes('/api/git/status')) {
        const runtime = new URL(url).hostname;
        const count = (statusRequests.get(runtime) ?? 0) + 1;
        statusRequests.set(runtime, count);
        return Response.json({ current: 'main', tracking: null, ahead: 0, behind: count, files: [], isClean: true });
      }
      if (url.endsWith('/api/git/network-operations')) {
        return Response.json({
           ...networkOperation('planned', 'push', 'operation-runtime'),
          runtimeIdentity: { id: 'server-a', platform: 'web' },
        });
      }
      if (url.endsWith('/execute')) {
        return new Promise<Response>((resolve) => {
          resolveExecute = resolve;
        });
      }
      return Response.json({});
    }) as typeof fetch;

    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.example', runtimeKey: 'runtime-a' });
      const request = { ...pushRequest, directory: '/repo-runtime-scope' };
      await getGitStatus(request.directory);
      const plan = await planNetworkOperation(request);
      const completion = executeNetworkOperation(plan.operationId);
      await Promise.resolve();

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-b.example', runtimeKey: 'runtime-b' });
      await getGitStatus(request.directory);
      resolveExecute(Response.json({
         ...networkOperation('succeeded', 'push', 'operation-runtime'),
        runtimeIdentity: { id: 'server-a', platform: 'web' },
      }));
      await expect(completion).rejects.toThrow('stale runtime');
      await getGitStatus(request.directory);
      expect(statusRequests.get('runtime-b.example')).toBe(1);

      switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime-a.example', runtimeKey: 'runtime-a' });
      await getGitStatus(request.directory);
      expect(statusRequests.get('runtime-a.example')).toBe(2);
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
