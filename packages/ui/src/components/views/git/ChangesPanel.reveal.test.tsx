import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('a newly selected file opens its collapsed group and folders in the tree', async () => {
  const dom = new Window({ url: 'http://localhost' });
  dom.happyDOM.setWindowSize({ width: 1280, height: 800 });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  try {
    const { ChangesPanel } = await import('./ChangesPanel');
    const { I18nProvider } = await import('@/lib/i18n');
    const noop = () => {};
    const group = (id: string, paths: string[]) => ({
      id, title: id, entries: paths.map((path) => ({ path, index: ' ', working_dir: 'M' })), statsScope: 'working' as const,
      actionSymbol: '+' as const, actionAllLabel: 'all', getActionLabel: () => 'one',
      onActionFile: noop, onActionAll: noop, onViewDiff: noop, onRevertFile: noop,
    });
    const groups = [group('staged', ['src/lib/a.ts', 'src/lib/b.ts']), group('working', ['docs/c.md'])];
    const Panel = ({ selectedKey }: { selectedKey: string | null }) => (
      <I18nProvider><ChangesPanel
        groups={groups}
        diffStats={undefined}
        revertingPaths={new Set()}
        selectedKey={selectedKey}
        alwaysTree
      /></I18nProvider>
    );
    const visible = (name: string) => (host.textContent ?? '').includes(name);

    await act(async () => root.render(<Panel selectedKey="working:docs/c.md" />));
    expect(visible('a.ts')).toBe(true);

    const folder = host.querySelector<HTMLElement>('button[aria-expanded="true"][aria-label*="src/lib"]');
    if (!folder) throw new Error('the src/lib folder did not render expanded');
    await act(async () => folder.click());
    expect(visible('a.ts')).toBe(false);

    await act(async () => root.render(<Panel selectedKey="staged:src/lib/a.ts" />));
    expect(visible('a.ts')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
