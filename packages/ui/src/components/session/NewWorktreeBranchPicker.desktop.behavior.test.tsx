import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

/**
 * Import the renderer after installing DOM globals captured by React and Base UI.
 * happy-dom cannot reproduce Chromium's visibility scan; the observer checks
 * commit-time focus, before Base UI's passive focus effect.
 */
const openDesktopDropdown = async (run: (input: HTMLInputElement, selected: { value: string; label: string }[]) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    location: dom.location,
    localStorage: dom.localStorage,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Node: dom.Node,
    Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { NewWorktreeBranchPicker } = await import('./NewWorktreeBranchPicker');
  const { I18nProvider } = await import('@/lib/i18n');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let focusedWhenPopupLanded: string | null | undefined = 'never-observed';
  const selected: { value: string; label: string }[] = [];
  try {
    await act(async () => root.render(
      <I18nProvider>
        <NewWorktreeBranchPicker
          value=""
          placeholder="Choose a branch…"
          title="Based on"
           localBranches={['main', 'feature/one', 'feature/two']}
          remoteBranches={['main']}
          isLoading={false}
          isMobile={false}
           onSelect={(branch) => selected.push(branch)}
        />
      </I18nProvider>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('button');
    if (!trigger) throw new Error('Missing branch trigger');

    const observer = new MutationObserver(() => {
      if (!document.querySelector('input[data-slot="command-input"]')) return;
      focusedWhenPopupLanded = document.activeElement?.getAttribute('data-slot');
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // The menu opens on mousedown.
    await act(async () => {
      const pointerInit: PointerEventInit = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse' };
      const mouseInit: MouseEventInit = { bubbles: true, cancelable: true, button: 0 };
      trigger.dispatchEvent(new window.PointerEvent('pointerdown', pointerInit));
      trigger.dispatchEvent(new window.MouseEvent('mousedown', mouseInit));
      trigger.dispatchEvent(new window.PointerEvent('pointerup', pointerInit));
      trigger.dispatchEvent(new window.MouseEvent('mouseup', mouseInit));
      trigger.dispatchEvent(new window.MouseEvent('click', mouseInit));
    });
    observer.disconnect();

    const search = document.querySelector<HTMLInputElement>('input[data-slot="command-input"]');
    if (!search) throw new Error('Missing branch search input');
    await run(search, selected);
    expect(focusedWhenPopupLanded).toBe('command-input');
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

describe('NewWorktreeBranchPicker desktop dropdown', () => {
  for (const keys of [['ArrowDown', 'ArrowUp'], ['n', 'p']]) {
    test(`${keys.join('/')} navigate filtered branches and Enter selects from the focused search`, async () => {
      await openDesktopDropdown(async (search, selected) => {
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
          setter.call(search, 'feature');
          search.dispatchEvent(new window.Event('input', { bubbles: true }));
        });
        const activeValue = () => document.querySelector('[data-slot="command-item"][data-selected="true"]')?.getAttribute('data-value');
        expect(activeValue()).toBe('feature/one');
        for (const [index, key] of keys.entries()) {
          await act(async () => {
            search.dispatchEvent(new window.KeyboardEvent('keydown', {
              key, ctrlKey: key.length === 1, bubbles: true, cancelable: true,
            }));
          });
          expect(activeValue()).toBe(index === 0 ? 'feature/two' : 'feature/one');
          expect(document.activeElement === search).toBe(true);
        }
        await act(async () => {
          search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        expect(selected).toEqual([{ value: 'feature/one', label: 'feature/one' }]);
        expect(document.querySelector('[data-slot="dropdown-menu-content"]') === null).toBe(true);
      });
    });
  }

  test('the search field holds the focus when the dropdown opens', async () => {
    await openDesktopDropdown(async (search) => {
      expect(document.activeElement?.getAttribute('data-slot')).toBe('command-input');
      expect(document.activeElement === search).toBe(true);
    });
  });

  test('Escape closes the dropdown while the search field holds the focus', async () => {
    await openDesktopDropdown(async (search) => {
      expect(document.activeElement === search).toBe(true);
      await act(async () => {
        search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 50)); });
      expect(document.querySelector('[data-slot="dropdown-menu-content"]') === null).toBe(true);
      expect(document.querySelector('input[data-slot="command-input"]') === null).toBe(true);
    });
  });

  test('Escape during IME composition leaves the dropdown open', async () => {
    await openDesktopDropdown(async (search) => {
      const seen: string[] = [];
      const listener = (event: Event) => seen.push((event as KeyboardEvent).key);
      document.addEventListener('keydown', listener);
      try {
        await act(async () => {
          const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
          Object.defineProperty(event, 'isComposing', { value: true });
          search.dispatchEvent(event);
        });
      } finally {
        document.removeEventListener('keydown', listener);
      }
      expect(seen).toEqual([]);
      expect(document.querySelector('[data-slot="dropdown-menu-content"]') !== null).toBe(true);
    });
  });
});
