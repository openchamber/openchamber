import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { DirectoryActionIndicator } from './DirectoryActionIndicator';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useTerminalStore.getState().clearAll();
});
afterEach(async () => {
  await act(async () => root.unmount());
  useTerminalStore.getState().clearAll();
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('shows only live actions in its exact directory and follows start, stop and exit', async () => {
  await act(async () => root.render(<I18nProvider><DirectoryActionIndicator directory="/repo/" /><DirectoryActionIndicator directory="/repo/worktree" /></I18nProvider>));
  const store = useTerminalStore.getState();
  let tab = '';
  await act(async () => { tab = store.createTab('/repo'); store.setTabSessionId('/repo', tab, 'interactive'); });
  expect(document.querySelectorAll('[data-action-directory]')).toHaveLength(0);
  await act(async () => { store.allocateActionExecution('/repo', tab, 'dev'); });
  expect(document.querySelectorAll('[data-action-directory]')).toHaveLength(1);
  expect(document.querySelector('[data-action-directory]')?.getAttribute('data-action-directory')).toBe('/repo');
  expect(document.querySelector('use')?.getAttribute('href')).toBe('#oc-pulse');
  await act(async () => store.setTabLifecycle('/repo', tab, 'stopping'));
  expect(document.querySelectorAll('[data-action-directory]')).toHaveLength(1);
  await act(async () => store.setTabLifecycle('/repo', tab, 'exited'));
  expect(document.querySelectorAll('[data-action-directory]')).toHaveLength(0);
});

test('500 indicators do not rerender for output or another directory changing', async () => {
  const store = useTerminalStore.getState();
  const tab = store.createTab('/repo');
  store.allocateActionExecution('/repo', tab, 'dev');
  let renders = 0;
  await act(async () => root.render(<I18nProvider><Profiler id="indicators" onRender={() => { renders += 1; }}>
    {Array.from({ length: 500 }, (_, index) => <DirectoryActionIndicator key={index} directory="/repo" />)}
  </Profiler></I18nProvider>));
  expect(document.querySelectorAll('[data-action-directory]')).toHaveLength(500);
  renders = 0;
  await act(async () => {
    for (let index = 0; index < 1000; index += 1) store.appendToBuffer('/repo', tab, 'output\n', index);
    const other = store.createTab('/unrelated');
    store.allocateActionExecution('/unrelated', other, 'dev');
  });
  expect(store.getBuffer('/repo', tab).lastSequence).toBe(999);
  expect(renders).toBe(0);
  await act(async () => store.setTabLifecycle('/repo', tab, 'exited'));
  expect(renders).toBeGreaterThan(0);
  expect(document.querySelectorAll('[data-action-directory]')).toHaveLength(0);
});
