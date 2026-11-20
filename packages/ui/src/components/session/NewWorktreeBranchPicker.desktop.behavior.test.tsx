import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

/**
 * Import the renderer after installing DOM globals captured by React and Base UI.
 * happy-dom cannot reproduce Chromium's visibility scan; the observer checks
 * commit-time focus, before Base UI's passive focus effect.
 */
type ListEndCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
const listEndObservers = new Set<ListEndCallback>();
class FakeIntersectionObserver {
  constructor(private readonly callback: ListEndCallback) {}
  observe() { listEndObservers.add(this.callback); }
  disconnect() { listEndObservers.delete(this.callback); }
}
const revealListEnd = () => {
  for (const callback of [...listEndObservers]) callback([{ isIntersecting: true }]);
};

const openDesktopDropdown = async (run: (input: HTMLInputElement, selected: { value: string; label: string }[]) => Promise<void>, remoteBranches = ['main'], isMobile = false) => {
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
    IntersectionObserver: FakeIntersectionObserver,
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
          remoteBranches={remoteBranches}
          isLoading={false}
          isMobile={isMobile}
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

    const search = document.querySelector<HTMLInputElement>(isMobile ? 'input[placeholder="Search branches..."]' : 'input[data-slot="command-input"]');
    if (!search) throw new Error('Missing branch search input');
    await run(search, selected);
    if (!isMobile) expect(focusedWhenPopupLanded).toBe('command-input');
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
  test('a long list grows when its end comes into view, on the phone too', async () => {
    const branches = Array.from({ length: 450 }, (_, index) => `origin/branch-${String(index).padStart(3, '0')}`);
    await openDesktopDropdown(async (_search, selected) => {
      const button = (text: string) => [...document.querySelectorAll('button')].find((element) => element.textContent === text);
      expect(button('origin/branch-196')).toBeDefined();
      expect(button('origin/branch-197')).toBeUndefined();
      await act(async () => revealListEnd());
      expect(button('origin/branch-396')).toBeDefined();
      await act(async () => revealListEnd());
      await act(async () => button('origin/branch-449')!.click());
      expect(selected).toEqual([{ value: 'remotes/origin/branch-449', label: 'origin/branch-449' }]);
    }, branches, true);
  });
  test('large branch lists mount a bounded window, grow at the end and reset on search', async () => {
    const branches = Array.from({ length: 450 }, (_, index) => `origin/branch-${String(index).padStart(3, '0')}`);
    await openDesktopDropdown(async (search, selected) => {
      const items = () => [...document.querySelectorAll('[cmdk-item]')];
      expect(items()).toHaveLength(200);
      expect([...document.querySelectorAll('button')].some((element) => element.textContent === 'Next')).toBe(false);
      await act(async () => revealListEnd());
      expect(items()).toHaveLength(400);
      await act(async () => revealListEnd());
      expect(items()).toHaveLength(453);
      expect(items()[452]?.getAttribute('data-value')).toBe('remotes/origin/branch-449');
      await act(async () => {
        search.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'branch-449');
        search.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      expect(items()[0]?.getAttribute('data-value')).toBe('remotes/origin/branch-449');
      await act(async () => search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
      expect(selected).toEqual([{ value: 'remotes/origin/branch-449', label: 'origin/branch-449' }]);
    }, branches);
  });
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
