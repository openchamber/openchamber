import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import type { GitLogEntry, GitStatus } from '@/lib/api/types';
import type {
  ChangeRequest, ChangeRequestStatus, PageResult, Project, SourceControlAuthStatus, SourceControlIdentity, SourceControlUser,
} from '@/lib/source-control/types';

// Bun does not implement Vite's worker URL imports.
plugin({ name: 'mobile-changes-worker-url', setup(build) {
  build.onLoad({ filter: /\?worker&url$/ }, () => ({
    contents: `export default ${JSON.stringify(import.meta.resolve('@pierre/diffs/worker/worker.js'))};`,
    loader: 'js',
  }));
} });

const DIRECTORY = '/repo-comment';
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
const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,5 +1,5 @@',
  ' line 1',
  ' line 2',
  '-old line 3',
  '+new line 3',
  ' line 4',
  ' line 5',
  '',
].join('\n');
const SYNC_SDK = OpenCode.make({
  baseUrl: 'http://opencode.test',
  fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
});

// A review comment on a pull request names a line of the published diff, which
// the checkout need not have. On the phone the comment's row in the composer
// shows its label as the opener: it opens that diff at the line, while a tap on
// the row itself still edits the comment.
test("the phone's composer label opens the comparison a comment was written on, at its line", async () => {
  const dom = new Window({ url: 'http://localhost' });
  dom.happyDOM.setWindowSize({ width: 390, height: 844 });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    sessionStorage: dom.sessionStorage, customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  // Pierre's viewer reaches for many DOM classes; take every element and event class the window has.
  const domClasses = Object.fromEntries(Object.getOwnPropertyNames(dom)
    .filter((name) => /^(?:HTML\w*|SVG\w*)Element$|^\w*Event$|^(?:Element|Node|Document|DocumentFragment|ShadowRoot|Range|Selection|Text|Comment|NodeFilter|DOMParser)$/.test(name))
    .map((name) => [name, Object.getOwnPropertyDescriptor(dom, name)?.value]));
  for (const [name, value] of Object.entries({ ...domClasses, ...globals })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const scrolledTo: Array<{ line: string | null; type: string | null }> = [];
  dom.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolledTo.push({ line: this.getAttribute('data-line'), type: this.getAttribute('data-line-type') });
  };
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
      case '/api/walkthrough/pr-diff': return new Response(PATCH, { headers: { 'content-type': 'text/plain' } });
      // The whole file stays unanswered: the commented line is in the patch already.
      case '/api/walkthrough/pr-file': return new Promise<Response>(() => {});
      default: return Response.json({});
    }
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
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
  const { DedicatedMobileAppProvider } = await import('./mobileAppContext');
  const { ComposerContextRows } = await import('@/components/chat/composer/ui/ComposerContextRows');
  const { MobileCommentComposerContext } = await import('@/components/chat/composer/comment/MobileCommentComposerContext');
  const { createMobileCommentDraftController } = await import('@/components/chat/composer/comment/mobileCommentDraft');
  const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  const apis = createWebAPIs();

  useGitStore.getState().setActiveDirectory(DIRECTORY);
  const previous = useGitStore.getState().getDirectoryState(DIRECTORY);
  if (!previous) throw new Error('Missing repository state');
  const now = Date.now();
  const directories = new Map(useGitStore.getState().directories);
  directories.set(DIRECTORY, {
    ...previous,
    status: { current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true },
    isGitRepo: true,
    branches: { all: ['feature', 'main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } },
    log: { all: commits, latest: commits[0], total: 1 },
    lastStatusFetch: now, lastBranchesFetch: now, lastLogFetch: now, lastIdentityFetch: now, lastRepoCheckAt: now,
  });
  useGitStore.setState({ directories });

  const target = { directory: DIRECTORY, sessionKey: 'ses_comment' };
  const draftId = useInlineCommentDraftStore.getState().addDraft(target, {
    source: 'diff', fileLabel: 'src/app.ts', startLine: 3, endLine: 3, side: 'modified', code: 'new line 3', language: 'typescript',
    text: 'Why this name?', origin: { kind: 'change-request', provider: 'github', number: 42, repository: 'upstream/project' },
  });
  const commentComposer = createMobileCommentDraftController();
  commentComposer.setScope({ runtimeKey: getRuntimeKey(), ...target });
  const mobileActions = {
    openChanges: () => undefined, openFiles: () => undefined, openSourceBoard: () => undefined,
    openPlan: () => undefined, openReceivedPage: () => undefined,
  };

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
  const until = async (reached: () => boolean) => {
    for (let round = 0; round < 200 && !reached(); round += 1) await frame();
  };
  try {
    await act(async () => {
      root.render(<SyncProvider sdk={SYNC_SDK} directory={DIRECTORY}><I18nProvider><RuntimeAPIContext.Provider value={apis}>
        <DedicatedMobileAppProvider actions={mobileActions}><MobileCommentComposerContext.Provider value={commentComposer}>
          <ComposerContextRows draftTarget={target} isMobile onOpenAttachment={() => undefined} surfaceActive />
          <MobileChangesPane rootDirectory={DIRECTORY}
            repository={{ rootIsGitRepo: true, gitDirectory: DIRECTORY, nestedRepos: null, nestedRepoSelection: null, repositoryOptions: null, repositoriesKnown: true, unreadable: null }} />
        </MobileCommentComposerContext.Provider></DedicatedMobileAppProvider>
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    await until(() => container.querySelector('[role="button"][aria-expanded="false"]') !== null);

    // The row itself edits the comment.
    await act(async () => container.querySelector<HTMLElement>('[role="button"][aria-expanded="false"]')?.click());
    const edit = commentComposer.getState();
    expect(edit.status === 'open' ? edit.draftId : null).toBe(draftId);
    expect(useUIStore.getState().pendingCommentLocation).toBeNull();

    // Its label opens the diff the comment was written on.
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open file diff"]')?.click());
    await until(() => scrolledTo.some((row) => row.line === '3'));

    expect(useUIStore.getState().pendingCommentLocation).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('app.ts');
    expect(container.textContent).toContain('Pull Requests · #42');
    const prRequest = requests.find((url) => url.pathname === '/api/walkthrough/pr-diff');
    expect(JSON.parse(prRequest?.searchParams.get('source') ?? '')).toEqual({
      kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' },
    });
    expect(scrolledTo.some((row) => row.line === '3' && row.type === 'change-addition')).toBe(true);
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
