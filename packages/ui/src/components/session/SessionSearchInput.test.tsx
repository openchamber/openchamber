import { afterAll, expect, test } from 'bun:test';
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
      <SessionSearchInput value={value} active={active} onSearch={(query) => { searches.push(query); setValue(query); }}
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
