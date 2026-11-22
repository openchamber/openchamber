import { afterEach, describe, expect, test } from 'bun:test';

import type { GitBranch, GitStatus } from '@/lib/api/types';
import type { SourceControlBindingRead } from '@/lib/source-control/types';
import { clearWorktreeBootstrapState, markWorktreeBootstrapPending } from '@/lib/worktrees/worktreeBootstrap';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { openGuestWalkthrough, readWalkthroughRepository, type WalkthroughRepository } from './open-walkthrough';

const repository: WalkthroughRepository = {
  directory: '/repo',
  autoSelected: false,
  branch: 'feature',
  branches: ['feature', 'develop', 'main', 'remotes/origin/main', 'remotes/origin/feature', 'remotes/upstream/main'],
  remoteNames: new Set(['origin', 'upstream']),
  primaryRemote: 'origin',
};

const reader = (answer: WalkthroughRepository | null | Error, reads: string[] = []) => async (directory: string) => {
  reads.push(directory);
  if (answer instanceof Error) throw answer;
  return answer;
};

const open = (base: string, readRepository: Parameters<typeof openGuestWalkthrough>[0]['readRepository'] = reader(repository)) =>
  openGuestWalkthrough({ base, directory: '/repo', readRepository, supported: true });

const chosenBase = (directory = '/repo') => useGitBaseBranchStore.getState().getOverride(directory, 'feature');
const requested = (directory = '/repo') => useWalkthroughStore.getState().getRequestedTarget(directory);
const walkthroughTabs = (directory: string) => (useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [])
  .filter((tab) => tab.mode === 'walkthrough');

const status = (current: string): GitStatus => ({ current, tracking: null, ahead: 0, behind: 0, files: [], isClean: true });
const fullStatus = (current: string): GitStatus => ({ ...status(current), diffStats: { staged: {}, working: {} } });
const branchList = (all: string[]): GitBranch => ({ all, current: all[0] ?? '', branches: {} });
const bindingRead: SourceControlBindingRead = {
  status: 'missing', revision: 0, binding: null, repository: { repositoryId: 'repo', configRevision: 'config', bare: false, remotes: [] },
};
const sourceControl = { repositoryBinding: async () => bindingRead };
const fakeGit = (answers: { repositories: Record<string, boolean>; status: Record<string, GitStatus | Error>; branches: Record<string, string[]> }) => ({
  checkIsGitRepository: async (directory: string) => answers.repositories[directory] ?? false,
  getGitStatus: async (directory: string) => {
    const answer = answers.status[directory];
    if (!answer || answer instanceof Error) throw answer ?? new Error('no status');
    return answer;
  },
  getGitBranches: async (directory: string) => branchList(answers.branches[directory] ?? []),
});

describe('openGuestWalkthrough', () => {
  afterEach(() => {
    useGitBaseBranchStore.setState({ overrides: {} });
    for (const directory of ['/repo', '/repo/sub']) useWalkthroughStore.getState().clearRequestedTarget(directory);
    useGitStore.setState({ directories: new Map(), nestedRepoSelection: new Map(), autoNestedRepoSelections: new Set(), nestedReposByRoot: new Map() });
  });

  test('chooses the base the way the picker does and opens This branch against it', async () => {
    expect(await open('develop')).toEqual({ ok: true });
    expect(chosenBase()).toBe('refs/heads/develop');
    expect(requested()).toEqual({ source: { kind: 'branch', baseRef: 'refs/heads/develop', headRef: 'feature' } });
    expect(walkthroughTabs('/repo').some((tab) => tab.targetDirectory === null)).toBe(true);
  });

  test('qualifies a bare name the way the view does, so the view compares with exactly that ref', async () => {
    expect(await open('main')).toEqual({ ok: true });
    expect(chosenBase()).toBe('origin/main');
    expect(requested()?.source).toEqual({ kind: 'branch', baseRef: 'origin/main', headRef: 'feature' });
  });

  test('a base the view would skip fails and keeps the previous choice and scope', async () => {
    await open('develop');
    for (const base of ['nope', 'feature', 'origin/feature', 'upstream/main']) {
      expect(await open(base)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    }
    expect(chosenBase()).toBe('refs/heads/develop');
    expect(requested()?.source).toEqual({ kind: 'branch', baseRef: 'refs/heads/develop', headRef: 'feature' });
  });

  test('a remote ref the bound remote lacks fails even when a local branch has the same name', async () => {
    const localOnly = reader({ ...repository, branches: ['feature', 'develop', 'main', 'remotes/origin/feature'] });
    await open('develop', localOnly);
    for (const base of ['origin/main', 'refs/remotes/origin/main', 'remotes/origin/main']) {
      expect(await open(base, localOnly)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    }
    expect(chosenBase()).toBe('refs/heads/develop');
    expect(requested()?.source).toEqual({ kind: 'branch', baseRef: 'refs/heads/develop', headRef: 'feature' });
    expect(await open('main', localOnly)).toEqual({ ok: true });
    expect(chosenBase()).toBe('refs/heads/main');
  });

  test('without a bound remote an explicit remote ref fails instead of matching a local branch named like it', async () => {
    const unbound = reader({ ...repository, branches: ['feature', 'origin/main'], remoteNames: new Set(), primaryRemote: null });
    expect(await open('refs/remotes/origin/main', unbound)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(chosenBase()).toBeNull();
    expect(await open('origin/main', unbound)).toEqual({ ok: true });
    expect(chosenBase()).toBe('refs/heads/origin/main');
  });

  test('an explicit remote ref resolves only to that remote ref, never to another one named like it', async () => {
    const doubled = reader({ ...repository, branches: ['feature', 'origin/main', 'remotes/origin/main', 'remotes/origin/origin/main'] });
    expect(await open('refs/remotes/origin/main', doubled)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(chosenBase()).toBeNull();
  });

  test('a repository selection changed during the read keeps the user\'s choice and fails', async () => {
    for (const autoSelected of [false, true]) {
      useGitStore.setState({ nestedRepoSelection: new Map(), autoNestedRepoSelections: new Set() });
      const switching = async () => {
        useGitStore.getState().selectNestedRepo('/repo', '/repo/other');
        return { ...repository, directory: '/repo/sub', autoSelected };
      };
      expect(await open('develop', switching)).toMatchObject({ ok: false, code: 'HOST_UNAVAILABLE' });
      expect(useGitStore.getState().nestedRepoSelection.get('/repo')).toBe('/repo/other');
      expect(chosenBase('/repo/sub')).toBeNull();
      expect(requested('/repo/sub')).toBeUndefined();
    }
  });

  test('a nested repository gets the base and the target, while the tab opens under the panel folder', async () => {
    expect(await open('develop', reader({ ...repository, directory: '/repo/sub' }))).toEqual({ ok: true });
    expect(chosenBase('/repo/sub')).toBe('refs/heads/develop');
    expect(requested('/repo/sub')?.source).toEqual({ kind: 'branch', baseRef: 'refs/heads/develop', headRef: 'feature' });
    expect(chosenBase()).toBeNull();
    expect(requested()).toBeUndefined();
    expect(walkthroughTabs('/repo').some((tab) => tab.targetDirectory === null)).toBe(true);
    expect(useGitStore.getState().nestedRepoSelection.get('/repo')).toBeUndefined();
  });

  test('the repository the view would auto-select becomes that guess only once the call succeeds', async () => {
    const guessed = reader({ ...repository, directory: '/repo/sub', autoSelected: true });
    expect(await open('nope', guessed)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(useGitStore.getState().nestedRepoSelection.get('/repo')).toBeUndefined();
    expect(await open('develop', guessed)).toEqual({ ok: true });
    expect(useGitStore.getState().nestedRepoSelection.get('/repo')).toBe('/repo/sub');
    expect(useGitStore.getState().autoNestedRepoSelections.has('/repo')).toBe(true);
  });

  test('refuses before reading where it cannot open, and says why when the repository cannot answer', async () => {
    const reads: string[] = [];
    const read = reader(repository, reads);
    expect(await openGuestWalkthrough({ base: 'main', directory: '/repo', readRepository: read, supported: false })).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
    expect(await openGuestWalkthrough({ base: 'main', directory: null, readRepository: read, supported: true })).toMatchObject({ ok: false, code: 'NO_DIRECTORY' });
    expect(await open('main', null)).toMatchObject({ ok: false, code: 'HOST_UNAVAILABLE' });
    expect(reads).toEqual([]);
    expect(await open('main', reader(new Error('offline')))).toMatchObject({ ok: false, code: 'HOST_UNAVAILABLE' });
    expect(await open('main', reader(null))).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await open('main', reader({ ...repository, branch: null }))).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(chosenBase()).toBeNull();
    expect(requested()).toBeUndefined();
  });
});

describe('readWalkthroughRepository', () => {
  afterEach(() => {
    useGitStore.setState({ directories: new Map(), nestedRepoSelection: new Map(), autoNestedRepoSelections: new Set(), nestedReposByRoot: new Map() });
  });

  test('reads the repository the view shows: the selected nested one, else the root', async () => {
    const git = fakeGit({
      repositories: { '/repo': true, '/repo/sub': true },
      status: { '/repo': status('main'), '/repo/sub': status('feature') },
      branches: { '/repo': ['main'], '/repo/sub': ['feature', 'develop'] },
    });
    expect(await readWalkthroughRepository(git, sourceControl, '/repo')).toMatchObject({ directory: '/repo', autoSelected: false, branch: 'main' });
    useGitStore.getState().selectNestedRepo('/repo', '/repo/sub');
    expect(await readWalkthroughRepository(git, sourceControl, '/repo'))
      .toMatchObject({ directory: '/repo/sub', autoSelected: false, branch: 'feature', branches: ['feature', 'develop'] });
  });

  test('under a folder that is no repository it reads the repository the view would auto-select', async () => {
    useGitStore.setState({ nestedReposByRoot: new Map([['/work', ['/work/.tools', '/work/app']]]) });
    const git = fakeGit({ repositories: { '/work/app': true }, status: { '/work/app': status('feature') }, branches: { '/work/app': ['feature', 'main'] } });
    expect(await readWalkthroughRepository(git, sourceControl, '/work')).toMatchObject({ directory: '/work/app', autoSelected: true, branch: 'feature' });
    useGitStore.setState({ nestedReposByRoot: new Map([['/work', null]]) });
    await expect(readWalkthroughRepository(git, sourceControl, '/work')).rejects.toThrow();
  });

  test('a status read already in flight without throwOnError cannot answer for the reader', async () => {
    await readWalkthroughRepository(fakeGit({ repositories: { '/repo': true }, status: { '/repo': status('old') }, branches: { '/repo': ['old', 'main'] } }), sourceControl, '/repo');
    let rejectOwner: (error: Error) => void = () => {};
    let ownerAsked: () => void = () => {};
    const ownerAsking = new Promise<void>((resolve) => { ownerAsked = resolve; });
    let calls = 0;
    const failing = {
      ...fakeGit({ repositories: { '/repo': true }, status: {}, branches: { '/repo': ['new', 'main'] } }),
      getGitStatus: () => {
        calls += 1;
        if (calls > 1) return Promise.reject(new Error('offline'));
        ownerAsked();
        return new Promise<GitStatus>((_resolve, reject) => { rejectOwner = reject; });
      },
    };
    const owner = useGitStore.getState().fetchStatus('/repo', failing, { silent: true });
    await ownerAsking;
    const settled = readWalkthroughRepository(failing, sourceControl, '/repo').then(() => 'resolved', () => 'rejected');
    rejectOwner(new Error('offline'));
    await owner;
    expect(await settled).toBe('rejected');
    expect(useGitStore.getState().directories.get('/repo')?.status?.current).toBe('old');
  });

  test('a status read that fails is a failure, not the cached branch, and the cache stays', async () => {
    await readWalkthroughRepository(fakeGit({ repositories: { '/repo': true }, status: { '/repo': status('old') }, branches: { '/repo': ['old', 'main'] } }), sourceControl, '/repo');
    const cached = useGitStore.getState().directories.get('/repo');
    if (cached) useGitStore.setState({ directories: new Map([['/repo', { ...cached, lastStatusFetch: 0, lastBranchesFetch: 0 }]]) });
    const failing = fakeGit({ repositories: { '/repo': true }, status: { '/repo': new Error('offline') }, branches: { '/repo': ['new', 'main'] } });
    await expect(readWalkthroughRepository(failing, sourceControl, '/repo')).rejects.toThrow('offline');
    expect(useGitStore.getState().directories.get('/repo')?.status?.current).toBe('old');
  });

  test('a worktree still being created is unavailable, never its cached branch', async () => {
    await readWalkthroughRepository(fakeGit({ repositories: { '/repo': true }, status: { '/repo': status('old') }, branches: { '/repo': ['old', 'main'] } }), sourceControl, '/repo');
    const reads: string[] = [];
    const git = fakeGit({ repositories: { '/repo': true }, status: { '/repo': status('new') }, branches: { '/repo': ['new', 'main'] } });
    markWorktreeBootstrapPending('/repo');
    try {
      await expect(readWalkthroughRepository({ ...git, getGitStatus: async (directory: string) => { reads.push(directory); return status('new'); } }, sourceControl, '/repo'))
        .rejects.toThrow();
    } finally {
      clearWorktreeBootstrapState('/repo');
    }
    expect(reads).toEqual([]);
    expect(useGitStore.getState().directories.get('/repo')?.status?.current).toBe('old');
  });

  test('a forced read the store drops for a newer one does not leave the reader on the cached branch', async () => {
    await readWalkthroughRepository(fakeGit({ repositories: { '/repo': true }, status: { '/repo': fullStatus('old') }, branches: { '/repo': ['old', 'main'] } }), sourceControl, '/repo');
    let answerReader: (value: GitStatus) => void = () => {};
    let readerAsked: () => void = () => {};
    const readerAsking = new Promise<void>((resolve) => { readerAsked = resolve; });
    const answers: Array<() => Promise<GitStatus>> = [
      () => {
        readerAsked();
        return new Promise<GitStatus>((resolve) => { answerReader = resolve; });
      },
      async () => fullStatus('old'),
      async () => fullStatus('new'),
    ];
    const git = {
      ...fakeGit({ repositories: { '/repo': true }, status: {}, branches: { '/repo': ['new', 'old', 'main'] } }),
      getGitStatus: () => (answers.shift() ?? (async () => { throw new Error('unexpected read'); }))(),
    };
    const reading = readWalkthroughRepository(git, sourceControl, '/repo');
    await readerAsking;
    await useGitStore.getState().fetchStatus('/repo', git, { force: true, silent: true });
    answerReader(fullStatus('new'));
    expect(await reading).toMatchObject({ directory: '/repo', branch: 'new' });
    expect(useGitStore.getState().directories.get('/repo')?.status?.current).toBe('old');
  });

  test('a failed binding read is a failure, not a repository without remotes', async () => {
    const git = fakeGit({ repositories: { '/unbound': true }, status: { '/unbound': status('feature') }, branches: { '/unbound': ['feature', 'main'] } });
    const failing = { repositoryBinding: async () => { throw new Error('offline'); } };
    await expect(readWalkthroughRepository(git, failing, '/unbound')).rejects.toThrow('offline');
  });

  test('a detached HEAD has no branch to compare', async () => {
    const git = fakeGit({ repositories: { '/repo': true }, status: { '/repo': status('HEAD') }, branches: { '/repo': ['main'] } });
    expect(await readWalkthroughRepository(git, sourceControl, '/repo')).toMatchObject({ directory: '/repo', branch: null });
  });
});
