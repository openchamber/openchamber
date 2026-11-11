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

async function fixture(initial = '', mode: 'submit' | 'live' = 'submit') {
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
      <SessionSearchInput value={value} mode={mode} debounceMs={100} active={active} onSearch={(query) => { searches.push(query); setValue(query); }}
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

test('typing performs no search or parent render at 15,000 sessions; Enter commits once', async () => {
  const view = await fixture();
  try {
    for (let length = 1; length <= 'Artificial'.length; length += 1) await view.type('Artificial'.slice(0, length));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(view.input.value).toBe('Artificial');
    expect(view.searches).toEqual([]);
    expect(view.visited()).toBe(0);
    expect(view.parentRenders()).toBe(1);
    expect((await view.key('Enter')).defaultPrevented).toBe(true);
    expect(view.searches).toEqual(['Artificial']);
    expect(view.visited()).toBeGreaterThanOrEqual(15_000);
    const visited = view.visited();
    await view.key('Enter', { repeat: true });
    await view.key('Enter');
    expect(view.searches).toHaveLength(1);
    expect(view.visited()).toBe(visited);
  } finally { await view.cleanup(); }
});

const advance = (milliseconds: number) => act(async () => { jest.advanceTimersByTime(milliseconds); });

async function liveFixture(initial = '') {
  jest.useFakeTimers();
  const originalSetTimeout = browser.setTimeout;
  const originalClearTimeout = browser.clearTimeout;
  browser.setTimeout = globalThis.setTimeout;
  browser.clearTimeout = globalThis.clearTimeout;
  const view = await fixture(initial, 'live');
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

test('edits preserve applied results until Enter and clearing applies immediately', async () => {
  const view = await fixture('Artificial');
  try {
    const visited = view.visited();
    await view.type('Different');
    expect(view.visited()).toBe(visited);
    expect(view.searches).toEqual([]);
    await view.clear();
    expect(view.input.value).toBe('');
    expect(view.searches).toEqual(['']);
    await view.type('  Artificial  ');
    await view.key('Enter');
    expect(view.searches.at(-1)).toBe('Artificial');
    await view.type('');
    expect(view.searches.at(-1)).toBe('');
  } finally { await view.cleanup(); }
});

test('IME confirmation does not submit or clear the query', async () => {
  const view = await fixture();
  try {
    await view.compose('compositionstart');
    await view.type('人工');
    expect((await view.key('Enter')).defaultPrevented).toBe(false);
    await view.key('Escape', { isComposing: true });
    expect(view.input.value).toBe('人工');
    await view.compose('compositionend');
    await view.key('Enter', { keyCode: 229 });
    expect(view.searches).toEqual([]);
    await view.key('Enter');
    expect(view.searches).toEqual(['人工']);
  } finally { await view.cleanup(); }
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
  const describedBy = input.getAttribute('aria-describedby');
  const description = describedBy ? browser.document.getElementById(describedBy) : null;
  return { host, input, describedBy, description, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test('every description the field names is rendered', async () => {
  const cases: Array<[string, Partial<React.ComponentProps<typeof SessionSearchInput>>, string | null]> = [
    ['default hints', {}, 'Enter'],
    ['mobile', { mobile: true }, null],
    ['mobile with a match count', { mobile: true, leadingHint: '3 matches' }, null],
    ['compact without a query', { compact: true }, null],
    ['compact with a match count', { compact: true, leadingHint: '3 matches' }, '3 matches'],
  ];
  for (const [name, props, text] of cases) {
    const view = await renderVariant(props);
    try {
      // A named description resolves to a rendered element carrying the expected text.
      expect({ name, describedBy: view.describedBy !== null, resolves: view.description !== null })
        .toEqual({ name, describedBy: text !== null, resolves: text !== null });
      if (text !== null) expect(view.description?.textContent).toContain(text);
    } finally { await view.cleanup(); }
  }
});

test('a compact field shows no shortcut hints and keeps the match count on its own line', async () => {
  const view = await renderVariant({ compact: true, leadingHint: '3 matches', trailingHint: 'Esc to clear' });
  try {
    expect(view.host.textContent).not.toContain('Enter');
    expect(view.host.textContent).not.toContain('Esc to clear');
    expect(view.description?.parentElement).toBe(view.input.parentElement?.parentElement ?? null);
  } finally { await view.cleanup(); }
});

test('chips keep the input mounted and support backspace, commit, and clearing filters', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); const commits: string[] = []; let removals = 0; let clears = 0;
  let setChips: React.Dispatch<React.SetStateAction<React.ReactNode>> = () => { throw new Error('Fixture not mounted'); };
  const Parent = () => {
    const [chips, updateChips] = React.useState<React.ReactNode>(null);
    setChips = updateChips;
    return <SessionSearchInput value="" onSearch={() => {}} onCommit={(text) => commits.push(text)} onRemoveLastChip={() => { removals += 1; }} onClearFilters={() => { clears += 1; }} chips={chips} placeholder="Search sessions" clearLabel="Clear search" />;
  };
  try {
    await act(async () => root.render(<I18nProvider><Parent /></I18nProvider>));
    const input = browser.document.querySelector('input');
    if (!input) throw new Error('Input fixture missing');
    input.focus();
    await act(async () => setChips(<span data-test-chip>Chip</span>));
    expect(host.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
    await act(async () => input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })));
    expect(removals).toBe(1);
    await act(async () => input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(commits).toEqual(['']);
    await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
    expect(clears).toBe(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test('absorbed typed filters clear the draft when the parent value stays empty', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider><SessionSearchInput value="" mode="live" debounceMs={0} onSearch={() => {}} onCommit={() => {}} chips={<span />} placeholder="Search sessions" clearLabel="Clear search" /></I18nProvider>));
    const input = browser.document.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
    if (!input || !setter) throw new Error('Input fixture missing');
    await act(async () => {
      setter.call(input, 'in:archived ');
      input.dispatchEvent(new browser.Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(input.value).toBe('');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
