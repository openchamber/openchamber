import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

/**
 * The desktop "Based on" dropdown.
 *
 * Two things are pinned here. The search field holds the focus as soon as the
 * dropdown opens, and Escape still closes the dropdown while the field has
 * that focus.
 *
 * The renderer and the component are imported inside the test, after the DOM
 * globals are in place: React's renderer and Base UI capture the document and
 * the animation frame they see first, and a component imported earlier never
 * opens its popup under happy-dom.
 *
 * On the focus assertion: happy-dom has no checkVisibility(), so Base UI's
 * tabbable scan behaves there differently than in a browser. What this test
 * pins is the *timing* — the field is focused in the commit that opens the
 * popup, not a frame later. Without the explicit request the focus manager
 * reaches the field from a passive effect, and the field is not focused yet
 * when the popup lands. It is not a measurement of the browser's scan.
 */
const openDesktopDropdown = async (run: (input: HTMLInputElement) => Promise<void>) => {
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
  // The field is focused in the commit the popup lands in, so the reading has
  // to happen there: Base UI's focus manager reaches the field a frame later,
  // from a passive effect, and the two are told apart by that.
  let focusedWhenPopupLanded: string | null | undefined = 'never-observed';
  try {
    await act(async () => root.render(
      <I18nProvider>
        <NewWorktreeBranchPicker
          value=""
          placeholder="Choose a branch…"
          title="Based on"
          localBranches={['main', 'feature/one']}
          remoteBranches={['main']}
          isLoading={false}
          isMobile={false}
          onSelect={() => undefined}
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
    await run(search);
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
  test('the search field holds the focus when the dropdown opens', async () => {
    await openDesktopDropdown(async (search) => {
      // Compared as text, not as DOM nodes: matching two DOM nodes with
      // expect(...).toBe(...) never returns when they differ.
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
      // Base UI closes the menu on Escape from a document-level listener, so the
      // key has to travel past the field's own handler to reach it.
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 50)); });
      // Compared as booleans, not as DOM nodes: matching a DOM node with
      // expect(...).toBeNull() never returns when the node is there.
      expect(document.querySelector('[data-slot="dropdown-menu-content"]') === null).toBe(true);
      expect(document.querySelector('input[data-slot="command-input"]') === null).toBe(true);
    });
  });

  test('Escape during IME composition leaves the dropdown open', async () => {
    await openDesktopDropdown(async (search) => {
      // Base UI's dismiss handling sits on the popup and on the document
      // (useDismiss attaches it to both). The dropdown staying open is what
      // shows that the popup's handler never saw the key; the document
      // listener shows it never travelled past the field's own handler either.
      const seen: string[] = [];
      const listener = (event: Event) => seen.push((event as KeyboardEvent).key);
      document.addEventListener('keydown', listener);
      try {
        await act(async () => {
          const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
          // The native event reports a composition in progress, the shape the
          // app's own composition check reads.
          Object.defineProperty(event, 'isComposing', { value: true });
          search.dispatchEvent(event);
        });
      } finally {
        document.removeEventListener('keydown', listener);
      }
      // The composition owns this Escape: it stops at the field, so the
      // dropdown stays open and the key never reaches the dismiss handling.
      expect(seen).toEqual([]);
      expect(document.querySelector('[data-slot="dropdown-menu-content"]') !== null).toBe(true);
    });
  });
});
