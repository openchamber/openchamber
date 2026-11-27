import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('the wide layout follows the zone target when a resize animation starts, not the width mid-animation', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const observers: Array<() => void> = [];
  class ManualResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() { observers.push(this.callback); }
    disconnect() {}
    unobserve() {}
  }
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    ResizeObserver: ManualResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { useUnifiedGitPanel } = await import('./useUnifiedGitPanel');
  const { holdLayoutAnimation } = await import('@/lib/layoutAnimation');

  const zone = document.createElement('div');
  zone.setAttribute('data-context-panel', 'true');
  zone.dataset.zoneAxis = 'width';
  document.body.append(zone);
  let width = 1200;
  const seen: boolean[] = [];
  const Probe = () => {
    const panel = useUnifiedGitPanel({ isActive: true, isMobile: false, diffScope: null, targetFilePath: null });
    seen.push(panel.isWide);
    const { setRootRef } = panel;
    const attach = React.useCallback((node: HTMLDivElement | null) => {
      if (node) Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => width });
      setRootRef(node);
    }, [setRootRef]);
    return <div ref={attach} />;
  };
  const root = createRoot(zone);
  try {
    zone.dataset.zoneSize = '1214';
    await act(async () => root.render(<Probe />));
    expect(seen.at(-1)).toBe(true);

    zone.dataset.zoneSize = '494';
    let release = () => {};
    await act(async () => { release = holdLayoutAnimation(); });
    expect(seen.at(-1)).toBe(false);

    const renders = seen.length;
    width = 900;
    await act(async () => observers.forEach((notify) => notify()));
    expect(seen.length).toBe(renders);

    width = 480;
    await act(async () => {
      release();
      await new Promise((resolve) => dom.requestAnimationFrame(() => resolve(null)));
    });
    expect(seen.at(-1)).toBe(false);

    width = 850;
    await act(async () => observers.forEach((notify) => notify()));
    expect(seen.at(-1)).toBe(true);

    zone.dataset.zoneAxis = 'height';
    zone.dataset.zoneSize = '300';
    await act(async () => { release = holdLayoutAnimation(); });
    expect(seen.at(-1)).toBe(true);
    await act(async () => {
      release();
      await new Promise((resolve) => dom.requestAnimationFrame(() => resolve(null)));
    });
    expect(seen.at(-1)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);

test('remembers the last manually chosen scope without letting programmatic jumps overwrite it', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { useUIStore } = await import('@/stores/useUIStore');
  const { useUnifiedGitPanel } = await import('./useUnifiedGitPanel');

  useUIStore.setState({ lastGitPanelScope: 'working', pendingDiffFile: null, pendingDiffScope: null, pendingTurnDiffFile: null });

  const container = document.createElement('div');
  document.body.append(container);
  let latest: ReturnType<typeof useUnifiedGitPanel> | null = null;
  const Probe = ({ diffScope = null }: { diffScope?: 'working' | 'staged' | 'branch' | 'commit' | 'pr' | 'turn' | null }) => {
    latest = useUnifiedGitPanel({ isActive: true, isMobile: false, diffScope, targetFilePath: null });
    return null;
  };
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Probe />));
    expect(latest!.activeScope).toBe('working');

    // Manual pick saves 'branch' as the default for new panels
    await act(async () => latest!.handleScopeChange('branch'));
    expect(useUIStore.getState().lastGitPanelScope).toBe('branch');

    // Programmatic jump (e.g. turn chip or coercion) does not overwrite 'branch'
    await act(async () => latest!.handleScopeChange('turn', { remember: false }));
    expect(latest!.activeScope).toBe('turn');
    expect(useUIStore.getState().lastGitPanelScope).toBe('branch');

    await act(async () => latest!.handleScopeChange('commit'));
    await act(async () => useUIStore.setState({ pendingDiffFile: 'src/index.ts', pendingDiffScope: null }));
    expect(latest!.activeScope).toBe('working');
    expect(latest!.focusRequest?.path).toBe('src/index.ts');
    expect(useUIStore.getState().lastGitPanelScope).toBe('commit');
    await act(async () => latest!.handleScopeChange('branch'));

    // A fresh mount with diffScope=null opens on the remembered 'branch' scope
    await act(async () => root.unmount());
    const root2 = createRoot(container);
    await act(async () => root2.render(<Probe diffScope={null} />));
    expect(latest!.activeScope).toBe('branch');
    await act(async () => root2.unmount());
  } finally {
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);
