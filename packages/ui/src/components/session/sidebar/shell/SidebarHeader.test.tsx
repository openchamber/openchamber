import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

// React reads the DOM once when react-dom loads (input-event support among it),
// so the globals go in before react-dom and the components that import it.
const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  MouseEvent: browser.MouseEvent,
  InputEvent: browser.InputEvent,
  KeyboardEvent: browser.KeyboardEvent,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { SidebarHeader } = await import('./SidebarHeader');

const baseProps = {
  hideDirectoryControls: false,
  showProjectDisplayControls: true,
  showSectionControls: true,
  handleOpenDirectoryDialog: () => undefined,
  showSourceBoard: true,
  headerActionIconClass: 'h-4.5 w-4.5',
  headerActionButtonClass: 'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed',
  isSessionSearchOpen: false,
  openSessionSearch: () => undefined,
  closeSessionSearch: () => undefined,
  sessionSearchInputRef: React.createRef<HTMLInputElement | null>(),
  sessionSearchQuery: '',
  setSessionSearchQuery: () => undefined,
  hasSessionSearchQuery: false,
  searchMatchCount: 0,
  collapseAll: () => undefined,
  expandAll: () => undefined,
  showStats: true,
};

function StatefulHeader({
  initialQuery = '',
  ...props
}: Omit<React.ComponentProps<typeof SidebarHeader>, 'sessionSearchQuery' | 'setSessionSearchQuery' | 'hasSessionSearchQuery'> & { initialQuery?: string }) {
  const [query, setQuery] = React.useState(initialQuery);
  return (
    <SidebarHeader
      {...props}
      sessionSearchQuery={query}
      setSessionSearchQuery={setQuery}
      hasSessionSearchQuery={query.trim().toLowerCase().length > 0}
    />
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('SidebarHeader', () => {
  test('compact variant renders a persistent search input and no directory controls', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <StatefulHeader {...baseProps} hideDirectoryControls />
        </TooltipProvider>
      </I18nProvider>,
    ));

    const inputs = document.querySelectorAll('input');
    expect(inputs.length).toBe(1);
    expect(inputs[0]?.getAttribute('placeholder')).toBe('Search sessions...');

    expect(document.querySelector('[aria-label="Search sessions"]')).toBeNull();
    expect(document.querySelector('[aria-label="Add project"]')).toBeNull();
    expect(document.querySelector('[aria-label="Display mode"]')).toBeNull();
  });

  test('compact search keeps one line through every search state', async () => {
    const counts = new Map([['none', 0], ['one', 1], ['many', 3]]);
    function CountingHeader() {
      const [query, setQuery] = React.useState('');
      return (
        <SidebarHeader
          {...baseProps}
          hideDirectoryControls
          sessionSearchQuery={query}
          setSessionSearchQuery={setQuery}
          hasSessionSearchQuery={query.trim().length > 0}
          searchMatchCount={counts.get(query) ?? 0}
        />
      );
    }
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <CountingHeader />
        </TooltipProvider>
      </I18nProvider>,
    ));
    const input = document.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
    if (!input || !setter) throw new Error('Search input missing');
    // The field's wrapper is the header's only line: a count joins it, never a row below.
    const line = () => {
      const field = input.parentElement;
      const search = field?.parentElement;
      const count = search?.querySelector('p') ?? null;
      return {
        children: search ? Array.from(search.children).filter((child) => child !== field && child !== count).length : -1,
        count: count?.textContent ?? null,
        countOnFieldLine: count === null || count.parentElement === search,
        text: search?.textContent ?? '',
      };
    };
    const submit = async (query: string) => {
      await act(async () => {
        setter.call(input, query);
        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      });
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    };

    expect(line().count).toBeNull();
    expect(line().children).toBe(0);
    expect(line().text).not.toContain('Press Enter to search');
    expect(line().text).not.toContain('Esc to clear');
    for (const [query, expected] of [['none', '0 matches'], ['one', '1 match'], ['many', '3 matches']] as const) {
      await submit(query);
      expect(line().count).toBe(expected);
      expect(line().countOnFieldLine).toBe(true);
      expect(line().children).toBe(0);
    }
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')?.click();
    });
    expect(line().count).toBeNull();
    expect(line().children).toBe(0);
  });

  test('compact variant clears the search query with the clear button', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <StatefulHeader {...baseProps} hideDirectoryControls initialQuery="draft" />
        </TooltipProvider>
      </I18nProvider>,
    ));

    const input = document.querySelector('input')!;
    expect(input.value).toBe('draft');

    const clearButton = document.querySelector<HTMLButtonElement>('[aria-label="Clear search"]');
    expect(clearButton).not.toBeNull();
    await act(async () => clearButton!.click());
    expect(input.value).toBe('');
  });

  test('compact variant applies the query on Enter, not on every keystroke', async () => {
    const submitted: string[] = [];
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarHeader {...baseProps} hideDirectoryControls setSessionSearchQuery={(value) => submitted.push(value)} />
        </TooltipProvider>
      </I18nProvider>,
    ));

    const input = document.querySelector('input')!;
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'abc');
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    expect(submitted).toEqual([]);

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(submitted).toEqual(['abc']);
  });

  test('full variant renders directory controls and hides the search input until opened', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarHeader {...baseProps} />
        </TooltipProvider>
      </I18nProvider>,
    ));

    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelector('[aria-label="Search sessions"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Add project"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Display mode"]')).not.toBeNull();
  });

  test('the row holds the list controls and one More menu, and no page buttons', async () => {
    await act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarHeader {...baseProps} />
        </TooltipProvider>
      </I18nProvider>,
    ));
    const labels = [...document.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['Search sessions', 'Add project', 'Display mode', 'More']);
  });

  test('the search button opens the field and, once open, closes it', async () => {
    let opened = 0;
    let closed = 0;
    const render = (isSessionSearchOpen: boolean) => act(async () => root.render(
      <I18nProvider>
        <TooltipProvider>
          <SidebarHeader {...baseProps} isSessionSearchOpen={isSessionSearchOpen} openSessionSearch={() => { opened += 1; }} closeSessionSearch={() => { closed += 1; }} />
        </TooltipProvider>
      </I18nProvider>,
    ));
    const button = () => document.querySelector<HTMLButtonElement>('[aria-label="Search sessions"]')!;
    await render(false);
    await act(async () => button().click());
    expect([opened, closed]).toEqual([1, 0]);
    await render(true);
    expect(button().getAttribute('aria-expanded')).toBe('true');
    await act(async () => button().click());
    expect([opened, closed]).toEqual([1, 1]);
  });
});
