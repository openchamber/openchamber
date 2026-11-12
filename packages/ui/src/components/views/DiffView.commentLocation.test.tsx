import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitStatus } from '@/lib/api/types';
import type {
  ChangeRequest, PageResult, Project, SourceControlAuthStatus, SourceControlIdentity, SourceControlReadContext, SourceControlUser,
} from '@/lib/source-control/types';

const endpoint = { displayUrl: 'https://github.com/team/project', fingerprint: 'fetch' };
const repository = { repositoryId: 'repo-1', configRevision: 'config', bare: false, remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }] };
const BINDING = {
  repository, revision: 4,
  binding: { repositoryId: 'repo-1', configRevision: 'config', revision: 4, state: 'bound',
    providers: [{ provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin', readiness: 'ready', endpoint }],
    remotes: [], auxiliary: [] },
};
const CONTEXT: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', accountId: 'github.com#7', repositoryId: 'repo-1',
  bindingRevision: 4, directory: '/repo-comment', primaryRemote: 'origin',
};
const USER: SourceControlUser = { provider: 'github', instance: 'github.com', id: '7', username: 'octocat' };
const CONNECTED: SourceControlAuthStatus = {
  provider: 'github', instance: 'github.com', status: 'connected', connected: true, user: USER,
  accounts: [{
    id: CONTEXT.accountId, credentialId: CONTEXT.accountId, credentialRevision: 1, providerUserId: 'github.com#7',
    providerUserStatus: 'available', user: USER, current: true, source: 'oauth', status: 'valid',
  }],
};
const IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };
const PROJECT: Project = { ...IDENTITY, id: 'team/project', owner: 'team', name: 'project', url: 'https://github.com/team/project' };
const PR: ChangeRequest = {
  ...IDENTITY, id: 'team/project#17', number: 17, project: PROJECT, title: 'PR 17',
  url: 'https://github.com/team/project/pull/17', state: 'open', draft: false, base: 'main', head: 'feature-17',
};
const STATUS: GitStatus = { current: 'feature-17', tracking: null, ahead: 0, behind: 0, files: [], isClean: true };

// A comment written on a pull request names lines of the published diff. The
// Changes view opens that file in that comparison and brings the file into
// view, never the file on disk.
test('a comment location reopens the pull request diff on its file', async () => {
  const dom = new Window({ url: 'http://localhost' });
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
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    paths.push(url.pathname);
    if (url.pathname === '/api/source-control/binding') return Response.json(BINDING);
    if (url.pathname === '/api/git/status') return Response.json(STATUS);
    if (url.pathname === '/api/git/projects') return Response.json({ projects: [{ directory: '/repo-comment', isGitRepository: true, status: STATUS }] });
    if (url.pathname === '/api/source-control/github/pulls/list') {
      return Response.json({ items: [PR], page: 1, hasMore: false } satisfies PageResult<ChangeRequest>);
    }
    if (url.pathname === '/api/walkthrough/pr-diff') {
      return new Response(
        'diff --git a/published.png b/published.png\nindex 1111111..2222222 100644\nBinary files a/published.png and b/published.png differ\n',
        { headers: { 'content-type': 'text/plain' } },
      );
    }
    // Git, status and the rest stay unanswered: the pull request scope does not wait on them.
    return new Promise<Response>(() => {});
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { OpenCode } = await import('@opencode/client');
  const { SyncProvider } = await import('@/sync/sync-context');
  const sdk = OpenCode.make({ baseUrl: 'http://walkthrough.test', fetch: () => new Promise<Response>(() => undefined) });
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  useSourceControlAuthStore.setState({
    entries: { [getSourceControlAuthKey(CONTEXT)]: { status: CONNECTED, isLoading: false, hasChecked: true } },
  });
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const github = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [github], byId: new Map([[github.id, github]]), status: 'ready', holdsList: true });
  const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { DiffView } = await import('./DiffView');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<SyncProvider sdk={sdk} directory="/repo-comment"><I18nProvider><RuntimeAPIContext.Provider value={createWebAPIs()}>
        <DiffView directory="/repo-comment" diffScope="pr" />
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    const settle = async () => {
      for (let round = 0; round < 4; round += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    };
    await settle();
    // Changes is open on the pull request scope when the comment asks for its
    // place, as the panel already open beside the chat is.
    await act(async () => {
      usePullRequestSelectionStore.getState().requestDiff('/repo-comment', { kind: 'pr', number: 17, sourceRepo: { owner: 'team', repo: 'project' } });
    });
    await settle();
    expect(paths.join(' ')).toContain('/api/walkthrough/pr-diff');
    // The comparison lists the file, but its entry stays collapsed until asked.
    expect(container.textContent).toContain('published.png');
    expect(container.textContent).not.toContain('Content of this file cannot be viewed.');

    await act(async () => {
      useUIStore.getState().setPendingCommentLocation({
        directory: '/repo-comment', filePath: 'published.png', line: 1, side: 'additions',
        origin: { kind: 'change-request', provider: 'github', number: 17, repository: 'team/project' },
      });
    });
    await settle();

    expect(container.textContent).toContain('Content of this file cannot be viewed.');
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
