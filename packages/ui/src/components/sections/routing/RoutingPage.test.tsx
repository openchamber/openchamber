import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'KeyboardEvent',
  'PointerEvent',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT', 'CustomEvent', 'MutationObserver', 'ResizeObserver'] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    Event: happyWindow.Event,
    KeyboardEvent: happyWindow.KeyboardEvent,
    PointerEvent: happyWindow.PointerEvent,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  
    CustomEvent: happyWindow.CustomEvent,
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,};
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const config = {
  enabled: false,
  fallback: null,
  minConfidence: 0.6,
  preserveCache: true,
  safetyNet: { enabled: false, threshold: 0.6 },
  stickiness: { enabled: true, enterTurns: 2, exitTurns: 3, strongConfidence: 0.9 },
  categories: [],
};

const state = {
  available: true,
  autoReady: false,
  jevAvailable: true,
  tokenPresent: false,
  jevSource: 'zen-free',
  config,
  builtins: [],
};

const DEBOUNCE_MS = 500;

let mounted: { root: Root; restore: () => void } | null = null;

// The bodies of the PUT requests the page sent, in order.
const puts: string[] = [];

const reply = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('RoutingPage', () => {
  beforeEach(() => {
    puts.length = 0;
    spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) !== '/api/routing') return new Response('', { status: 404 });
      if (init?.method === 'PUT') {
        const body = init.body ? String(init.body) : '';
        puts.push(body);
        return reply(JSON.stringify({ ...state, config: JSON.parse(body).config }));
      }
      return reply(JSON.stringify(state));
    });
  });

  afterEach(async () => {
    mock.restore();
    if (!mounted) return;
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.restore();
  });

  test('saves the Auto switch as one debounced write of the whole configuration', async () => {
    const dom = installDom();
    // Imported after the DOM exists, as the other routing page tests do.
    const { createRoot } = await import('react-dom/client');
    const { RoutingPage } = await import('./RoutingPage');
    const { I18nProvider } = await import('@/lib/i18n');
    const root = createRoot(dom.container);
    mounted = { root, restore: dom.restore };
    await act(async () => {
      root.render(
        <I18nProvider>
          <RoutingPage />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const auto = dom.container.querySelector<HTMLElement>('[aria-label="Enable Auto mode"]');
    if (!auto) throw new Error('no Auto switch');
    await act(async () => auto.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 150));
    });
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0] ?? '')).toMatchObject({ config: { enabled: true, categories: [] } });
  });
  test('shows one section per tab, and all of them when the page is set to all on one page', async () => {
    const dom = installDom();
    const { createRoot } = await import('react-dom/client');
    const { RoutingPage } = await import('./RoutingPage');
    const { useRoutingPageViewStore } = await import('./routingTabs');
    const { I18nProvider } = await import('@/lib/i18n');
    const root = createRoot(dom.container);
    mounted = { root, restore: dom.restore };
    useRoutingPageViewStore.setState({ tab: 'auto', showAllOnOnePage: false });
    await act(async () => {
      root.render(
        <I18nProvider>
          <RoutingPage />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const sectionIds = () => Array.from(dom.container.querySelectorAll('[id^="routing-"]')).map((node) => node.id);
    expect(sectionIds()).toEqual(['routing-auto']);

    const pools = Array.from(dom.container.querySelectorAll<HTMLElement>('[role="tab"]')).find((tab) => tab.textContent?.trim() === 'Model pools');
    if (!pools) throw new Error('no Model pools tab');
    await act(async () => pools.click());
    expect(sectionIds()).toEqual(['routing-pools']);

    const all = dom.container.querySelector<HTMLElement>('[aria-label="Show all on one page"]');
    if (!all) throw new Error('no all-on-one-page switch');
    await act(async () => all.click());
    expect(sectionIds()).toEqual(['routing-auto', 'routing-rules', 'routing-pools', 'routing-plans', 'routing-categories']);
    useRoutingPageViewStore.setState({ tab: 'auto', showAllOnOnePage: false });
  });

  // At a phone's width five fitted tabs were cut to "Auto …", "Rout…",
  // "Mod…". There the strip scrolls and each tab keeps its whole label;
  // desktop still fits them to the page.
  test('the section tabs scroll on a phone and fit the width on desktop', async () => {
    const dom = installDom();
    const { createRoot } = await import('react-dom/client');
    const { RoutingPage } = await import('./RoutingPage');
    const { I18nProvider } = await import('@/lib/i18n');
    const { useUIStore } = await import('@/stores/useUIStore');
    const root = createRoot(dom.container);
    mounted = { root, restore: dom.restore };
    const wasMobile = useUIStore.getState().isMobile;
    const tablistScrolls = () => dom.container.querySelector('[role="tablist"]')?.classList.contains('overflow-x-auto') ?? null;
    try {
      useUIStore.setState({ isMobile: true });
      await act(async () => {
        root.render(
          <I18nProvider>
            <RoutingPage />
          </I18nProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(tablistScrolls()).toBe(true);

      await act(async () => useUIStore.setState({ isMobile: false }));
      expect(tablistScrolls()).toBe(false);
    } finally {
      useUIStore.setState({ isMobile: wasMobile });
    }
  });
});
