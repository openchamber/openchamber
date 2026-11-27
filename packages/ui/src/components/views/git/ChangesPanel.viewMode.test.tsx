import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('the changes list follows the flat/tree setting in the wide sidebar', async () => {
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
  const { useUIStore } = await import('@/stores/useUIStore');
  const previousViewMode = useUIStore.getState().gitChangesViewMode;
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
    const groups = [group('working', ['src/lib/a.ts', 'docs/c.md'])];
    const Panel = () => (
      <I18nProvider><ChangesPanel
        groups={groups}
        diffStats={undefined}
        revertingPaths={new Set()}
        wideSidebar
      /></I18nProvider>
    );
    const folderRows = () => host.querySelectorAll('button[aria-expanded][aria-label*="src"]').length;

    useUIStore.setState({ gitChangesViewMode: 'flat' });
    await act(async () => root.render(<Panel />));
    expect(folderRows()).toBe(0);
    expect(host.textContent).toContain('a.ts');
    expect(host.textContent).toContain('c.md');

    await act(async () => { useUIStore.setState({ gitChangesViewMode: 'tree' }); });
    expect(folderRows()).toBeGreaterThan(0);
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState({ gitChangesViewMode: previousViewMode });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
