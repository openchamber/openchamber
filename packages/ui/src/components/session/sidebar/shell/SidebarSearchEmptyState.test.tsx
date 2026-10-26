import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { SidebarSearchEmptyState } from './SidebarSearchEmptyState';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const initialUI = useUIStore.getState();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
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
  useUIStore.setState(initialUI);
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const archiveButton = () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Search the archive') ?? null;

test('hands the query to the Archive page and clears the sidebar search', async () => {
  let resets = 0;
  await act(async () => root.render(
    <I18nProvider>
      <SidebarSearchEmptyState query="relay" showArchive resetSessionSearch={() => { resets += 1; }} />
    </I18nProvider>,
  ));
  expect(document.body.textContent).toContain('No matching sessions');
  const button = archiveButton();
  if (!button) throw new Error('Archive button missing');
  await act(async () => button.click());
  expect(useUIStore.getState().isArchivePageOpen).toBe(true);
  expect(useUIStore.getState().archivePageSearch).toBe('relay');
  expect(resets).toBe(1);
});

test('offers no Archive page where there is none', async () => {
  await act(async () => root.render(
    <I18nProvider>
      <SidebarSearchEmptyState query="relay" showArchive={false} resetSessionSearch={() => undefined} />
    </I18nProvider>,
  ));
  expect(document.body.textContent).toContain('No matching sessions');
  expect(archiveButton()).toBeNull();
});
