import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

// The whole-file comment in each entry's header reads the session's directory
// from sync; an empty client is enough for an entry with no session.
const SYNC_SDK = OpenCode.make({
  baseUrl: 'http://opencode.test',
  fetch: async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
});

const installDom = () => {
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
  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Promise<Response>(() => {}), previousFetch);
  return () => {
    globalThis.fetch = previousFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
};

test('hidden diff entries defer reads, retain completed content and refresh changed files on resume', async () => {
  const restoreDom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { MultiFileDiffEntry } = await import('./DiffView');
  const base = createWebAPIs();
  let reads = 0;
  const apis = { ...base, git: { ...base.git, getGitDiff: async () => {
    reads++;
    return { diff: 'Binary files a/test.bin and b/test.bin differ', submodule: null };
  } } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let visible = false;
  let insertions = 1;
  const render = () => act(async () => {
    root.render(<SyncProvider sdk={SYNC_SDK} directory="/repo"><I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <MultiFileDiffEntry directory="/repo" file={{ path: 'test.bin', index: ' ', working_dir: 'M', insertions, deletions: 0, isNew: false }}
        visible={visible} layout="inline" wrapLines={false} isSelected={false} isExpanded isMounted
        onSelect={() => {}} onExpandedChange={() => {}} registerSectionRef={() => {}} />
    </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
  });
  try {
    await render();
    expect(reads).toBe(0);
    visible = true;
    await render();
    expect(reads).toBe(1);
    expect(container.textContent).toContain('Content of this file cannot be viewed.');
    visible = false;
    await render();
    insertions = 2;
    await render();
    expect(reads).toBe(1);
    expect(container.textContent).toContain('Content of this file cannot be viewed.');
    visible = true;
    await render();
    expect(reads).toBe(2);
    visible = false;
    await render();
    visible = true;
    await render();
    expect(reads).toBe(2);
  } finally {
    await act(async () => root.unmount());
    restoreDom();
  }
});

test('status paths without file contents render what git records instead of an empty diff or a failure', async () => {
  const restoreDom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { GitPathUnavailableError } = await import('@/lib/api/git-path-diff');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { MultiFileDiffEntry } = await import('./DiffView');
  const recorded = '1'.repeat(40);
  const moved = '2'.repeat(40);
  const statusRequests: string[] = [];
  const diffRequests: string[] = [];
  const base = createWebAPIs();
  const apis = { ...base, git: { ...base.git,
    checkIsGitRepository: async () => true,
    getGitStatus: async (directory: string) => {
      statusRequests.push(directory);
      const files = directory === '/repo/nested' ? [{ path: 'src/inner.ts', index: ' ', working_dir: 'M' }] : [];
      return { current: 'main', tracking: null, ahead: 0, behind: 0, files, isClean: files.length === 0, diffStats: { staged: {}, working: { 'src/inner.ts': { insertions: 3, deletions: 1 } } } };
    },
    getGitDiff: async (directory: string, options: { path: string }) => {
      diffRequests.push(`${directory}:${options.path}`);
      if (options.path === 'nested/') throw new GitPathUnavailableError('Path is a separate Git repository: nested/', 'nested_repository');
      if (options.path === 'gone.txt') throw new GitPathUnavailableError('Path not found in working tree, index, or HEAD: gone.txt', 'path_not_found');
      return { diff: '', submodule: { headCommit: recorded, indexCommit: recorded, worktreeCommit: moved, hasTrackedChanges: false, hasUntrackedFiles: true, hasConflict: false } };
    },
  } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (path: string) => act(async () => {
    root.render(<SyncProvider sdk={SYNC_SDK} directory="/repo"><I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <MultiFileDiffEntry key={path} directory="/repo" file={{ path, index: ' ', working_dir: 'M', insertions: 0, deletions: 0, isNew: false }}
        layout="inline" wrapLines={false} isSelected={false} isExpanded isMounted
        onSelect={() => {}} onExpandedChange={() => {}} registerSectionRef={() => {}} />
    </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
  });
  try {
    useGitStore.getState().setActiveDirectory('/repo');
    await render('sub');
    expect(container.textContent).toContain('Submodule');
    expect(container.textContent).toContain('Commit 1111111 → 2222222');
    expect(container.textContent).toContain('Has untracked files');

    // A nested repository lists its own changes, read from that repository.
    await render('nested/');
    expect(container.textContent).toContain('Separate Git repository');
    expect(container.textContent).toContain('Open as project');
    expect(container.textContent).toContain('src/inner.ts');
    expect(container.textContent).toContain('+3');
    expect(container.textContent).not.toContain('Failed to load diff');
    expect(container.textContent).not.toContain('Retry');
    expect(statusRequests).toEqual(['/repo/nested']);
    const innerRow = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('src/inner.ts'));
    await act(async () => innerRow?.click());
    expect(diffRequests).toContain('/repo/nested:src/inner.ts');

    await render('gone.txt');
    expect(container.textContent).toContain('File no longer exists');
    expect(container.textContent).not.toContain('Failed to load diff');
    // A row that stays listed after the refresh can still be retried.
    expect(container.textContent).toContain('Retry');
    expect(statusRequests).toEqual(['/repo/nested', '/repo']);
  } finally {
    await act(async () => root.unmount());
    restoreDom();
  }
});
