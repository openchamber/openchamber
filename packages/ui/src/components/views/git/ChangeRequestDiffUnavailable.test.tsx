import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type {
  ChangeRequest, ChangeRequestStatus, PageResult, Project, SourceControlAuthStatus, SourceControlIdentity, SourceControlReadContext,
  SourceControlUser,
} from '@/lib/source-control/types';

// A host that lists and opens its pull requests but does not serve their diff.
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
const pullRequest = (number: number): ChangeRequest => ({
  ...IDENTITY, id: `team/project#${number}`, number, project: PROJECT, title: `PR ${number}`,
  url: `https://github.com/team/project/pull/${number}`, state: 'open', draft: false, base: 'main', head: `feature-${number}`,
});

const withDom = async (run: (dom: Window) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, MutationObserver: dom.MutationObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    await run(dom);
  } finally {
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

// The first render loads the web runtime and UI modules cold.
const TIMEOUT_MS = 30_000;

test('a host without change-request diffs says so in place of the diff, keeps its list, and offers no retry', () => withDom(async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    paths.push(url.pathname);
    if (url.pathname === '/api/source-control/github/pr/status') {
      const status: ChangeRequestStatus = { identity: IDENTITY, project: PROJECT, branch: 'feature-17', changeRequest: pullRequest(17) };
      return Response.json(status);
    }
    if (url.pathname === '/api/source-control/github/pulls/list') {
      return Response.json({ items: [pullRequest(17), pullRequest(18)], page: 1, hasMore: false } satisfies PageResult<ChangeRequest>);
    }
    return new Promise<Response>(() => {});
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { forgetSharedPullRequestLists, usePullRequestComparison } = await import('@/hooks/usePullRequestComparison');
  forgetSharedPullRequestLists();
  const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
  usePullRequestSelectionStore.setState({ selections: new Map() });
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  useSourceControlAuthStore.setState({
    entries: { [getSourceControlAuthKey(CONTEXT)]: { status: CONNECTED, isLoading: false, hasChecked: true } },
  });
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const serve = (changeRequestPatch: boolean) => {
    const github = githubLikeDescriptor();
    const descriptor = { ...github, features: { ...github.features, changeRequestPatch } };
    useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
  };
  const { ChangeRequestDiffUnavailable } = await import('./ChangeRequestDiffUnavailable');
  const apis = createWebAPIs();
  // The pull request scope as the Changes and Walkthrough views draw it.
  function Harness() {
    const comparison = usePullRequestComparison('/repo', 'feature-17', CONTEXT, true);
    return <section>
      <output data-count>{comparison.prs.length}</output>
      <output data-selected>{comparison.selectedSource?.number}</output>
      {comparison.diffUnavailable && <ChangeRequestDiffUnavailable provider={comparison.provider} />}
    </section>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  // Renders and lets the list read and the search debounce settle.
  const render = () => act(async () => {
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}><Harness /></RuntimeAPIContext.Provider></I18nProvider>);
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  try {
    await act(async () => serve(false));
    await render();
    expect(container.querySelector('[data-count]')?.textContent).toBe('2');
    expect(container.querySelector('[data-selected]')?.textContent).toBe('17');
    expect(container.textContent).toContain("GitHub doesn't serve pull request diffs");
    expect(container.querySelector('button')).toBeNull();
    // Nothing asks the host for a diff it does not serve.
    expect(paths.filter((path) => path.startsWith('/api/walkthrough/'))).toEqual([]);

    await act(async () => serve(true));
    await render();
    expect(container.textContent).not.toContain("doesn't serve");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
}), TIMEOUT_MS);

test('the note speaks the host\'s own change-request term', () => withDom(async () => {
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { gitlabLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const gitlab = gitlabLikeDescriptor();
  const descriptor = { ...gitlab, features: { ...gitlab.features, changeRequestPatch: false } };
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
  const { ChangeRequestDiffUnavailable } = await import('./ChangeRequestDiffUnavailable');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider><ChangeRequestDiffUnavailable provider="gitlab" /></I18nProvider>); });
    expect(container.textContent).toContain("GitLab doesn't serve merge request diffs");
  } finally {
    await act(async () => root.unmount());
  }
}), TIMEOUT_MS);
