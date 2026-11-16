import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, CustomEvent: browser.CustomEvent, navigator: browser.navigator,
  localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Node: browser.Node, Text: browser.Text, Document: browser.Document, DocumentFragment: browser.DocumentFragment,
  ShadowRoot: browser.ShadowRoot, MutationObserver: browser.MutationObserver, SVGElement: browser.SVGElement,
  Event: browser.Event, KeyboardEvent: browser.KeyboardEvent,
  ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ data: [], project: { directory: '/project' } });
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { getEffectiveShortcutCombo, shortcutRegistry, ShortcutDispatcher } = await import('@/lib/shortcuts');
const { isMacOS } = await import('@/lib/utils');
const { KeyboardShortcutsSettings } = await import('./KeyboardShortcutsSettings');

type KeyOptions = { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean };

const mod = isMacOS() ? { metaKey: true } : { ctrlKey: true };
const letter = (key: string) => ({ key, code: `Key${key.toUpperCase()}` });
const digit = (key: string) => ({ key, code: `Digit${key}` });
const backspace = { key: 'Backspace', code: 'Backspace' };

let root: ReturnType<typeof createRoot>;
let dispatcher: InstanceType<typeof ShortcutDispatcher>;

// The dispatcher's second-key route in window capture (useKeyboardShortcuts).
const dispatchActivePrefix = (event: KeyboardEvent) => {
  if (!dispatcher.hasActivePrefix()) return;
  if (dispatcher.dispatchActivePrefix(event)) event.stopPropagation();
};

const searchInput = () => {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Search"]');
  if (!input) throw new Error('Search input missing');
  return input;
};
const button = (label: string) => {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`${label} button missing`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());
const press = (options: KeyOptions) => act(async () => {
  searchInput().dispatchEvent(new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true }));
});
const visibleRows = () => [...document.querySelectorAll<HTMLElement>('[data-settings-item^="shortcuts.action."]')]
  .map((row) => row.dataset.settingsItem?.replace('shortcuts.action.', ''));
const renderPage = () => act(async () => root.render(<I18nProvider><KeyboardShortcutsSettings /></I18nProvider>));

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  dispatcher = new ShortcutDispatcher({ registry: shortcutRegistry, getBinding: (actionId) => getEffectiveShortcutCombo(actionId) });
  window.addEventListener('keydown', dispatchActivePrefix, true);
});
afterEach(async () => {
  window.removeEventListener('keydown', dispatchActivePrefix, true);
  await act(async () => root.unmount());
  document.body.replaceChildren();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const findByKeyCases: Array<[string, KeyOptions[], string]> = [
  ['a sequence ending in Backspace', [{ ...letter('k'), ...mod }, backspace], 'archive_current_session'],
  ['a sequence ending in Backspace with the leader modifier held', [{ ...letter('k'), ...mod }, { ...backspace, ...mod }], 'archive_current_session'],
  ['a modified Backspace', [{ ...backspace, ...mod }], 'sessions_bulk_delete'],
  ['an Alt Backspace', [{ ...backspace, altKey: true }], 'permission_deny'],
  ['a session tab digit', [{ ...digit('3'), ...mod }], 'switch_session_tab'],
  ['a context surface digit', [{ ...digit('3'), ...mod, altKey: true }], 'switch_context_surface'],
  ['a one-chord binding', [{ ...letter('v'), ...mod, altKey: true }], 'toggle_dictation'],
  ['a two-chord binding', [{ ...letter('k'), ...mod }, letter('n')], 'toggle_prompt_navigator'],
];
for (const [name, keys, actionId] of findByKeyCases) {
  test(`Find by key finds ${name}`, async () => {
    await renderPage();
    await click(button('Find by key'));
    for (const key of keys) await press(key);
    expect(visibleRows()).toEqual([actionId]);
  });
}

test('Backspace stays recorded and the clear control empties the filter', async () => {
  await renderPage();
  const allRows = visibleRows().length;
  await click(button('Find by key'));
  await press({ ...backspace, ...mod });
  await press(backspace);
  expect(visibleRows()).toEqual([]);
  expect(document.body.textContent).toContain('Nothing matches');
  expect(document.body.textContent).not.toContain('Nothing matches “”');
  await click(button('Clear search'));
  expect(visibleRows()).toHaveLength(allRows);
});

test('text search does not match the unassigned marker', async () => {
  await renderPage();
  const input = searchInput();
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Input value setter missing');
  await act(async () => {
    setValue.call(input, 'signed');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(visibleRows()).toEqual([]);
});

test('a sequence armed before recording does not run a command while the field records', async () => {
  let opened = 0;
  const unregister = shortcutRegistry.register('open_timeline_dialog', () => { opened += 1; });
  try {
    await renderPage();
    const arm = () => dispatcher.dispatch(new KeyboardEvent('keydown', { ...letter('k'), ...mod, cancelable: true }));

    expect(arm()).toBe(true);
    await press({ ...letter('t'), ...mod });
    expect(opened).toBe(1);

    expect(arm()).toBe(true);
    await click(button('Find by key'));
    await press({ ...letter('t'), ...mod });
    expect(opened).toBe(1);
  } finally {
    unregister();
  }
});

test('shortcuts resume on blur, mode exit and unmount', async () => {
  await renderPage();
  await click(button('Find by key'));
  expect(shortcutRegistry.isSuspended()).toBe(true);

  await act(async () => searchInput().blur());
  expect(shortcutRegistry.isSuspended()).toBe(false);
  await act(async () => searchInput().focus());
  expect(shortcutRegistry.isSuspended()).toBe(true);

  await click(button('Find by key'));
  expect(shortcutRegistry.isSuspended()).toBe(false);

  await click(button('Find by key'));
  expect(shortcutRegistry.isSuspended()).toBe(true);
  await act(async () => root.unmount());
  expect(shortcutRegistry.isSuspended()).toBe(false);
  root = createRoot(document.createElement('div'));
});
