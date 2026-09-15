import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SidebarHeader } from './SidebarHeader';

const baseProps = {
  hideDirectoryControls: false,
  showProjectDisplayControls: true,
  showRecentControls: true,
  handleOpenDirectoryDialog: () => undefined,
  onOpenScheduled: () => undefined,
  onOpenMultiRun: () => undefined,
  canOpenMultiRun: true,
  onOpenArchive: () => undefined,
  headerActionIconClass: 'h-4.5 w-4.5',
  headerActionButtonClass: 'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed',
  isSessionSearchOpen: false,
  setIsSessionSearchOpen: () => undefined,
  sessionSearchInputRef: React.createRef<HTMLInputElement | null>(),
  sessionSearchQuery: '',
  setSessionSearchQuery: () => undefined,
  hasSessionSearchQuery: false,
  searchMatchCount: 0,
  collapseAllProjects: () => undefined,
  expandAllProjects: () => undefined,
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
});
