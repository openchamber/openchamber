import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { useGuestsStore } from '@/lib/guests/store';
import { WORK_STATUS_SECTION_IDS } from './sections';

let WorkStatusSectionsDialog: typeof import('./WorkStatusSectionsDialog').WorkStatusSectionsDialog;

describe('section arrangement dialog', () => {
  let win: Window;
  let root: Root;
  let restoreGlobals: () => void;
  let closeCount: number;

  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-settings-item^="chat.work-status.section."]')];
  const order = () => rows().map((row) => row.dataset.settingsItem?.split('.').pop());
  const handle = (index: number) => {
    const button = rows()[index]?.parentElement?.querySelector('button');
    if (!button) throw new Error('Expected a drag handle');
    return button;
  };
  const render = async () => {
    await act(async () => root.render(
      <I18nProvider><WorkStatusSectionsDialog open onOpenChange={() => { closeCount += 1; }} /></I18nProvider>,
    ));
    // happy-dom has no layout. Supply the vertical list geometry used by the
    // real dnd-kit sensors and collision detector, leaving event handling intact.
    rows().forEach((row, index) => {
      const rect = () => new DOMRect(0, index * 36, 400, 36);
      const parent = row.parentElement;
      if (!parent) throw new Error('Expected sortable row');
      parent.getBoundingClientRect = rect;
      handle(index).getBoundingClientRect = rect;
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
    ({ WorkStatusSectionsDialog } = await import('./WorkStatusSectionsDialog'));
    useUIStore.setState({ workStatusSectionOrder: [...WORK_STATUS_SECTION_IDS], workStatusHiddenSections: [] });
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

  test('mouse dragging commits once on drop and leaves visibility alone', async () => {
    const first = handle(0);
    await act(async () => first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 12, clientY: 18 })));
    await act(async () => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 30 })));
    await act(async () => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 12, clientY: 90 })));
    expect(useUIStore.getState().workStatusSectionOrder).toEqual([...WORK_STATUS_SECTION_IDS]);
    await act(async () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    expect(order().slice(0, 3)).toEqual(['repository', 'usage', 'session']);
    expect(useUIStore.getState().workStatusSectionOrder.slice(0, 3)).toEqual(['repository', 'usage', 'session']);
    expect(useUIStore.getState().workStatusHiddenSections).toEqual([]);
    expect(closeCount).toBe(0);
  });

  test('lists an extension section under its own title, toggles it, and keeps unavailable ones saved', async () => {
    await act(async () => {
      useGuestsStore.setState({ guests: [{
        id: 'git-graph', name: 'Git graph', icon: 'git-commit', statusEntry: 'status/index.html', statusTitle: 'Recent commits',
        capabilities: { requested: [], granted: [] },
      }] });
      useUIStore.getState().setWorkStatusSectionOrder(['ext:gone', 'ext:git-graph', 'session']);
    });
    const toggles = () => [...document.querySelectorAll<HTMLElement>('[aria-pressed]')];
    const extensionRow = toggles().find((row) => row.textContent?.includes('Recent commits'));
    if (!extensionRow) throw new Error('Expected the extension row');
    expect(extensionRow.parentElement?.textContent).toContain('Extension');
    expect(toggles().indexOf(extensionRow)).toBe(0);
    await act(async () => extensionRow.click());
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['ext:git-graph']);
    expect(useUIStore.getState().workStatusSectionOrder.slice(0, 3)).toEqual(['ext:gone', 'ext:git-graph', 'session']);
  });

  test('visibility toggles preserve positions and remount restores the arrangement', async () => {
    await act(async () => useUIStore.getState().setWorkStatusSectionOrder(['mcp', 'repository', 'session']));
    const before = order();
    await act(async () => rows()[0].click());
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['mcp']);
    expect(order()).toEqual(before);
    await act(async () => root.render(null));
    await render();
    expect(order()).toEqual(before);
    expect(rows()[0].getAttribute('aria-pressed')).toBe('false');
  });

  test('keyboard reordering supports dropping and cancelling without closing the dialog', async () => {
    handle(0).focus();
    await act(async () => {
      handle(0).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'Space', key: ' ' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'ArrowDown', key: 'ArrowDown' })));
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'Space', key: ' ' })));
    expect(order().slice(0, 2)).toEqual(['repository', 'session']);
    await render();
    handle(0).focus();
    await act(async () => {
      handle(0).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'Space', key: ' ' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'ArrowDown', key: 'ArrowDown' })));
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'Escape', key: 'Escape' })));
    expect(order().slice(0, 2)).toEqual(['repository', 'session']);
    expect(closeCount).toBe(0);
  });

  test('touch requires a hold and commits the same order as mouse dragging', async () => {
    const first = handle(0);
    const touch = (y: number) => new Touch({ identifier: 1, target: first, clientX: 12, clientY: y });
    const dispatch = (type: string, y: number) => first.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch(y)], changedTouches: [touch(y)],
    }));
    await act(async () => dispatch('touchstart', 18));
    await act(async () => dispatch('touchmove', 90));
    await act(async () => dispatch('touchend', 90));
    expect(order()).toEqual([...WORK_STATUS_SECTION_IDS]);
    await act(async () => {
      dispatch('touchstart', 18);
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    await act(async () => dispatch('touchmove', 90));
    await act(async () => dispatch('touchend', 90));
    expect(order().slice(0, 3)).toEqual(['repository', 'usage', 'session']);
  });
});
