import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitLogEntry } from '@/lib/api/types';

// A detached worktree reports its branch as `HEAD`, which is not a branch name.
// Qualifying it into `refs/heads/HEAD` made the whole history read fail.
test('commit history asks for HEAD while the worktree is detached', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const commit: GitLogEntry = {
    hash: 'a'.repeat(40), date: '2026-09-09T09:22:00Z', message: 'Detached commit',
    refs: '', body: '', author_name: 'Test Author', author_email: 'test@example.com',
    filesChanged: 1, insertions: 0, deletions: 0, parents: [],
  };
  const requestedRefs: Array<string | null> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') {
      return new Promise<Response>(() => {});
    }
    if (url.pathname !== '/api/git/log') {
      throw new Error(`Unexpected request ${url.pathname}`);
    }
    requestedRefs.push(url.searchParams.get('to'));
    return Response.json({ all: [commit], latest: commit, total: 1 });
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../web/src/api/index');
  const { useCommitComparison } = await import('./useCommitComparison');
  const apis = createWebAPIs();
  let branch: string | null = 'HEAD';
  type Capture = { current: ReturnType<typeof useCommitComparison> | null };
  const captured: Capture = { current: null };
  function Harness() {
    captured.current = useCommitComparison('/repo', branch, true);
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = () => act(async () => {
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <Harness />
    </RuntimeAPIContext.Provider></I18nProvider>);
  });
  try {
    await render();
    expect(requestedRefs).toEqual(['HEAD']);
    expect(captured.current?.commits.map((entry) => entry.hash)).toEqual([commit.hash]);
    expect(captured.current?.error).toBeNull();

    // A named branch keeps the qualified ref, so a same-named remote cannot win.
    branch = 'feature';
    await render();
    expect(requestedRefs).toEqual(['HEAD', 'refs/heads/feature']);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
