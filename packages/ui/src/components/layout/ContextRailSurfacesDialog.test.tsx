import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { useGuestsStore } from '@/lib/guests/store';
import { CONTEXT_SURFACES } from '@/lib/surfaces/registry';

let ContextRailSurfacesDialog: typeof import('./ContextRailSurfacesDialog').ContextRailSurfacesDialog;
const defaultOrder = CONTEXT_SURFACES.map((surface) => surface.id);

describe('rail panel arrangement dialog', () => {
  let win: Window;
  let root: Root;
  let restoreGlobals: () => void;
  let closeCount: number;

  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-settings-item^="layout.context-rail.surface."]')];
  const order = () => rows().map((row) => row.dataset.settingsItem?.replace('layout.context-rail.surface.', ''));
  const handle = (index: number) => {
    const button = rows()[index]?.parentElement?.querySelector('button');
    if (!button) throw new Error('Expected a drag handle');
    return button;
  };
  const render = async () => {
    await act(async () => root.render(
      <I18nProvider><ContextRailSurfacesDialog open onOpenChange={() => { closeCount += 1; }} /></I18nProvider>,
    ));
    // Supply layout for happy-dom while exercising the real dnd-kit sensors.
    rows().forEach((row, index) => {
      const rect = () => new DOMRect(0, index * 36, 400, 36);
      const parent = row.parentElement;
      if (!parent) throw new Error('Expected sortable row');
      parent.getBoundingClientRect = rect;
      handle(index).getBoundingClientRect = rect;
    });
  };
  const key = async (target: EventTarget, code: string, value = code) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code, key: value }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, HTMLInputElement: win.HTMLInputElement,
      HTMLIFrameElement: win.HTMLIFrameElement, SVGElement: win.SVGElement,
      Document: win.Document, DocumentFragment: win.DocumentFragment,
      DOMRect: win.DOMRect, Event: win.Event, CustomEvent: win.CustomEvent,
      MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
      Touch: win.Touch, TouchEvent: win.TouchEvent,
      MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
      localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    ({ ContextRailSurfacesDialog } = await import('./ContextRailSurfacesDialog'));
    useUIStore.setState({ contextRailOrder: [...defaultOrder], contextRailHiddenSurfaces: [] });
    closeCount = 0;
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useGuestsStore.setState({ guests: [] });
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('mouse dragging commits once on drop and preserves visibility', async () => {
    const first = handle(0);
    await act(async () => first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 12, clientY: 18 })));
    await act(async () => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 30 })));
    await act(async () => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 90 })));
    expect(useUIStore.getState().contextRailOrder).toEqual(defaultOrder);
    await act(async () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    expect(order().slice(0, 3)).toEqual(['git', 'pr', 'context']);
    expect(useUIStore.getState().contextRailOrder.slice(0, 3)).toEqual(['git', 'pr', 'context']);
    expect(useUIStore.getState().contextRailHiddenSurfaces).toEqual([]);
    expect(closeCount).toBe(0);
  });

  test('hidden panels remain reorderable and Show all preserves order across remount', async () => {
    await act(async () => rows()[0].click());
    handle(0).focus();
    await key(handle(0), 'Space', ' ');
    await key(handle(0), 'ArrowDown');
    await key(handle(0), 'Space', ' ');
    expect(order().slice(0, 2)).toEqual(['git', 'context']);
    expect(useUIStore.getState().contextRailHiddenSurfaces).toEqual(['context']);
    const showAll = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Show all');
    if (!showAll) throw new Error('Expected Show all');
    await act(async () => showAll.click());
    expect(useUIStore.getState().contextRailHiddenSurfaces).toEqual([]);
    await act(async () => root.render(null));
    await render();
    expect(order().slice(0, 2)).toEqual(['git', 'context']);
  });

  test('Escape cancels a keyboard drag without closing or saving', async () => {
    handle(0).focus();
    await key(handle(0), 'Space', ' ');
    await key(handle(0), 'ArrowDown');
    await key(handle(0), 'Escape');
    expect(handle(0).getAttribute('aria-pressed')).not.toBe('true');
    expect(order()).toEqual(defaultOrder);
    expect(useUIStore.getState().contextRailOrder).toEqual(defaultOrder);
    expect(closeCount).toBe(0);
  });

  test('reorders an installed extension and retains unavailable extension ids', async () => {
    await act(async () => {
      useGuestsStore.setState({ guests: [{
        id: 'git-graph', name: 'Git graph', icon: 'git-commit', entry: 'index.html',
        capabilities: { requested: [], granted: [] },
      }] });
      useUIStore.getState().setContextRailOrder(['plugin:gone', 'plugin:git-graph', ...defaultOrder]);
    });
    await render();
    expect(rows()[0].textContent).toContain('Git graph');
    handle(0).focus();
    await key(handle(0), 'Space', ' ');
    await key(handle(0), 'ArrowDown');
    await key(handle(0), 'Space', ' ');
    expect(order().slice(0, 2)).toEqual(['context', 'plugin:git-graph']);
    expect(useUIStore.getState().contextRailOrder.at(-1)).toBe('plugin:gone');
  });

  test('touch requires a hold before reordering', async () => {
    const first = handle(0);
    const touch = (y: number) => new Touch({ identifier: 1, target: first, clientX: 12, clientY: y });
    const dispatch = (type: string, y: number) => first.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch(y)], changedTouches: [touch(y)],
    }));
    await act(async () => dispatch('touchstart', 18));
    await act(async () => dispatch('touchmove', 90));
    await act(async () => dispatch('touchend', 90));
    expect(order()).toEqual(defaultOrder);
    await act(async () => {
      dispatch('touchstart', 18);
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    await act(async () => dispatch('touchmove', 90));
    await act(async () => dispatch('touchend', 90));
    expect(order().slice(0, 3)).toEqual(['git', 'pr', 'context']);
  });
});
