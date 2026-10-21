import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { createWebAPIs } from '../../../../../web/src/api/index';
import { WORK_STATUS_SECTION_IDS } from './sections';

// Imported once a DOM exists: the tooltip's layout effects check for one when
// their module loads.
let WorkStatusPanel: typeof import('./WorkStatusPanel').WorkStatusPanel;

// Bootstrap stays pending and every other request fails, so nothing here
// waits on a server; the panel renders from empty stores.
const sdk = OpenCode.make({ baseUrl: 'http://status.test', fetch: () => new Promise<Response>(() => undefined) });

/*
 * The panel has no header row: its sections button is overlaid on the space
 * the first section heading leaves for it. Pinned to the card's corner, it
 * stayed put while the sections scrolled under it, and at 150% and 200% it
 * covered the merge or rebase callout. It now sits in the scrolled content,
 * so it moves with the heading whose space it takes.
 */
describe('work status panel sections button', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  const originalFetch = globalThis.fetch;
  const previousHidden = useUIStore.getState().workStatusHiddenSections;
  const previousExplicit = useUIStore.getState().workStatusHiddenSectionsExplicit;

  const render = async () => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory="/repo">
        <I18nProvider>
          <RuntimeAPIContext.Provider value={createWebAPIs()}>
            <WorkStatusPanel sessionId={null} directory={null} repositoryEnabled={false} visible />
          </RuntimeAPIContext.Provider>
        </I18nProvider>
      </SyncProvider>,
    ));
  };
  const showOnly = (shown: readonly string[]) => useUIStore.setState({
    workStatusHiddenSections: WORK_STATUS_SECTION_IDS.filter((id) => !shown.includes(id)),
    workStatusHiddenSectionsExplicit: true,
  });
  const scroller = () => container.querySelector('[data-scroll-shadow]');
  const sectionsButton = () => container.querySelector('button[aria-label="Choose sections"]');

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, HTMLInputElement: win.HTMLInputElement,
      HTMLIFrameElement: win.HTMLIFrameElement, SVGElement: win.SVGElement,
      Document: win.Document, DocumentFragment: win.DocumentFragment,
      DOMRect: win.DOMRect, Event: win.Event, CustomEvent: win.CustomEvent,
      MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent, FocusEvent: win.FocusEvent,
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
    globalThis.fetch = Object.assign(async () => new Response(null, { status: 503 }), originalFetch);
    ({ WorkStatusPanel } = await import('./WorkStatusPanel'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useUIStore.setState({ workStatusHiddenSections: previousHidden, workStatusHiddenSectionsExplicit: previousExplicit });
    globalThis.fetch = originalFetch;
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('sits in the scrolled content, over the space the first heading leaves for it', async () => {
    showOnly(['session']);
    await render();

    const heading = scroller()?.firstElementChild?.querySelector('[data-work-status-heading]');
    // Positive control: a section rendered in the scroller.
    expect(heading?.textContent).toBe('Session');
    // The first heading keeps room at its end for the button.
    expect(/\[&>section:first-child>\[data-work-status-heading\]\]:pe-\d/.test(scroller()?.className ?? '')).toBe(true);

    const button = sectionsButton();
    // The scroller is the button's containing block, so the button scrolls with
    // the heading instead of staying over whatever scrolls under it.
    expect(button?.parentElement?.hasAttribute('data-scroll-shadow')).toBe(true);
    expect(scroller()?.classList.contains('relative')).toBe(true);
    expect(button?.classList.contains('absolute')).toBe(true);
  });

  test('with every section hidden it sits over the empty state, inside the scroller', async () => {
    showOnly([]);
    await render();

    const empty = [...container.querySelectorAll('span')].find((span) => span.textContent === 'No sections selected');
    expect(empty?.textContent).toBe('No sections selected');
    // An empty scroller is shorter than the button, which would make it
    // scrollable and fade the button under the scroll shadow.
    expect(Boolean(empty?.closest('[data-scroll-shadow]'))).toBe(true);
    expect(sectionsButton()?.parentElement?.hasAttribute('data-scroll-shadow')).toBe(true);
  });
});
