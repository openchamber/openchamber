import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { Window } from 'happy-dom';
import type { GitStatus } from '@/lib/api/types';
import type {
  ChangeRequest, PageResult, Project, SourceControlAuthStatus, SourceControlIdentity, SourceControlReadContext, SourceControlUser,
} from '@/lib/source-control/types';

// Bun does not implement Vite's worker URL imports.
plugin({ name: 'git-view-worker-url', setup(build) {
  build.onLoad({ filter: /\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
} });

const DIRECTORY = '/repo-comment';
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

// A comment written on a pull request names a line of the published diff. Its
// opener in the chat opens the git tab on that comparison, and the tab brings
// that line of the text diff into view: never the file on disk.
test("a pull request comment's opener brings the git tab's text diff to its line", async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, Document: dom.Document, HTMLDivElement: dom.HTMLDivElement, DocumentFragment: dom.DocumentFragment,
    ShadowRoot: dom.ShadowRoot, HTMLTemplateElement: dom.HTMLTemplateElement, HTMLStyleElement: dom.HTMLStyleElement, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    sessionStorage: dom.sessionStorage, Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
    Node: dom.Node, Text: dom.Text, SVGElement: dom.SVGElement, customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
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
  const scrolledTo: Array<{ line: string | null; type: string | null }> = [];
  dom.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolledTo.push({ line: this.getAttribute('data-line'), type: this.getAttribute('data-line-type') });
  };
  const patchSources: Array<{ revision?: string } | null> = [];
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
        patchSources.push(JSON.parse(url.searchParams.get('source') ?? 'null'));
        return new Response(PATCH, { headers: { 'content-type': 'text/plain' } });
      default: return new Promise<Response>(() => {});
    }
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { OpenCode } = await import('@opencode/client');
  const { SyncProvider } = await import('@/sync/sync-context');
  const sdk = OpenCode.make({ baseUrl: 'http://git-tab.test', fetch: () => new Promise<Response>(() => undefined) });
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
  const { useContextWindowStore } = await import('@/lib/contextWindow/store');
  useContextWindowStore.setState({ followedDirectory: DIRECTORY });
  const { useGitStore } = await import('@/stores/useGitStore');
  useGitStore.getState().setActiveDirectory(DIRECTORY);
  useGitStore.getState().restoreStatus(DIRECTORY, STATUS);
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useOpenCommentSource } = await import('@/components/comments/useOpenCommentSource');
  const { GitView } = await import('../GitView');
  const { getZoneView, resolveZoneActiveTab, zoneOfMode } = await import('@/lib/workspace/zones');

  const Opener = () => {
    const source = useOpenCommentSource(DIRECTORY);
    return (
      <button type="button" data-testid="open-comment" onClick={() => source.open({
        fileLabel: 'src/app.ts', startLine: 3, side: 'modified',
        // The head the comment was written at; GitHub serves only the current patch, so it identifies, never reads.
        origin: { kind: 'change-request', provider: 'github', number: 17, repository: 'team/project', revision: 'head-17' },
      })} />
    );
  };
  // The context pane shows the git tab active only while its zone is open on it: the opener must leave it so.
  const GitTab = () => {
    const panel = useUIStore((state) => state.contextPanelByDirectory[DIRECTORY]);
    const placement = useUIStore((state) => state.contextSurfaceZones);
    const tab = panel?.tabs.find((entry) => entry.mode === 'git');
    if (!panel || !tab) return null;
    const zone = zoneOfMode(placement, 'git');
    const isActive = getZoneView(panel, zone).isOpen && resolveZoneActiveTab(panel, placement, zone)?.id === tab.id;
    return <GitView isActive={isActive} diffScope={tab.diffScope ?? null} targetFilePath={tab.targetPath ?? null} />;
  };

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
    await act(async () => {
      root.render(<SyncProvider sdk={sdk} directory={DIRECTORY}><I18nProvider><RuntimeAPIContext.Provider value={createWebAPIs()}>
        <Opener />
        <GitTab />
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="open-comment"]')?.click());
    await until(() => scrolledTo.some((row) => row.line === '3'));

    expect(useUIStore.getState().pendingCommentLocation).toBeNull();
    expect(container.textContent).toContain('PR 17');
    expect(scrolledTo.some((row) => row.line === '3' && row.type === 'change-addition')).toBe(true);
    expect(patchSources.length).toBeGreaterThan(0);
    expect(patchSources.every((source) => !source?.revision)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    useContextWindowStore.setState({ followedDirectory: null });
    await dom.happyDOM.abort();
    for (const [name, value] of originals) {
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);
