import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('hidden diff entries defer reads, retain completed content and refresh changed files on resume', async () => {
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
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { MultiFileDiffEntry } = await import('./DiffView');
  const base = createWebAPIs();
  let reads = 0;
  const apis = { ...base, git: { ...base.git, getGitDiff: async () => {
    reads++;
    return { diff: 'Binary files a/test.bin and b/test.bin differ' };
  } } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let visible = false;
  let insertions = 1;
  const render = () => act(async () => {
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>
      <MultiFileDiffEntry directory="/repo" file={{ path: 'test.bin', index: ' ', working_dir: 'M', insertions, deletions: 0, isNew: false }}
        visible={visible} layout="inline" wrapLines={false} isSelected={false} isExpanded isMounted
        onSelect={() => {}} onExpandedChange={() => {}} registerSectionRef={() => {}} />
    </RuntimeAPIContext.Provider></I18nProvider>);
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
    globalThis.fetch = previousFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
