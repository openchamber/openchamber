import { afterAll, expect, jest, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { rankByQuery } from '@/lib/search/fuzzySearch';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { SessionSearchInput } = await import('./SessionSearchInput');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function fixture(initial = '') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const searches: string[] = [];
  let closes = 0;
  let parentRenders = 0;
  let visited = 0;
  const sessions = Array.from({ length: 15_000 }, (_, index) => ({ title: `Artificial session ${index}` }));
  let setExternalValue: React.Dispatch<React.SetStateAction<string>> = () => { throw new Error('Fixture not mounted'); };
  let setActive: React.Dispatch<React.SetStateAction<boolean>> = () => { throw new Error('Fixture not mounted'); };
  const Parent = () => {
    parentRenders += 1;
    const [value, setValue] = React.useState(initial);
    const [active, updateActive] = React.useState(true);
    setExternalValue = setValue;
    setActive = updateActive;
    const results = React.useMemo(() => value ? rankByQuery(sessions, value, (session) => {
      visited += 1;
      return [session.title];
    }) : sessions, [value]);
    return <>
      <SessionSearchInput value={value} debounceMs={100} active={active} onSearch={(query) => { searches.push(query); setValue(query); }}
        onClose={() => { closes += 1; }} placeholder="Search sessions" clearLabel="Clear search" />
      <output>{results.length}</output>
    </>;
  };
  await act(async () => root.render(<I18nProvider><Parent /></I18nProvider>));
  const input = browser.document.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Input fixture missing');
  return {
    searches, input,
    parentRenders: () => parentRenders,
    visited: () => visited,
    closes: () => closes,
    type: (text: string) => act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new browser.Event('input', { bubbles: true }));
      input.dispatchEvent(new browser.Event('change', { bubbles: true }));
    }),
    key: async (key: string, options: Pick<KeyboardEventInit, 'repeat' | 'keyCode' | 'isComposing'> = {}) => {
      const event = new browser.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
      await act(async () => { input.dispatchEvent(event); });
      return event;
    },
    compose: (type: 'compositionstart' | 'compositionend') => act(async () => {
      input.dispatchEvent(new browser.CompositionEvent(type, { bubbles: true }));
    }),
    clear: () => act(async () => {
      const button = browser.document.querySelector('button');
      if (!button) throw new Error('Clear button missing');
      button.click();
    }),
    external: (value: string) => act(async () => { setExternalValue(value); }),
    active: (value: boolean) => act(async () => { setActive(value); }),
    cleanup: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

const advance = (milliseconds: number) => act(async () => { jest.advanceTimersByTime(milliseconds); });

async function liveFixture(initial = '') {
  jest.useFakeTimers();
  const originalSetTimeout = browser.setTimeout;
  const originalClearTimeout = browser.clearTimeout;
  browser.setTimeout = globalThis.setTimeout;
  browser.clearTimeout = globalThis.clearTimeout;
  const view = await fixture(initial);
  return {
    ...view,
    restore: () => {
      browser.setTimeout = originalSetTimeout;
      browser.clearTimeout = originalClearTimeout;
      jest.useRealTimers();
    },
  };
}

test('live typing debounces the trimmed query and restarts after each edit', async () => {
  const view = await liveFixture();
  try {
    expect(document.querySelector('[data-session-search-input]')).not.toBeNull();
    await view.type('old');
    await advance(99);
    expect(view.searches).toEqual([]);
    await view.type('  committed  ');
    await advance(99);
    expect(view.searches).toEqual([]);
    await advance(1);
    expect(view.searches).toEqual(['committed']);
  } finally { await view.cleanup(); view.restore(); }
});

test('live Enter flushes once and clear cancels pending work immediately', async () => {
  const view = await liveFixture();
  try {
    await view.type('query');
    await view.key('Enter');
    expect(view.searches).toEqual(['query']);
    await advance(100);
    expect(view.searches).toEqual(['query']);
    await view.type('outdated');
    await view.clear();
    expect(view.searches).toEqual(['query', '']);
    await advance(100);
    expect(view.searches).toEqual(['query', '']);
    await view.external('applied');
    await view.type('   ');
    expect(view.searches.at(-1)).toBe('');
  } finally { await view.cleanup(); view.restore(); }
});

test('live timers cancel on external value changes and inactive input', async () => {
  const view = await liveFixture();
  try {
    await view.type('pending');
    await view.external('external');
    await advance(100);
    expect(view.searches).toEqual([]);
    expect(view.input.value).toBe('external');
    await view.type('hidden');
    await view.active(false);
    await advance(100);
    await view.type('inactive');
    await advance(100);
    expect(view.searches).toEqual([]);
  } finally { await view.cleanup(); view.restore(); }
});

test('live unmount cancels pending search', async () => {
  const view = await liveFixture();
  try {
    await view.type('pending');
    await view.cleanup();
    await advance(100);
    expect(view.searches).toEqual([]);
  } finally { view.restore(); }
});

test('live IME cancels precomposition work and commits without another keystroke', async () => {
  const view = await liveFixture();
  try {
    await view.type('outdated');
    await advance(50);
    await view.compose('compositionstart');
    await view.type('人工');
    await advance(100);
    await view.key('Enter', { isComposing: true });
    expect(view.searches).toEqual([]);
    await view.compose('compositionend');
    await advance(99);
    expect(view.searches).toEqual([]);
    await advance(1);
    expect(view.searches).toEqual(['人工']);
    await view.compose('compositionstart');
    await view.type('');
    expect(view.searches).toEqual(['人工']);
    await view.compose('compositionend');
    expect(view.searches).toEqual(['人工', '']);
    await advance(100);
    expect(view.searches).toEqual(['人工', '']);
  } finally { await view.cleanup(); view.restore(); }
});

test('Escape clears the draft first, then closes; external resets replace unsent text', async () => {
  const view = await fixture();
  try {
    await view.type('unsent');
    await view.key('Escape');
    expect(view.input.value).toBe('');
    expect(view.closes()).toBe(0);
    expect(view.searches).toEqual([]);
    await view.key('Escape');
    expect(view.closes()).toBe(1);
    await view.type('draft');
    await view.active(false);
    await view.type('late hidden input');
    await view.key('Enter');
    expect(view.searches).toEqual([]);
    await view.active(true);
    expect(view.input.value).toBe('');
    await view.external('Artificial');
    await view.type('unsent edit');
    await view.external('');
    expect(view.input.value).toBe('');
  } finally { await view.cleanup(); }
});

async function renderVariant(props: Partial<React.ComponentProps<typeof SessionSearchInput>>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<I18nProvider>
    <SessionSearchInput value="" onSearch={() => undefined} placeholder="Search sessions" clearLabel="Clear search" {...props} />
  </I18nProvider>));
  const input = host.querySelector('input');
  if (!input) throw new Error('Input fixture missing');
  return { host, input, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test('trailing controls sit inside the field, before the clear button', async () => {
  const view = await renderVariant({ value: 'query', trailing: <span data-test-trailing>3</span> });
  try {
    const field = view.host.querySelector('[data-session-search-input]');
    const trailing = view.host.querySelector('[data-test-trailing]');
    const clear = view.host.querySelector('button[aria-label="Clear search"]');
    expect(trailing?.parentElement).toBe(field);
    expect(clear?.parentElement).toBe(field);
    expect(trailing && clear ? Boolean(trailing.compareDocumentPosition(clear) & 4) : false).toBe(true);
  } finally { await view.cleanup(); }
});

test('an empty field offers no clear button', async () => {
  const view = await renderVariant({});
  try {
    expect(view.host.querySelector('button')).toBeNull();
  } finally { await view.cleanup(); }
});

test('a quiet field rests without field chrome and takes it once focused or filled', async () => {
  const resting = await renderVariant({ quiet: true });
  try {
    const field = resting.host.querySelector('[data-session-search-input]');
    expect(field?.className).not.toContain('oc-field');
    await act(async () => { resting.input.focus(); });
    expect(field?.className).toContain('oc-field');
  } finally { await resting.cleanup(); }
  const filled = await renderVariant({ quiet: true, value: 'query' });
  try {
    expect(filled.host.querySelector('[data-session-search-input]')?.className).toContain('oc-field');
  } finally { await filled.cleanup(); }
});

test('the label names the field when the placeholder is a short word', async () => {
  const view = await renderVariant({ placeholder: 'Search', label: 'Search sessions' });
  try {
    expect(view.input.getAttribute('aria-label')).toBe('Search sessions');
    expect(view.input.getAttribute('placeholder')).toBe('Search');
  } finally { await view.cleanup(); }
});

test('a space typed before the debounce fires survives the commit', async () => {
  const view = await liveFixture();
  try {
    await view.type('hello ');
    await advance(100);
    expect(view.searches).toEqual(['hello']);
    // The parent now holds "hello"; the field still ends with the space.
    expect(view.input.value).toBe('hello ');
    await view.type('hello world');
    await advance(100);
    expect(view.searches).toEqual(['hello', 'hello world']);
  } finally { await view.cleanup(); view.restore(); }
});

test('a press on the field outside its input and buttons puts the caret in the input', async () => {
  const view = await renderVariant({ quiet: true, value: 'query' });
  try {
    const field = browser.document.querySelector('[data-session-search-input]');
    const press = new browser.Event('mousedown', { bubbles: true, cancelable: true });
    await act(async () => { field?.dispatchEvent(press); });
    expect(press.defaultPrevented).toBe(true);
    expect(browser.document.activeElement).toBe(view.input);
    // A press on the clear button is the button's own.
    const onButton = new browser.Event('mousedown', { bubbles: true, cancelable: true });
    await act(async () => { browser.document.querySelector('button')?.dispatchEvent(onButton); });
    expect(onButton.defaultPrevented).toBe(false);
  } finally { await view.cleanup(); }
});
