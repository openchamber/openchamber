import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { Window } from 'happy-dom';
import type { GitStatus } from '@/lib/api/types';
import type {
  ChangeRequest, PageResult, Project, SourceControlAuthStatus, SourceControlIdentity, SourceControlReadContext, SourceControlUser,
} from '@/lib/source-control/types';

// Bun does not implement Vite's worker URL imports.
plugin({ name: 'review-stepping-worker-url', setup(build) {
  build.onLoad({ filter: /\?worker&url$/ }, () => ({
    contents: `export default ${JSON.stringify(import.meta.resolve('@pierre/diffs/worker/worker.js'))};`,
    loader: 'js',
  }));
} });

const DIRECTORY = '/repo-stepping';
const endpoint = { displayUrl: 'https://github.com/team/project', fingerprint: 'fetch' };
const repository = { repositoryId: 'repo-1', configRevision: 'config', bare: false, remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }] };
const BINDING = {
  status: 'bound', repository: { supported: true, ...repository }, revision: 4,
  binding: { repositoryId: 'repo-1', configRevision: 'config', revision: 4, state: 'bound',
    providers: [{ provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin', readiness: 'ready', endpoint }],
    remotes: [], auxiliary: [] },
};
const CONTEXT: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', accountId: 'github.com#7', repositoryId: 'repo-1',
  bindingRevision: 4, directory: DIRECTORY, primaryRemote: 'origin',
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
  url: 'https://github.com/team/project/pull/17', state: 'open', draft: false, base: 'main', head: 'feature-17', headSha: 'head-17',
};
const STATUS: GitStatus = { current: 'feature-17', tracking: null, ahead: 0, behind: 0, files: [], isClean: true };
const FILES = ['src/first.ts', 'src/second.ts'];
const PATCH = FILES.map((path) => [
  `diff --git a/${path} b/${path}`,
  'index 1111111..2222222 100644',
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1,3 +1,3 @@',
  ' line 1',
  '-old line 2',
  '+new line 2',
  ' line 3',
  '',
].join('\n')).join('');

test('Alt+Down in the narrow review accordion expands an offscreen file and brings it into view', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, Document: dom.Document, HTMLDivElement: dom.HTMLDivElement, DocumentFragment: dom.DocumentFragment,
    ShadowRoot: dom.ShadowRoot, HTMLTemplateElement: dom.HTMLTemplateElement, HTMLStyleElement: dom.HTMLStyleElement, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    sessionStorage: dom.sessionStorage, Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
    Node: dom.Node, Text: dom.Text, SVGElement: dom.SVGElement, customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    DOMRect: dom.DOMRect, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  // Pierre's viewer reaches for many DOM classes; take every element and event class the window has.
  const domClasses = Object.fromEntries(Object.getOwnPropertyNames(dom)
    .filter((name) => /^(?:HTML\w*|SVG\w*)Element$|^\w*Event$|^(?:Document|DocumentFragment|ShadowRoot|Range|Selection|Text|Comment|NodeFilter|DOMParser)$/.test(name))
    .map((name) => [name, Object.getOwnPropertyDescriptor(dom, name)?.value]));
  for (const [name, value] of Object.entries({ ...domClasses, ...globals })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    switch (url.pathname) {
      case '/api/source-control/binding': return Response.json(BINDING);
      case '/api/git/status': return Response.json(STATUS);
      case '/api/git/check': return Response.json(true);
      case '/api/git/projects': return Response.json({ projects: [{ directory: DIRECTORY, isGitRepository: true, status: STATUS }] });
      case '/api/source-control/github/pr/status': return Response.json({ identity: IDENTITY, project: PROJECT, branch: 'feature-17', changeRequest: PR });
      case '/api/source-control/github/pulls/list':
        return Response.json({ items: [PR], page: 1, hasMore: false } satisfies PageResult<ChangeRequest>);
      case '/api/walkthrough/pr-diff':
        return new Response(PATCH, { headers: { 'content-type': 'text/plain' } });
      default: return new Promise<Response>(() => {});
    }
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { OpenCode } = await import('@opencode/client');
  const { SyncProvider } = await import('@/sync/sync-context');
  const sdk = OpenCode.make({ baseUrl: 'http://review-stepping.test', fetch: () => new Promise<Response>(() => undefined) });
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  useSourceControlAuthStore.setState({
    entries: { [getSourceControlAuthKey(CONTEXT)]: { status: CONNECTED, isLoading: false, hasChecked: true } },
  });
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const github = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [github], byId: new Map([[github.id, github]]), status: 'ready', holdsList: true });
  const { useGitStore } = await import('@/stores/useGitStore');
  useGitStore.getState().setActiveDirectory(DIRECTORY);
  useGitStore.getState().restoreStatus(DIRECTORY, STATUS);
  const { getEffectiveShortcutCombo, ShortcutDispatcher, shortcutRegistry } = await import('@/lib/shortcuts');
  const { UnifiedReviewScopeView } = await import('./UnifiedReviewScopeView');
  // The app's own dispatch: the shortcut reaches the panel after the panel's capture listeners.
  const dispatcher = new ShortcutDispatcher({ registry: shortcutRegistry, getBinding: (id) => getEffectiveShortcutCombo(id) });
  const dispatch = (event: KeyboardEvent) => { if (dispatcher.dispatch(event)) event.preventDefault(); };
  window.addEventListener('keydown', dispatch);

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const frame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
  // Wait on the outcome itself, bounded by time rather than a frame count, so a loaded machine only waits longer.
  const until = async (reached: () => boolean) => {
    const deadline = performance.now() + 20_000;
    while (!reached() && performance.now() < deadline) await frame();
  };
  try {
    const noop = () => {};
    await act(async () => {
      root.render(<SyncProvider sdk={sdk} directory={DIRECTORY}><I18nProvider><RuntimeAPIContext.Provider value={createWebAPIs()}>
        <UnifiedReviewScopeView
          visible isWide={false} rootDirectory={DIRECTORY} effectiveDirectory={DIRECTORY} activeDiffScope="pr"
          onScopeChange={noop} totalWorkingFileCount={0} onCopyCommitHash={noop} onCommitConflict={noop}
          onCommitActionSuccess={noop} rootIsGitRepo nestedRepos={undefined}
        />
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    const listed = () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('PR 17'));
    await until(() => listed() !== undefined);
    await act(async () => listed()?.click());
    const row = (path: string) => container.querySelector<HTMLElement>(`[data-stacked-diff-path="${path}"]`);
    await until(() => FILES.every((path) => row(path) !== null));
    const scroller = container.querySelector<HTMLElement>('[data-diff-virtual-root]');
    const second = row(FILES[1]);
    if (!scroller || !second) throw new Error('the review accordion did not render its files');
    // happy-dom has no layout: the panel is 600px tall and the second file starts 2000px down.
    scroller.style.overflowY = 'auto';
    scroller.getBoundingClientRect = () => new DOMRect(0, 100, 400, 600);
    row(FILES[0])!.getBoundingClientRect = () => new DOMRect(0, 100 - scroller.scrollTop, 400, 2000);
    second.getBoundingClientRect = () => new DOMRect(0, 2100 - scroller.scrollTop, 400, 300);
    const isExpanded = (path: string) => row(path)?.querySelector('[aria-expanded="true"]') != null;
    const altDown = () => act(async () => {
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    });

    await altDown();
    await until(() => isExpanded(FILES[0]));
    expect(scroller.scrollTop).toBe(0);
    expect(isExpanded(FILES[1])).toBe(false);

    await altDown();
    await until(() => isExpanded(FILES[1]));
    expect(isExpanded(FILES[1])).toBe(true);
    expect(second.getBoundingClientRect().top).toBe(scroller.getBoundingClientRect().top);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    window.removeEventListener('keydown', dispatch);
    await dom.happyDOM.abort();
    for (const [name, value] of originals) {
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);
