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

test('a nested repository row keeps the separate-repository note without recursive reads', async () => {
  const restoreDom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { GitPathUnavailableError } = await import('@/lib/api/git-path-diff');
  const { useGitStore } = await import('@/stores/useGitStore');
  const { MultiFileDiffEntry } = await import('./DiffView');
  const statusRequests: string[] = [];
  const diffRequests: string[] = [];
  const base = createWebAPIs();
  const apis = { ...base, git: { ...base.git,
    checkIsGitRepository: async () => true,
    getGitStatus: async (directory: string) => {
      statusRequests.push(directory);
      const filesByDirectory: Record<string, Array<{ path: string; index: string; working_dir: string }>> = {
        '/repo/nested': [
          { path: 'src/inner.ts', index: ' ', working_dir: 'M' },
          { path: 'inner-lib/', index: ' ', working_dir: 'M' },
        ],
        '/repo/nested/inner-lib': [{ path: 'deep.ts', index: ' ', working_dir: 'M' }],
      };
      const files = filesByDirectory[directory] ?? [];
      return { current: 'main', tracking: null, ahead: 0, behind: 0, files, isClean: files.length === 0, diffStats: { staged: {}, working: { 'src/inner.ts': { insertions: 3, deletions: 1 } } } };
    },
    getGitDiff: async (directory: string, options: { path: string }) => {
      diffRequests.push(`${directory}:${options.path}`);
      if (options.path === 'nested/' || options.path === 'inner-lib/') {
        throw new GitPathUnavailableError(`Path is a separate Git repository: ${options.path}`, 'nested_repository');
      }
      return { diff: '', submodule: null };
    },
  } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () => act(async () => {
    root.render(<SyncProvider sdk={SYNC_SDK} directory="/repo"><I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <MultiFileDiffEntry directory="/repo" file={{ path: 'nested/', index: ' ', working_dir: 'M', insertions: 0, deletions: 0, isNew: false }}
        layout="inline" wrapLines={false} isSelected={false} isExpanded isMounted
        onSelect={() => {}} onExpandedChange={() => {}} registerSectionRef={() => {}} />
    </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
  });
  try {
    useGitStore.getState().setActiveDirectory('/repo');
    await render();
    expect(container.textContent).toContain('Separate Git repository');
    expect(container.textContent).toContain('src/inner.ts');
    expect(statusRequests).toEqual(['/repo/nested']);

    const grandchildRow = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('inner-lib/'));
    await act(async () => grandchildRow?.click());
    expect(diffRequests).toContain('/repo/nested:inner-lib/');
    expect(statusRequests).toEqual(['/repo/nested']);
    expect(container.textContent).not.toContain('deep.ts');
    expect(container.textContent).not.toContain('Failed to load diff');
  } finally {
    await act(async () => root.unmount());
    restoreDom();
  }
});
