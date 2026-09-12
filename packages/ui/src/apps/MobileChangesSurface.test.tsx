import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitLogEntry, GitStatus } from '@/lib/api/types';

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
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    requests.push(url);
    switch (url.pathname) {
      case '/api/git/remotes': return Response.json([]);
      case '/api/git/remote-url': return Response.json({ url: null });
      case '/api/git/branch-base': return Response.json({ base: null });
      case '/api/git/range-files': return Response.json({ files: [{ path: url.searchParams.get('base') === 'refs/heads/parent' ? 'parent.png' : 'branch.png', status: 'M' }] });
      case '/api/git/range-diff':
        return failBranchDiff
          ? Response.json({ error: 'Branch diff failed' }, { status: 500 })
          : Response.json({ diff: 'Binary files a/branch.png and b/branch.png differ' });
      case '/api/git/log': return Response.json({ all: commits, latest: commits[0], total: commits.length });
      case '/api/git/commit-files': return Response.json({ files: [{ path: `commit-${url.searchParams.get('hash')?.[0]}.png`, previousPath: 'old.png', changeType: 'R', insertions: 0, deletions: 0, isBinary: true }] });
      case '/api/git/commit-diff': return Response.json({ diff: 'Binary files a/old.png and b/commit.png differ' });
      case '/api/git/file-diff': return Response.json({ path: 'working.png', original: '', modified: '', isBinary: true });
      case '/api/github/pr/status': return Response.json({ connected: true, repo: { owner: 'upstream', repo: 'project' },
        pr: { number: 42, title: 'Published PR', url: 'https://github.com/upstream/project/pull/42', state: 'open', draft: false, head: 'feature', base: 'main' } });
      case '/api/github/pulls/list': return Response.json({ connected: true, repo: { owner: 'upstream', repo: 'project' },
        prs: [{ number: 42, title: 'Published PR', url: 'https://github.com/upstream/project/pull/42', state: 'open', draft: false,
          head: 'feature', base: 'main', sourceRepo: { owner: 'upstream', repo: 'project', source: 'upstream' } }], hasMore: false });
      case '/api/walkthrough/pr-diff': return new Response('diff --git a/published.png b/published.png\nindex 1111111..2222222 100644\nBinary files a/published.png and b/published.png differ\n', { headers: { 'content-type': 'text/plain' } });
      default: throw new Error(`Unexpected request ${url.pathname}`);
    }
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { useGitHubAuthStore } = await import('@/stores/useGitHubAuthStore');
  useGitHubAuthStore.setState({ hasChecked: true, status: { connected: true } });
  const { MobileChangesPane } = await import('./MobileChangesSurface');
  const apis = createWebAPIs();
  const status: GitStatus = { current: 'feature', tracking: null, ahead: 0, behind: 0, files: [], isClean: true, diffStats: {} };
  const seed = (directory: string, nextStatus = status) => {
    useGitStore.getState().setActiveDirectory(directory);
    const previous = useGitStore.getState().getDirectoryState(directory);
    if (!previous) throw new Error('Missing repository state');
    const now = Date.now();
    const directories = new Map(useGitStore.getState().directories);
    directories.set(directory, {
      ...previous, status: nextStatus, isGitRepo: true,
      branches: { all: ['feature', 'main', 'parent', 'remotes/origin/main'], current: 'feature', branches: {}, defaultBranches: { origin: 'main' } },
      log: { all: commits, latest: commits[0], total: 2 }, identity: { userName: 'Test Author', userEmail: 'test@example.com', sshCommand: null },
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
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <MobileChangesPane rootDirectory={directory}
        repository={{ rootIsGitRepo: true, gitDirectory: directory, nestedRepos: null, nestedRepoSelection: null }}
        visible={visible} initialDiff={initialDiff} />
    </RuntimeAPIContext.Provider></I18nProvider>);
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
    const syncButton = container.querySelector('[aria-label="Sync Changes"]');
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
    expect(container.textContent).toContain('Select a base branch');
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
    expect(requests.filter((url) => url.pathname === '/api/git/file-diff')).toHaveLength(0);

    await act(async () => { seed('/repo', { ...status, isClean: false, files: [{ path: 'working.png', index: 'M', working_dir: ' ' }] }); });
    initialDiff = { path: 'working.png', staged: true };
    await render();
    expect(container.querySelector('h2')?.textContent).toBe('working.png');
    const workingRequest = [...requests].reverse().find((url) => url.pathname === '/api/git/file-diff');
    expect(workingRequest?.searchParams.get('staged')).toBe('true');
    await click('[aria-label="Back"]');
    expect(container.querySelector('[aria-label="Select change mode"]')?.textContent).toBe('Changes');
    expect(container.querySelector('[aria-label="Sync Changes"]')).not.toBeNull();
    expect(checkoutControl()).toBeDefined();

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
});
