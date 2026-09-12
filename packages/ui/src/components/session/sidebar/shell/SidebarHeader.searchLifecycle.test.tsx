import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

/**
 * Search lifecycle for the real SidebarHeader.
 *
 * happy-dom is used instead of the hook test DOM because these cases are
 * driven by real keydown/click events: React delegates events from the root
 * container, and the hook test DOM's container has a no-op
 * `addEventListener`, so synthetic events could never reach the component.
 *
 * The harness mirrors SessionSidebar's wiring: raw query state plus the real
 * 120ms debounce, with `hasSessionSearchQuery` derived the same way the
 * sidebar derives it. That makes the Escape decisions below the production
 * ones instead of a simplified boolean.
 */

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  location: browser.location,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  Node: browser.Node,
  customElements: browser.customElements,
  CSSStyleSheet: browser.CSSStyleSheet,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// React DOM detects input-event support when imported, so install the DOM first.
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useDebouncedValue } = await import('@/hooks/useDebouncedValue');
const { SidebarHeader } = await import('./SidebarHeader');

const noop = (): void => undefined;

type HeaderControls = {
  query: string;
  open: boolean;
  inputRef: React.RefObject<HTMLInputElement | null> | null;
  resetSessionSearch: (() => void) | null;
};

const HeaderHarness = ({ controls }: { controls: HeaderControls }) => {
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(true);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Same derivation as SessionSidebar: the debounced query decides whether the
  // header treats a query as active.
  const debouncedQuery = useDebouncedValue(query, 120);
  const hasSessionSearchQuery = debouncedQuery.trim().toLowerCase().length > 0;
  const resetSessionSearch = React.useCallback(() => {
    setQuery((current) => (current.length === 0 ? current : ''));
    setOpen((current) => (current ? false : current));
  }, []);
  controls.query = query;
  controls.open = open;
  controls.inputRef = inputRef;
  controls.resetSessionSearch = resetSessionSearch;
  return (
    <SidebarHeader
      hideDirectoryControls={false}
      showProjectDisplayControls={false}
      showRecentControls={false}
      handleOpenDirectoryDialog={noop}
      onOpenScheduled={noop}
      onOpenMultiRun={noop}
      canOpenMultiRun={false}
      onOpenArchive={noop}
      headerActionIconClass="h-4 w-4"
      headerActionButtonClass=""
      isSessionSearchOpen={open}
      setIsSessionSearchOpen={setOpen}
      sessionSearchInputRef={inputRef}
      sessionSearchQuery={query}
      setSessionSearchQuery={setQuery}
      hasSessionSearchQuery={hasSessionSearchQuery}
      searchMatchCount={0}
      collapseAllProjects={noop}
      expandAllProjects={noop}
    />
  );
};

let root: Root;
let controls: HeaderControls;

beforeEach(() => {
  controls = { query: '', open: true, inputRef: null, resetSessionSearch: null };
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const renderHeader = async (): Promise<void> => {
  await act(async () => {
    root.render(<I18nProvider><HeaderHarness controls={controls} /></I18nProvider>);
  });
};

const requireInput = () => {
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('search input is not mounted');
  return input;
};

const requireSearchToggle = () => {
  const toggle = [...browser.document.querySelectorAll('button')].find(
    (candidate) => /search/i.test(candidate.getAttribute('aria-label') ?? ''),
  );
  if (!toggle) throw new Error('search toggle is not mounted');
  return toggle;
};

const typeQuery = async (query: string): Promise<void> => {
  const input = requireInput();
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('input value setter is unavailable');
  await act(async () => {
    setValue.call(input, query);
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
    input.dispatchEvent(new browser.Event('change', { bubbles: true }));
  });
};

const pressEscape = async (): Promise<void> => {
  const input = requireInput();
  await act(async () => {
    input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
};

const flushDebounce = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
  });
};

describe('SidebarHeader search lifecycle', () => {
  test('Escape clears a settled query on the same keypress and a later Escape closes', async () => {
    await renderHeader();
    await typeQuery('release');
    expect(requireInput().value).toBe('release');

    await flushDebounce();

    await pressEscape();
    expect(controls.query).toBe('');
    expect(controls.open).toBe(true);
    expect(requireInput().value).toBe('');

    await flushDebounce();

    await pressEscape();
    expect(controls.open).toBe(false);
    expect(document.querySelector('input')).toBeNull();
  });

  test('Escape clears typed text before the debounce settles and keeps search open', async () => {
    await renderHeader();
    await typeQuery('release');
    // The debounced hasSessionSearchQuery flag is still false here; the raw
    // input value decides, so the first Escape clears instead of closing.
    await pressEscape();

    expect(controls.query).toBe('');
    expect(controls.open).toBe(true);
    expect(requireInput().value).toBe('');

    await flushDebounce();
    expect(controls.open).toBe(true);
  });

  test('Escape on an empty input closes search', async () => {
    await renderHeader();
    expect(requireInput().value).toBe('');

    await pressEscape();
    expect(controls.open).toBe(false);
    expect(document.querySelector('input')).toBeNull();
  });

  test('a query cleared with Escape does not reappear on reopen', async () => {
    await renderHeader();
    await typeQuery('release');

    await pressEscape();
    expect(controls.query).toBe('');
    await pressEscape();
    expect(controls.open).toBe(false);

    await act(async () => {
      requireSearchToggle().click();
    });
    expect(controls.open).toBe(true);
    expect(requireInput().value).toBe('');
  });

  test('the clear button clears the query and keeps the search open', async () => {
    await renderHeader();
    await typeQuery('release');
    await flushDebounce();

    const input = requireInput();
    const clearButton = input.parentElement?.querySelector('button');
    if (!clearButton) throw new Error('clear button is not mounted');
    await act(async () => {
      clearButton.click();
    });

    expect(controls.query).toBe('');
    expect(controls.open).toBe(true);
    expect(requireInput().value).toBe('');
  });

  test('resetting search from a row closes it and reopening shows an empty input', async () => {
    await renderHeader();
    await typeQuery('release');
    await flushDebounce();

    await act(async () => {
      controls.resetSessionSearch?.();
    });
    expect(controls.query).toBe('');
    expect(controls.open).toBe(false);
    expect(document.querySelector('input')).toBeNull();

    await act(async () => {
      requireSearchToggle().click();
    });
    expect(controls.open).toBe(true);
    expect(requireInput().value).toBe('');
  });

  test('the search toggle keeps aria-expanded in sync with the input', async () => {
    await renderHeader();
    expect(requireSearchToggle().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('input')).not.toBeNull();

    await act(async () => {
      requireSearchToggle().click();
    });
    expect(requireSearchToggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('input')).toBeNull();

    await act(async () => {
      requireSearchToggle().click();
    });
    expect(requireSearchToggle().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('input')).not.toBeNull();
  });
});
