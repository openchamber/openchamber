import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import type { GitLogEntry, GitStatus } from '@/lib/api/types';
import type {
  ChangeRequest, ChangeRequestStatus, PageResult, Project, SourceControlAuthStatus, SourceControlIdentity, SourceControlUser,
} from '@/lib/source-control/types';

const ACCOUNT_ID = 'github.com#7';
const ENDPOINT = { displayUrl: 'https://github.com/fork/project', fingerprint: 'origin-fetch' };
const USER: SourceControlUser = { provider: 'github', instance: 'github.com', id: '7', username: 'octocat' };
const CONNECTED: SourceControlAuthStatus = {
  provider: 'github', instance: 'github.com', status: 'connected', connected: true, user: USER,
  accounts: [{
    id: ACCOUNT_ID, credentialId: ACCOUNT_ID, credentialRevision: 1, providerUserId: 'github.com#7',
    providerUserStatus: 'available', user: USER, current: true, source: 'oauth', status: 'valid',
  }],
};
const GITHUB: SourceControlIdentity = { provider: 'github', instance: 'github.com' };
const UPSTREAM: Project = { ...GITHUB, id: 'upstream/project', owner: 'upstream', name: 'project', url: 'https://github.com/upstream/project' };
const PUBLISHED_PR: ChangeRequest = {
  ...GITHUB, id: 'upstream/project#42', number: 42, project: UPSTREAM, title: 'Published PR',
  url: 'https://github.com/upstream/project/pull/42', state: 'open', draft: false, head: 'feature', base: 'main',
};
const SYNC_SDK = OpenCode.make({
  baseUrl: 'http://opencode.test',
  fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
});

// A review comment on a pull request names lines of the published diff, which
// the checkout need not have. Changes opens that diff on the file, not the file
// on disk.
test("the phone's Changes surface opens the comparison a comment was written on", async () => {
  const dom = new Window({ url: 'http://localhost' });
  dom.happyDOM.setWindowSize({ width: 390, height: 844 });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const commits: GitLogEntry[] = [{
    hash: 'a'.repeat(40), date: '2026-09-09T09:22:00Z', message: 'Commit a',
    refs: '', body: '', author_name: 'Test Author', author_email: 'test@example.com',
    filesChanged: 1, insertions: 0, deletions: 0, parents: [],
  }];
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    requests.push(url);
    switch (url.pathname) {
      case '/api/git/status': return Response.json({
        current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true,
      } satisfies GitStatus);
      case '/api/git/remotes': return Response.json([]);
      case '/api/git/identities': return Response.json([]);
      case '/api/git/global-identity': return Response.json(null);
      case '/api/git/branch-base': return Response.json({ base: null });
      case '/api/git/log': return Response.json({ all: commits, latest: commits[0], total: commits.length });
      case '/api/source-control/binding': return Response.json({
        status: 'bound', revision: 1,
        repository: { supported: true, repositoryId: 'repo', configRevision: 'rev', bare: false,
          remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }] },
        binding: { repositoryId: 'repo', configRevision: 'rev', revision: 1, state: 'bound',
          providers: [{ provider: 'github', instance: 'github.com', accountId: ACCOUNT_ID, primaryRemote: 'origin', readiness: 'ready', endpoint: ENDPOINT }],
          remotes: [], auxiliary: [] },
      });
      case '/api/source-control/github/pr/status': return Response.json({ identity: GITHUB, project: UPSTREAM,
        branch: url.searchParams.get('branch') ?? '', changeRequest: PUBLISHED_PR } satisfies ChangeRequestStatus);
      case '/api/source-control/github/pulls/list':
        return Response.json({ items: [PUBLISHED_PR], page: 1, hasMore: false } satisfies PageResult<ChangeRequest>);
      case '/api/walkthrough/pr-diff': return new Response(
        'diff --git a/published.png b/published.png\nindex 1111111..2222222 100644\nBinary files a/published.png and b/published.png differ\n',
        { headers: { 'content-type': 'text/plain' } },
      );
      default: return Response.json({});
    }
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  useSourceControlAuthStore.setState({
    entries: { [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: { status: CONNECTED, isLoading: false, hasChecked: true } },
  });
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const servedGitHub = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [servedGitHub], byId: new Map([[servedGitHub.id, servedGitHub]]), status: 'ready', holdsList: true });
  const { MobileChangesPane } = await import('./MobileChangesSurface');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
  const apis = createWebAPIs();

  useGitStore.getState().setActiveDirectory('/repo-comment');
  const previous = useGitStore.getState().getDirectoryState('/repo-comment');
  if (!previous) throw new Error('Missing repository state');
  const now = Date.now();
  const directories = new Map(useGitStore.getState().directories);
  directories.set('/repo-comment', {
    ...previous,
    status: { current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true },
    isGitRepo: true,
    branches: { all: ['feature', 'main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } },
    log: { all: commits, latest: commits[0], total: 1 },
    lastStatusFetch: now, lastBranchesFetch: now, lastLogFetch: now, lastIdentityFetch: now, lastRepoCheckAt: now,
  });
  useGitStore.setState({ directories });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<SyncProvider sdk={SYNC_SDK} directory="/repo-comment"><I18nProvider><RuntimeAPIContext.Provider value={apis}>
        <MobileChangesPane rootDirectory="/repo-comment"
          repository={{ rootIsGitRepo: true, gitDirectory: '/repo-comment', nestedRepos: null, nestedRepoSelection: null, repositoryOptions: null, repositoriesKnown: true, unreadable: null }} />
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    // The chat hands Changes a comment's place, as its context preview does:
    // the pull request, then the file and line.
    await act(async () => {
      usePullRequestSelectionStore.getState().requestDiff('/repo-comment', {
        kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' },
      });
      useUIStore.getState().setPendingCommentLocation({
        directory: '/repo-comment', filePath: 'published.png', line: 3, side: 'additions',
        origin: { kind: 'change-request', provider: 'github', number: 42, repository: 'upstream/project' },
      });
    });
    for (let round = 0; round < 4; round += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    }

    expect(useUIStore.getState().pendingCommentLocation).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('published.png');
    expect(container.textContent).toContain('Pull Requests · #42');
    const prRequest = requests.find((url) => url.pathname === '/api/walkthrough/pr-diff');
    expect(JSON.parse(prRequest?.searchParams.get('source') ?? '')).toEqual({
      kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' },
    });
    // The request is answered once; a later open starts where the person left off.
    expect(useUIStore.getState().pendingCommentLocation).toBeNull();
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, value] of originals) {
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);
