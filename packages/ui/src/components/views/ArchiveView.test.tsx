import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@opencode-ai/sdk/v2';
const browser = new Window({ url: 'http://localhost' });
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
// React DOM detects input-event support when imported, so install the DOM first.
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { ArchiveView } = await import('./ArchiveView');
const initialUI = useUIStore.getState();
const initialSessions = useGlobalSessionsStore.getState();
const session = (id: string, title: string, archived = 2): Session => ({
  id, title, slug: id, projectID: 'project', version: '1', directory: '/workspace',
  time: { created: 1, updated: 1, archived },
});

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUIStore.setState({ isArchivePageOpen: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState(initialUI);
  useGlobalSessionsStore.setState(initialSessions);
  document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('archive search uses exact IDs and preserves title search and archive membership', async () => {
  const id = 'ses_f88b1a2b3c4d';
  useGlobalSessionsStore.setState({
    archivedSessions: [session(id, 'Release notes'), session('ses_f88b1a2b3c4e', id)],
    activeSessions: [session('ses_active', 'Active session', 0)],
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Archive search input missing');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Input value setter missing');
  const search = async (query: string) => {
    await act(async () => {
      setValue.call(input, query);
      input.dispatchEvent(new browser.Event('input', { bubbles: true }));
      input.dispatchEvent(new browser.Event('change', { bubbles: true }));
    });
    return [...document.querySelectorAll('[role="button"] > span:first-child')].map((row) => row.textContent);
  };
  expect(await search(id)).toEqual(['Release notes']);
  expect(await search(`  ${id.toUpperCase()}  `)).toEqual(['Release notes']);
  for (const query of ['ses_', 'ses_f88b', 'ses_f88b1a2b3c4f', `${id}x`, `${id} error`, 'ses_active']) {
    expect(await search(query)).toEqual([]);
  }
  expect(await search('release')).toEqual(['Release notes']);
  expect(await search('releaze')).toEqual(['Release notes']);
  expect(await search('')).toHaveLength(2);
});
