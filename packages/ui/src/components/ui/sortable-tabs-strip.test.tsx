import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let ContextMenuItem: typeof import('./context-menu').ContextMenuItem;
let SortableTabsStrip: typeof import('./sortable-tabs-strip').SortableTabsStrip;

describe('tab strip wheel scrolling', () => {
  let dom: Window;
  let root: Root;
  let host: HTMLDivElement;
  let restoreGlobals: () => void;
  let selections: string[];
  let reorders: string[][];

  beforeEach(async () => {
    dom = new Window({ url: 'http://localhost' });
    const globals = {
      window: dom, document: dom.document, navigator: dom.navigator,
      Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
      MouseEvent: dom.MouseEvent, WheelEvent: dom.WheelEvent,
      Event: dom.Event, CustomEvent: dom.CustomEvent,
      KeyboardEvent: dom.KeyboardEvent, DOMRect: dom.DOMRect,
      MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
      getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    selections = [];
    reorders = [];
    // Base UI reads the DOM globals when its modules load.
    ({ I18nProvider } = await import('@/lib/i18n'));
    ({ ContextMenuItem } = await import('./context-menu'));
    ({ SortableTabsStrip } = await import('./sortable-tabs-strip'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    restoreGlobals();
  });

  const render = async (options: Pick<React.ComponentProps<typeof SortableTabsStrip>, 'scrollWithWheel' | 'layoutMode' | 'tabContextMenu'> = { scrollWithWheel: true }) => {
    await act(async () => root.render(
      <I18nProvider>
        <SortableTabsStrip
          items={[{ id: 'first', label: 'first.ts' }, { id: 'second', label: 'second.ts' }]}
          activeId="first"
          onSelect={(id) => selections.push(id)}
          onReorder={(active, over) => reorders.push([active, over])}
          {...options}
        />
      </I18nProvider>,
    ));
    const strip = host.querySelector<HTMLDivElement>('[role="tablist"]');
    if (!strip) throw new Error('Expected a tab strip');
    return strip;
  };

  const wheel = async (strip: HTMLDivElement, init: WheelEventInit) => {
    const tab = strip.querySelector('[role="tab"]');
    if (!tab) throw new Error('Expected a tab');
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    // happy-dom's WheelEvent omits the mouse modifier fields.
    Object.defineProperties(event, {
      shiftKey: { value: init.shiftKey ?? false },
      ctrlKey: { value: init.ctrlKey ?? false },
      metaKey: { value: init.metaKey ?? false },
    });
    await act(async () => { tab.dispatchEvent(event); });
    return event;
  };

  test('scrolls in both directions from a tab without selecting or reordering files', async () => {
    const strip = await render();
    const event = await wheel(strip, { deltaY: 120 });
    expect(strip.scrollLeft).toBe(120);
    await wheel(strip, { deltaY: -40 });
    expect(strip.scrollLeft).toBe(80);
    expect(selections).toEqual([]);
    expect(reorders).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  test('converts line deltas and scrolls toward later tabs in RTL', async () => {
    host.dir = 'rtl';
    const strip = await render();
    await wheel(strip, { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(strip.scrollLeft).toBe(-48);
    await wheel(strip, { deltaY: -1, deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(strip.scrollLeft).toBe(-32);
  });

  test('leaves horizontal gestures and modified wheels to the browser', async () => {
    const strip = await render();
    strip.scrollLeft = 100;
    for (const init of [
      { deltaX: 120, deltaY: 0 },
      { deltaX: 120, deltaY: 40 },
      { deltaX: 40, deltaY: 40 },
      { deltaY: 120, shiftKey: true },
      { deltaY: 120, ctrlKey: true },
      { deltaY: 120, metaKey: true },
    ]) {
      const event = await wheel(strip, init);
      expect(strip.scrollLeft).toBe(100);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  test('keeps wheel mapping opt-in and disabled for fitted strips', async () => {
    for (const options of [{}, { scrollWithWheel: true, layoutMode: 'fit' as const }]) {
      const strip = await render(options);
      await wheel(strip, { deltaY: 120 });
      expect(strip.scrollLeft).toBe(0);
    }
  });

  test('does not scroll the strip from a portalled tab menu', async () => {
    const strip = await render({ scrollWithWheel: true, tabContextMenu: () => <ContextMenuItem>Menu item</ContextMenuItem> });
    const tab = strip.querySelector('[role="tab"]');
    if (!tab) throw new Error('Expected a tab');
    await act(async () => { tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })); });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    if (!menu) throw new Error('Expected a tab menu');
    expect(strip.contains(menu)).toBe(false);
    await act(async () => { menu.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 })); });
    expect(strip.scrollLeft).toBe(0);
    expect(selections).toEqual([]);
  });
});
