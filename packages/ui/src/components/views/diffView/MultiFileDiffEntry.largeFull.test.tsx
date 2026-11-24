import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { OpenCode } from '@opencode/client';

import type { ComparisonDiffResult } from './types';

// Bun does not implement Vite's worker URL imports.
plugin({ name: 'large-full-worker-url', setup(build) {
  build.onLoad({ filter: /\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
} });

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

// A comment jump that needs the whole file of a large diff reads it only after
// the user lets the default patch render, and an oversized whole-file read asks
// again before it is parsed; Find reads neither before then.
test('an oversized whole-file read waits for its own approval, and Find stays on the patch until then', async () => {
  const restoreDom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { MultiFileDiffEntry } = await import('../DiffView');

  const file = { path: 'src/big.ts', index: '', working_dir: 'M', insertions: 600, deletions: 0, isNew: false };
  const range: ComparisonDiffResult = { status: 'large', patch: '@@ -1,1 +1,1 @@\n-a\n+b\n', changedLines: 600 };
  const full: ComparisonDiffResult = { status: 'large', patch: '@@ -1,1 +1,1 @@\n-a\n+b\n', changedLines: 600, contextMode: 'full' };
  let fullReads = 0;
  const findFullContext: boolean[] = [];
  const apis = createWebAPIs();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let fullRead: Promise<ComparisonDiffResult> | null = null;
  const loadFull = () => {
    fullReads += 1;
    fullRead = Promise.resolve(full);
    return fullRead;
  };
  const onFullContextChange = (_path: string, value: boolean) => { findFullContext.push(value); };
  const renderAnyway = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Render anyway') ?? null;
  try {
    await act(async () => {
      root.render(<SyncProvider sdk={SYNC_SDK} directory="/repo"><I18nProvider><RuntimeAPIContext.Provider value={apis}>
        <MultiFileDiffEntry directory="/repo" file={file} layout="inline" wrapLines={false} isSelected={false} isExpanded isMounted
          onSelect={() => {}} onExpandedChange={() => {}} registerSectionRef={() => {}}
          comparisonDiff={range} loadFullComparisonDiff={loadFull} fullContext onFullContextChange={onFullContextChange} />
      </RuntimeAPIContext.Provider></I18nProvider></SyncProvider>);
    });
    expect(renderAnyway()).not.toBeNull();
    expect(container.textContent).toContain('Large diff (600 changed lines)');
    expect(fullReads).toBe(0);

    await act(async () => renderAnyway()?.click());
    await act(async () => { await fullRead; });
    expect(fullReads).toBe(1);
    expect(renderAnyway()).not.toBeNull();
    expect(container.textContent).toContain('Large file');
    expect(container.textContent).not.toContain('very long lines');
    expect(findFullContext).not.toContain(true);
  } finally {
    await act(async () => root.unmount());
    restoreDom();
  }
});
