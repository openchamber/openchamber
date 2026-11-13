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
  bindingRevision: 4, directory: '/repo', primaryRemote: 'origin',
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

test('a pull request walkthrough on a host without change-request diffs says so and offers no generation', async () => {
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
    if (url.pathname === '/api/git/projects') return Response.json({ projects: [{ directory: '/repo', isGitRepository: true, status: STATUS }] });
    if (url.pathname === '/api/source-control/github/pulls/list') {
      return Response.json({ items: [PR], page: 1, hasMore: false } satisfies PageResult<ChangeRequest>);
    }
    // As the server refuses a host without the diff read.
    if (url.pathname.startsWith('/api/walkthrough/')) {
      return Response.json({ error: 'This source control provider does not offer change request walkthroughs', code: 'UNSUPPORTED_WALKTHROUGH_PROVIDER' }, { status: 422 });
    }
    // Git, status and the rest stay unanswered: the pull request scope does not wait on them.
    return new Promise<Response>(() => {});
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { OpenCode } = await import('@opencode/client');
  const { SyncProvider } = await import('@/sync/sync-context');
  // OpenCode stays unanswered: the walkthrough's pull request scope does not need it.
  const sdk = OpenCode.make({ baseUrl: 'http://walkthrough.test', fetch: () => new Promise<Response>(() => undefined) });
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  useSourceControlAuthStore.setState({
    entries: { [getSourceControlAuthKey(CONTEXT)]: { status: CONNECTED, isLoading: false, hasChecked: true } },
  });
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const github = githubLikeDescriptor();
  const descriptor = { ...github, features: { ...github.features, changeRequestPatch: false } };
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
  // Opened on a pull request, as the board and the Changes view hand one over.
  const { useWalkthroughStore } = await import('@/stores/useWalkthroughStore');
  useWalkthroughStore.getState().requestTarget('/repo', {
    source: { kind: 'pr', number: 17, sourceRepo: { owner: 'team', repo: 'project' } }, context: CONTEXT,
  });
  const { WalkthroughView } = await import('./WalkthroughView');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<SyncProvider sdk={sdk} directory="/repo"><I18nProvider><RuntimeAPIContext.Provider value={createWebAPIs()}>
        <WalkthroughView directory="/repo" />
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    // The repository check is batched on a timer; let it and the reads after it land.
    for (let round = 0; round < 4; round += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(container.textContent).toContain("GitHub doesn't serve pull request diffs");
    expect(container.textContent).not.toContain('No walkthrough yet');
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).not.toContain('Generate walkthrough');
    // Neither the walkthrough nor its diff is asked of the host.
    expect(paths.filter((path) => path.startsWith('/api/walkthrough/'))).toEqual([]);
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
