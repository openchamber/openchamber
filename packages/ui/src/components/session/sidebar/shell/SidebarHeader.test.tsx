import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';
import { SidebarHeader } from './SidebarHeader';

const baseProps = {
  hideDirectoryControls: false,
  showProjectDisplayControls: true,
  showRecentControls: true,
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

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    InputEvent: browser.InputEvent,
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
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

  test('a page button opens its page, shows it pressed, and closes it on the next click', async () => {
    const initial = useUIStore.getState();
    try {
      await act(async () => root.render(
        <I18nProvider>
          <TooltipProvider>
            <SidebarHeader {...baseProps} />
          </TooltipProvider>
        </I18nProvider>,
      ));
      const button = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
      for (const [label, isOpen] of [
        ['Archive', () => useUIStore.getState().isArchivePageOpen],
        ['Scheduled tasks', () => useUIStore.getState().isScheduledTasksDialogOpen],
        ['Issues and PRs', () => useUIStore.getState().isSourceBoardOpen],
      ] as const) {
        expect(button(label).getAttribute('aria-pressed')).toBe('false');
        await act(async () => button(label).click());
        expect(isOpen()).toBe(true);
        expect(button(label).getAttribute('aria-pressed')).toBe('true');
        await act(async () => button(label).click());
        expect(isOpen()).toBe(false);
        expect(button(label).getAttribute('aria-pressed')).toBe('false');
      }
    } finally {
      useUIStore.setState(initial);
    }
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
