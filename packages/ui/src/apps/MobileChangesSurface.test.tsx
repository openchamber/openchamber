import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { OpenCode, type FileDiffInfo } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { opencodeClient } from '@/lib/opencode/client';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { GitLogEntry, GitStatus } from '@/lib/api/types';
import type {
  ChangeRequest, ChangeRequestStatus, PageResult, Project, SourceControlAuthStatus, SourceControlIdentity, SourceControlUser,
} from '@/lib/source-control/types';

// Pull requests are read through the checkout's bound GitHub context, so the
// repository here is bound to an account the auth store knows as valid.
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

// The server emits neutral DTOs; the published pull request lives in the upstream project.
const GITHUB: SourceControlIdentity = { provider: 'github', instance: 'github.com' };
const UPSTREAM: Project = { ...GITHUB, id: 'upstream/project', owner: 'upstream', name: 'project', url: 'https://github.com/upstream/project' };
const PUBLISHED_PR: ChangeRequest = {
  ...GITHUB, id: 'upstream/project#42', number: 42, project: UPSTREAM, title: 'Published PR',
  url: 'https://github.com/upstream/project/pull/42', state: 'open', draft: false, head: 'feature', base: 'main',
};

// The Changes pane now reads session messages for the turn scope, so the surface
// must render under a sync runtime. This stub answers the bootstrap with an empty list.
const SYNC_SDK = OpenCode.make({
  baseUrl: 'http://opencode.test',
  fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
});

test('mobile comparisons drill into files, retry, resume, change source, and yield to external working diffs', async () => {
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
  const commits: GitLogEntry[] = ['a', 'b'].map((letter) => ({
    hash: letter.repeat(40), date: '2026-09-09T09:22:00Z', message: `Commit ${letter}`,
    refs: '', body: '', author_name: 'Test Author', author_email: 'test@example.com',
    filesChanged: 1, insertions: 0, deletions: 0, parents: [],
  }));
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  let failBranchDiff = true;
  let nestedIsRepository = true;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    requests.push(url);
    switch (url.pathname) {
      case '/api/git/remotes': return Response.json([]);
      // The identity strip beside the branch reads these on mount.
      case '/api/git/identities': return Response.json([]);
      case '/api/git/global-identity': return Response.json(null);
      case '/api/source-control/binding': return Response.json({
        status: 'bound', revision: 1,
        repository: { supported: true, repositoryId: 'repo', configRevision: 'rev', bare: false,
          remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }] },
        binding: { repositoryId: 'repo', configRevision: 'rev', revision: 1, state: 'bound',
          providers: [{ provider: 'github', instance: 'github.com', accountId: ACCOUNT_ID, primaryRemote: 'origin', readiness: 'ready', endpoint: ENDPOINT }],
          remotes: [], auxiliary: [] },
      });
      case '/api/git/branch-base': return Response.json({ base: null });
      case '/api/git/range-files': return Response.json({ files: [{ path: url.searchParams.get('base') === 'refs/heads/parent' ? 'parent.png' : 'branch.png', status: 'M' }] });
      case '/api/git/range-diff':
        return failBranchDiff
          ? Response.json({ error: 'Branch diff failed' }, { status: 500 })
          : Response.json({ diff: 'Binary files a/branch.png and b/branch.png differ' });
      case '/api/git/log': return Response.json({ all: commits, latest: commits[0], total: commits.length });
      case '/api/git/commit-files': return Response.json({ files: [{ path: `commit-${url.searchParams.get('hash')?.[0]}.png`, previousPath: 'old.png', changeType: 'R', insertions: 0, deletions: 0, isBinary: true }] });
      case '/api/git/commit-diff': return Response.json({ diff: 'Binary files a/old.png and b/commit.png differ' });
      case '/api/git/file-diff':
        if (url.searchParams.get('path') === 'nested/' && nestedIsRepository) {
          return Response.json({ error: 'Path is a separate Git repository: nested/', code: 'nested_repository' }, { status: 422 });
        }
        return Response.json({ path: url.searchParams.get('path'), original: '', modified: '', isBinary: true });
      // The bound status contract echoes the branch it answered for.
      case '/api/source-control/github/pr/status': return Response.json({ identity: GITHUB, project: UPSTREAM,
        branch: url.searchParams.get('branch') ?? '', changeRequest: PUBLISHED_PR } satisfies ChangeRequestStatus);
      case '/api/source-control/github/pulls/list':
        return Response.json({ items: [PUBLISHED_PR], page: 1, hasMore: false } satisfies PageResult<ChangeRequest>);
      case '/api/walkthrough/pr-diff': return new Response('diff --git a/published.png b/published.png\nindex 1111111..2222222 100644\nBinary files a/published.png and b/published.png differ\n', { headers: { 'content-type': 'text/plain' } });
      default: throw new Error(`Unexpected request ${url.pathname}`);
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
  // Change-request diffs exist only for providers the server serves.
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const servedGitHub = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [servedGitHub], byId: new Map([[servedGitHub.id, servedGitHub]]), status: 'ready', holdsList: true });
  const { MobileChangesPane } = await import('./MobileChangesSurface');
  const apis = createWebAPIs();
  const status: GitStatus = { current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true, diffStats: { staged: {}, working: {} } };
  const seed = (directory: string, nextStatus = status) => {
    useGitStore.getState().setActiveDirectory(directory);
    const previous = useGitStore.getState().getDirectoryState(directory);
    if (!previous) throw new Error('Missing repository state');
    const now = Date.now();
    const directories = new Map(useGitStore.getState().directories);
    directories.set(directory, {
      ...previous, status: nextStatus, isGitRepo: true,
      branches: { all: ['feature', 'main', 'parent', 'remotes/origin/main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } },
      log: { all: commits, latest: commits[0], total: 2 }, identity: { userName: 'Test Author', userEmail: 'test@example.com' },
      lastStatusFetch: now, lastBranchesFetch: now, lastLogFetch: now, lastIdentityFetch: now, lastRepoCheckAt: now,
    });
    useGitStore.setState({ directories });
  };
  seed('/repo');
  let directory = '/repo';
  let visible = true;
  let initialDiff: { path: string; staged: boolean } | null = null;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () => act(async () => {
    root.render(<SyncProvider sdk={SYNC_SDK} directory={directory}><I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <MobileChangesPane rootDirectory={directory}
        repository={{ rootIsGitRepo: true, gitDirectory: directory, nestedRepos: null, nestedRepoSelection: null, repositoryOptions: null }}
        visible={visible} initialDiff={initialDiff} />
    </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
  });
  const click = async (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    await act(async () => { element.click(); });
  };
  const chooseMode = async (label: string) => {
    await click('[aria-label="Select change mode"]');
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((element) => element.textContent === label);
    if (!option) throw new Error(`Missing mode ${label}`);
    await act(async () => { option.click(); });
  };
  const openFile = async (path: string) => {
    const button = container.querySelector(`[title="${path}"]`)?.closest('button');
    if (!button) throw new Error(`Missing file ${path}`);
    await act(async () => { button.click(); });
  };
  const comparisonRequests = () => requests.filter((url) => /\/(range-files|range-diff|commit-files|commit-diff)$/.test(url.pathname));
  const checkoutControl = () => [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'feature');

  try {
    await render();
    const modeTrigger = container.querySelector('[aria-label="Select change mode"]');
    const syncButton = container.querySelector('[aria-label="Publish"]');
    if (!modeTrigger || !syncButton) throw new Error('Missing Changes controls');
    expect(modeTrigger?.textContent).toBe('Changes');
    expect(container.querySelector('h2')).toBeNull();
    expect(checkoutControl()).toBeDefined();
    expect(syncButton).not.toBeNull();
    expect(modeTrigger?.closest('header')?.contains(syncButton)).toBe(false);
    expect(modeTrigger && syncButton && (modeTrigger.compareDocumentPosition(syncButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await chooseMode('Branch');
    expect(container.querySelector('[aria-label="Sync Changes"]')).toBeNull();
    expect(checkoutControl()).toBeUndefined();
    // With nothing chosen, the base is detected: the reflog has no answer
    // here, so the open pull request's base or the default branch names the
    // bound remote's copy.
    expect(container.querySelector('[aria-label="Base branch"]')?.textContent).toContain('origin/main');
    expect(requests.some((url) => url.pathname === '/api/git/range-files' && url.searchParams.get('base') === 'origin/main')).toBe(true);
    await click('[aria-label="Base branch"]');
    await click('[data-value="refs/heads/main"]');
    expect(container.querySelector('[title="branch.png"]')).not.toBeNull();
    await openFile('branch.png');
    expect(container.textContent).toContain('Branch diff failed');
    expect(requests.filter((url) => url.pathname === '/api/git/file-diff')).toHaveLength(0);
    failBranchDiff = false;
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    if (!retry) throw new Error('Missing diff retry');
    await act(async () => { retry.click(); });
    expect(container.textContent).toContain('Content of this file cannot be viewed.');
    expect(container.textContent).toContain('Branch · main');

    const beforeHide = comparisonRequests().length;
    visible = false;
    await render();
    await act(async () => { seed('/repo'); });
    expect(comparisonRequests()).toHaveLength(beforeHide);
    visible = true;
    await render();
    expect(container.querySelector('h2')?.textContent).toBe('branch.png');
    await click('[aria-label="Back"]');
    await click('[aria-label="Base branch"]');
    await click('[data-value="refs/heads/parent"]');
    expect(container.querySelector('[title="branch.png"]')).toBeNull();
    expect(container.querySelector('[title="parent.png"]')).not.toBeNull();

    await chooseMode('Commit');
    expect(container.querySelector('[aria-label="Sync Changes"]')).toBeNull();
    expect(checkoutControl()).toBeUndefined();
    expect(container.querySelector('[title="commit-a.png"]')).not.toBeNull();
    await click('[aria-label="Select commit"]');
    await click(`[data-value="${'b'.repeat(40)}"]`);
    expect(container.querySelector('[title="commit-a.png"]')).toBeNull();
    await openFile('commit-b.png');
    expect(container.textContent).toContain('Commit · bbbbbbbb');
    const commitRequest = [...requests].reverse().find((url) => url.pathname === '/api/git/commit-diff');
    expect(commitRequest?.searchParams.get('hash')).toBe('b'.repeat(40));
    expect(commitRequest?.searchParams.get('previousPath')).toBe('old.png');
    expect(requests.filter((url) => url.pathname === '/api/git/range-diff').every((url) => url.searchParams.get('includeWorkingTree') === 'true')).toBe(true);

    await click('[aria-label="Back"]');
    await chooseMode('Pull Requests');
    expect(container.querySelector('[aria-label="Sync Changes"]')).toBeNull();
    expect(container.querySelector('[title="published.png"]')).not.toBeNull();
    await openFile('published.png');
    expect(container.textContent).toContain('Pull Requests · #42');
    expect(container.textContent).toContain('Content of this file cannot be viewed.');
    const prRequest = requests.find((url) => url.pathname === '/api/walkthrough/pr-diff');
    expect(JSON.parse(prRequest?.searchParams.get('source') ?? '')).toEqual({ kind: 'pr', number: 42, sourceRepo: { owner: 'upstream', repo: 'project' } });
    expect(prRequest?.searchParams.get('accountId')).toBe(ACCOUNT_ID);
    expect(prRequest?.searchParams.get('repositoryId')).toBe('repo');
    expect(requests.filter((url) => url.pathname === '/api/git/file-diff')).toHaveLength(0);

    await act(async () => { seed('/repo', { ...status, isClean: false, files: [{ path: 'working.png', index: 'M', working_dir: ' ' }] }); });
    initialDiff = { path: 'working.png', staged: true };
    await render();
    expect(container.querySelector('h2')?.textContent).toBe('working.png');
    const workingRequest = [...requests].reverse().find((url) => url.pathname === '/api/git/file-diff');
    expect(workingRequest?.searchParams.get('staged')).toBe('true');
    await click('[aria-label="Back"]');
    expect(container.querySelector('[aria-label="Select change mode"]')?.textContent).toBe('Changes');
    expect(container.querySelector('[aria-label="Publish"]')).not.toBeNull();
    expect(checkoutControl()).toBeDefined();

    // A nested-repository answer must not outlive the read that produced it.
    await act(async () => { seed('/repo', { ...status, isClean: false, files: [{ path: 'nested/', index: '?', working_dir: '?' }] }); });
    initialDiff = { path: 'nested/', staged: false };
    await render();
    expect(container.textContent).toContain('Separate Git repository');
    await click('[aria-label="Back"]');
    nestedIsRepository = false;
    initialDiff = { path: 'nested/', staged: false };
    await render();
    expect(container.querySelector('h2')?.textContent).toBe('nested/');
    expect(container.textContent).not.toContain('Separate Git repository');
    expect(container.textContent).toContain('Content of this file cannot be viewed.');
    await click('[aria-label="Back"]');
    await act(async () => { seed('/repo', { ...status, isClean: false, files: [{ path: 'working.png', index: 'M', working_dir: ' ' }] }); });

    await chooseMode('Branch');
    initialDiff = { path: 'working.png', staged: true };
    await render();
    expect(container.querySelector('h2')?.textContent).toBe('working.png');

    await act(async () => { seed('/repo-two'); });
    directory = '/repo-two';
    await render();
    expect(container.querySelector('[aria-label="Select change mode"]')?.textContent).toBe('Changes');
    expect(container.querySelector('h2')).toBeNull();
    expect(requests.some((url) => url.pathname === '/api/git/file-diff' && url.searchParams.get('directory') === '/repo-two')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  // One scenario loads the Changes surface and walks every mode in happy-dom.
  // It takes about a second on an idle machine, but the full suite runs four
  // test processes at once, and there it crossed the 5 second default on Windows.
}, 30_000);

// Revert All used to launch one POST /api/git/revert per changed path at once.
// The server serializes reverts per repository, so the extra requests only hold
// browser connections away from reads. This drives the real Changes surface and
// counts transport calls in flight at the fetch boundary.
test('bounds Revert All fan-out to two in-flight revert requests', async () => {
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
  const files = Array.from({ length: 8 }, (_, index) => `src/file-${index}.ts`);
  let revertCalls = 0;
  let activeReverts = 0;
  let peakReverts = 0;
  let releaseReverts: () => void = () => {};
  const revertGate = new Promise<void>((resolve) => { releaseReverts = () => resolve(); });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    switch (url.pathname) {
      case '/api/git/remotes': return Response.json([]);
      case '/api/git/remote-url': return Response.json({ url: null });
      case '/api/git/branches': return Response.json({ all: ['feature', 'main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } });
      case '/api/git/status': return Response.json({ current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true, diffStats: { staged: {}, working: {} } });
      case '/api/git/file-diff': return Response.json({ path: url.searchParams.get('path'), original: '', modified: '', isBinary: true });
      case '/api/git/revert': {
        revertCalls += 1;
        activeReverts += 1;
        peakReverts = Math.max(peakReverts, activeReverts);
        await revertGate;
        activeReverts -= 1;
        return Response.json({ success: true });
      }
      default: throw new Error(`Unexpected request ${url.pathname}`);
    }
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useGitStore } = await import('@/stores/useGitStore');
  // Change-request diffs exist only for providers the server serves.
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const servedGitHub = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [servedGitHub], byId: new Map([[servedGitHub.id, servedGitHub]]), status: 'ready', holdsList: true });
  const { MobileChangesPane } = await import('./MobileChangesSurface');
  const apis = createWebAPIs();
  const dirtyStatus: GitStatus = {
    current: 'feature', tracking: null, ahead: 0, behind: 0, isClean: false,
    files: files.map((path) => ({ path, index: ' ', working_dir: 'M' })),
    diffStats: { staged: {}, working: {} },
  };
  useGitStore.getState().setActiveDirectory('/repo');
  const previous = useGitStore.getState().getDirectoryState('/repo');
  if (!previous) throw new Error('Missing repository state');
  const now = Date.now();
  const directories = new Map(useGitStore.getState().directories);
  directories.set('/repo', {
    ...previous, status: dirtyStatus, isGitRepo: true,
    branches: { all: ['feature', 'main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } },
    log: { all: [], latest: null, total: 0 }, identity: { userName: 'Test Author', userEmail: 'test@example.com' },
    lastStatusFetch: now, lastBranchesFetch: now, lastLogFetch: now, lastIdentityFetch: now, lastRepoCheckAt: now,
  });
  useGitStore.setState({ directories });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const settle = async (done: () => boolean) => {
    for (let tick = 0; tick < 20 && !done(); tick += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  try {
    await act(async () => {
      root.render(<SyncProvider sdk={SYNC_SDK} directory="/repo"><I18nProvider><RuntimeAPIContext.Provider value={apis}>
        <MobileChangesPane rootDirectory="/repo"
          repository={{ rootIsGitRepo: true, gitDirectory: '/repo', nestedRepos: null, nestedRepoSelection: null, repositoryOptions: null }}
          visible />
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    const revertAll = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Revert all');
    if (!revertAll) throw new Error('Missing Revert all');
    await act(async () => { revertAll.click(); });
    const confirm = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === 'Revert all');
    if (!confirm) throw new Error('Missing Revert all confirmation');
    await act(async () => { confirm.click(); });
    // Two paths hold the only in-flight slots; the other six wait for one.
    await settle(() => revertCalls >= 2);
    expect(revertCalls).toBe(2);
    expect(peakReverts).toBeLessThanOrEqual(2);
    releaseReverts();
    await settle(() => revertCalls >= files.length);
    expect(revertCalls).toBe(files.length);
    expect(peakReverts).toBeLessThanOrEqual(2);
    // Let the post-revert refresh finish so the surface does not update after unmount.
    await settle(() => !container.textContent?.includes('Revert all'));
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);

// The desktop Diff view computes the last turn's changes on request from the
// session's snapshots. The mobile Changes surface mirrors it: a Last turn scope
// in the selector, a fetch keyed on the current session, and a read-only list
// whose status letters and counts come from the turn diff rather than from git.
test('mobile changes last turn scope lists the turn diffs, opens one, and shows the empty copy', async () => {
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
  const originalFetch = globalThis.fetch;
  const status: GitStatus = { current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true, diffStats: { staged: {}, working: {} } };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    switch (url.pathname) {
      case '/api/git/remotes': return Response.json([]);
      case '/api/git/identities': return Response.json([]);
      case '/api/git/global-identity': return Response.json(null);
      case '/api/git/remote-url': return Response.json({ url: null });
      case '/api/git/branch-base': return Response.json({ base: null });
      case '/api/git/status': return Response.json(status);
      case '/api/git/branches': return Response.json({ all: ['feature', 'main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } });
      case '/api/source-control/binding': return Response.json({
        status: 'bound', revision: 1,
        repository: { supported: true, repositoryId: 'repo', configRevision: 'rev', bare: false,
          remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }] },
        binding: { repositoryId: 'repo', configRevision: 'rev', revision: 1, state: 'bound',
          providers: [{ provider: 'github', instance: 'github.com', accountId: ACCOUNT_ID, primaryRemote: 'origin', readiness: 'ready', endpoint: ENDPOINT }],
          remotes: [], auxiliary: [] },
      });
      default: return Response.json({});
    }
  }, originalFetch);

  const turnDiffs = spyOn(opencodeClient, 'getSessionTurnDiff').mockResolvedValue([
    { file: 'src/added.ts', status: 'added', additions: 1, deletions: 0,
      patch: 'diff --git a/src/added.ts b/src/added.ts\nindex 1111111..2222222 100644\nBinary files a/src/added.ts and b/src/added.ts differ\n' },
    { file: 'src/modified.ts', status: 'modified', additions: 1, deletions: 1,
      patch: 'diff --git a/src/modified.ts b/src/modified.ts\nindex 3333333..4444444 100644\nBinary files a/src/modified.ts and b/src/modified.ts differ\n' },
  ]);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useGitStore } = await import('@/stores/useGitStore');
  // Change-request diffs exist only for providers the server serves.
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const servedGitHub = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [servedGitHub], byId: new Map([[servedGitHub.id, servedGitHub]]), status: 'ready', holdsList: true });
  const { MobileChangesPane } = await import('./MobileChangesSurface');
  const apis = createWebAPIs();
  useGitStore.getState().setActiveDirectory('/repo');
  const previous = useGitStore.getState().getDirectoryState('/repo');
  if (!previous) throw new Error('Missing repository state');
  const now = Date.now();
  const directories = new Map(useGitStore.getState().directories);
  directories.set('/repo', {
    ...previous, status, isGitRepo: true,
    branches: { all: ['feature', 'main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } },
    log: { all: [], latest: null, total: 0 }, identity: { userName: 'Test Author', userEmail: 'test@example.com' },
    lastStatusFetch: now, lastBranchesFetch: now, lastLogFetch: now, lastIdentityFetch: now, lastRepoCheckAt: now,
  });
  useGitStore.setState({ directories });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const click = async (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    await act(async () => { element.click(); });
  };
  const chooseMode = async (label: string) => {
    await click('[aria-label="Select change mode"]');
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((element) => element.textContent === label);
    if (!option) throw new Error(`Missing mode ${label}`);
    await act(async () => { option.click(); });
  };
  const openFile = async (path: string) => {
    const button = container.querySelector(`[title="${path}"]`)?.closest('button');
    if (!button) throw new Error(`Missing file ${path}`);
    await act(async () => { button.click(); });
  };
  try {
    await act(async () => {
      root.render(<SyncProvider sdk={SYNC_SDK} directory="/repo"><I18nProvider><RuntimeAPIContext.Provider value={apis}>
        <MobileChangesPane rootDirectory="/repo"
          repository={{ rootIsGitRepo: true, gitDirectory: '/repo', nestedRepos: null, nestedRepoSelection: null, repositoryOptions: null }}
          visible />
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    await act(async () => { useSessionUIStore.setState({ currentSessionId: 'ses_turn' }); });
    // The selector offers Last turn and choosing it asks the client for the turn.
    await chooseMode('Last turn');
    expect(turnDiffs.mock.calls[0]).toEqual(['ses_turn', { directory: '/repo' }]);
    expect(container.querySelector('[title="src/added.ts"]')).not.toBeNull();
    expect(container.querySelector('[title="src/modified.ts"]')).not.toBeNull();
    // Status letters and counts are the turn diff's, not the working tree's.
    const added = container.querySelector('[title="src/added.ts"]')?.closest('button');
    const modified = container.querySelector('[title="src/modified.ts"]')?.closest('button');
    expect(added?.textContent).toContain('A');
    expect(added?.textContent).toContain('+1 -0');
    expect(modified?.textContent).toContain('M');
    expect(modified?.textContent).toContain('+1 -1');
    await openFile('src/added.ts');
    expect(container.querySelector('h2')?.textContent).toBe('src/added.ts');
    expect(container.textContent).toContain('Last turn');
    expect(container.textContent).toContain('Content of this file cannot be viewed.');
    await click('[aria-label="Back"]');
    // An empty turn renders the desktop's empty copy rather than a blank list.
    turnDiffs.mockResolvedValue([]);
    await chooseMode('Changes');
    await chooseMode('Last turn');
    expect(container.textContent).toContain('No last turn changes to display');
    // A failed read says so with a retry instead of claiming the turn was empty.
    turnDiffs.mockRejectedValue(new Error('snapshot unavailable'));
    await chooseMode('Changes');
    await chooseMode('Last turn');
    expect(container.textContent).toContain('Failed to load diff');
    expect(container.textContent).toContain('snapshot unavailable');
    expect(container.textContent).not.toContain('No last turn changes to display');
    turnDiffs.mockResolvedValue([
      { file: 'src/retried.ts', status: 'modified', additions: 2, deletions: 0, patch: '' },
    ]);
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    if (!retry) throw new Error('Missing Retry');
    await act(async () => { retry.click(); });
    expect(container.querySelector('[title="src/retried.ts"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    turnDiffs.mockRestore();
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);


// The turn fetch is async, so the scope's first paint happens before any effect
// can flip a loading flag. The list must decide loading during render instead of
// showing the empty copy, which is only correct once a fetch has settled.
test('mobile changes last turn scope paints loading before the turn fetch settles', async () => {
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
  const originalFetch = globalThis.fetch;
  const status: GitStatus = { current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true, diffStats: { staged: {}, working: {} } };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    switch (url.pathname) {
      case '/api/git/remotes': return Response.json([]);
      case '/api/git/identities': return Response.json([]);
      case '/api/git/global-identity': return Response.json(null);
      case '/api/git/remote-url': return Response.json({ url: null });
      case '/api/git/branch-base': return Response.json({ base: null });
      case '/api/git/status': return Response.json(status);
      case '/api/git/branches': return Response.json({ all: ['feature', 'main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } });
      case '/api/source-control/binding': return Response.json({ status: 'unbound', revision: 1, repository: { supported: true, repositoryId: 'repo', configRevision: 'rev', bare: false, remotes: [] } });
      default: return Response.json({});
    }
  }, originalFetch);

  let releaseTurn: (files: FileDiffInfo[]) => void = () => {};
  const pendingTurn = new Promise<FileDiffInfo[]>((resolve) => { releaseTurn = resolve; });
  const turnDiffs = spyOn(opencodeClient, 'getSessionTurnDiff').mockImplementation(() => pendingTurn);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useGitStore } = await import('@/stores/useGitStore');
  // Change-request diffs exist only for providers the server serves.
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const servedGitHub = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [servedGitHub], byId: new Map([[servedGitHub.id, servedGitHub]]), status: 'ready', holdsList: true });
  const { MobileChangesPane } = await import('./MobileChangesSurface');
  const apis = createWebAPIs();
  useGitStore.getState().setActiveDirectory('/repo');
  const previous = useGitStore.getState().getDirectoryState('/repo');
  if (!previous) throw new Error('Missing repository state');
  const now = Date.now();
  const directories = new Map(useGitStore.getState().directories);
  directories.set('/repo', {
    ...previous, status, isGitRepo: true,
    branches: { all: ['feature', 'main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } },
    log: { all: [], latest: null, total: 0 }, identity: { userName: 'Test Author', userEmail: 'test@example.com' },
    lastStatusFetch: now, lastBranchesFetch: now, lastLogFetch: now, lastIdentityFetch: now, lastRepoCheckAt: now,
  });
  useGitStore.setState({ directories });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const chooseMode = async (label: string) => {
    const trigger = document.querySelector<HTMLElement>('[aria-label="Select change mode"]');
    if (!trigger) throw new Error('Missing mode trigger');
    await act(async () => { trigger.click(); });
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((element) => element.textContent === label);
    if (!option) throw new Error(`Missing mode ${label}`);
    await act(async () => { option.click(); });
  };
  try {
    await act(async () => {
      root.render(<SyncProvider sdk={SYNC_SDK} directory="/repo"><I18nProvider><RuntimeAPIContext.Provider value={apis}>
        <MobileChangesPane rootDirectory="/repo"
          repository={{ rootIsGitRepo: true, gitDirectory: '/repo', nestedRepos: null, nestedRepoSelection: null, repositoryOptions: null }}
          visible />
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    await act(async () => { useSessionUIStore.setState({ currentSessionId: 'ses_turn' }); });
    // The fetch is still in flight here: the first paint must be loading, never
    // the "no changes" copy.
    await chooseMode('Last turn');
    expect(container.textContent).toContain('Loading changes...');
    expect(container.textContent).not.toContain('No last turn changes to display');
    await act(async () => {
      releaseTurn([{ file: 'src/late.ts', status: 'modified', additions: 2, deletions: 1,
        patch: 'diff --git a/src/late.ts b/src/late.ts\nindex 5555555..6666666 100644\nBinary files a/src/late.ts and b/src/late.ts differ\n' }]);
    });
    expect(container.querySelector('[title="src/late.ts"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Loading changes...');
  } finally {
    await act(async () => root.unmount());
    turnDiffs.mockRestore();
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);

// The working list swaps the resolution header for the comparison chrome.
// The nested repository picker has to survive that swap: once auto-selection
// resolves a nested repository there is no other way to switch repositories.
test('keeps the nested repository picker reachable once the working list resolves a nested repository', async () => {
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
  const commits: GitLogEntry[] = ['a'].map((letter) => ({
    hash: letter.repeat(40), date: '2026-09-09T09:22:00Z', message: `Commit ${letter}`,
    refs: '', body: '', author_name: 'Test Author', author_email: 'test@example.com',
    filesChanged: 1, insertions: 0, deletions: 0, parents: [],
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    switch (url.pathname) {
      case '/api/git/remotes': return Response.json([]);
      case '/api/git/identities': return Response.json([]);
      case '/api/git/global-identity': return Response.json(null);
      case '/api/source-control/binding': return Response.json({
        status: 'bound', revision: 1,
        repository: { supported: true, repositoryId: 'repo', configRevision: 'rev', bare: false,
          remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }] },
        binding: { repositoryId: 'repo', configRevision: 'rev', revision: 1, state: 'bound',
          providers: [], remotes: [], auxiliary: [] },
      });
      case '/api/git/branch-base': return Response.json({ base: null });
      case '/api/git/log': return Response.json({ all: commits, latest: commits[0], total: commits.length });
      default: throw new Error(`Unexpected request ${url.pathname}`);
    }
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useGitStore } = await import('@/stores/useGitStore');
  // Change-request diffs exist only for providers the server serves.
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const servedGitHub = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [servedGitHub], byId: new Map([[servedGitHub.id, servedGitHub]]), status: 'ready', holdsList: true });
  const { MobileChangesPane } = await import('./MobileChangesSurface');
  const apis = createWebAPIs();
  const status: GitStatus = { current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true, diffStats: { staged: {}, working: {} } };
  const seed = (directory: string) => {
    useGitStore.getState().setActiveDirectory(directory);
    const previous = useGitStore.getState().getDirectoryState(directory);
    if (!previous) throw new Error('Missing repository state');
    const now = Date.now();
    const directories = new Map(useGitStore.getState().directories);
    directories.set(directory, {
      ...previous, status, isGitRepo: true,
      branches: { all: ['feature', 'main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } },
      log: { all: commits, latest: commits[0], total: commits.length }, identity: { userName: 'Test Author', userEmail: 'test@example.com' },
      lastStatusFetch: now, lastBranchesFetch: now, lastLogFetch: now, lastIdentityFetch: now, lastRepoCheckAt: now,
    });
    useGitStore.setState({ directories });
  };
  seed('/root/one');
  seed('/repo');
  seed('/repo/sub');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const settle = async (done: () => boolean) => {
    for (let tick = 0; tick < 20 && !done(); tick += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
  };
  const render = (rootDirectory: string, repository: { rootIsGitRepo: boolean; gitDirectory: string; nestedRepos: string[] | null; nestedRepoSelection: string | null; repositoryOptions: string[] | null }) => act(async () => {
    root.render(<SyncProvider sdk={SYNC_SDK} directory={rootDirectory}><I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <MobileChangesPane rootDirectory={rootDirectory} repository={repository} visible />
    </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
  });
  try {
    await render('/root', { rootIsGitRepo: false, gitDirectory: '/root/one', nestedRepos: ['/root/one', '/root/two'], nestedRepoSelection: '/root/one', repositoryOptions: ['/root/one', '/root/two'] });
    await settle(() => Boolean(container.querySelector('[aria-label="Select a repository..."]')));
    let picker = container.querySelector('[aria-label="Select a repository..."]');
    if (!picker) throw new Error('Missing nested repository picker in the working list header');
    if (!picker.textContent?.includes('one')) throw new Error('Picker does not show the resolved repository');

    // A root that is a repository offers itself first, then what is nested.
    await render('/repo', { rootIsGitRepo: true, gitDirectory: '/repo', nestedRepos: ['/repo/sub'], nestedRepoSelection: null, repositoryOptions: ['/repo', '/repo/sub'] });
    await settle(() => Boolean(container.querySelector('[aria-label="Select a repository..."]')?.textContent?.includes('repo')));
    picker = container.querySelector('[aria-label="Select a repository..."]');
    if (!picker?.textContent?.includes('repo')) throw new Error('Picker does not show the root repository');

    // Picking the nested repository (a submodule) switches the surface to it.
    await render('/repo', { rootIsGitRepo: true, gitDirectory: '/repo/sub', nestedRepos: ['/repo/sub'], nestedRepoSelection: '/repo/sub', repositoryOptions: ['/repo', '/repo/sub'] });
    await settle(() => Boolean(container.querySelector('[aria-label="Select a repository..."]')?.textContent?.includes('sub')));
    picker = container.querySelector('[aria-label="Select a repository..."]');
    if (!picker?.textContent?.includes('sub')) throw new Error('Picker does not show the selected nested repository');

    // A root repository with nothing nested keeps the picker hidden.
    await render('/repo', { rootIsGitRepo: true, gitDirectory: '/repo', nestedRepos: null, nestedRepoSelection: null, repositoryOptions: null });
    await settle(() => !container.querySelector('[aria-label="Select a repository..."]'));
    if (container.querySelector('[aria-label="Select a repository..."]')) throw new Error('Picker should stay hidden without nested repositories');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);
