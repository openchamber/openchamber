import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { AppStartupOverlay } from './AppStartupOverlay';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const SLOW_HINT = 'Startup is taking longer than expected…';
const SLOW_HINT_DELAY_MS = 10_000;

let root: Root;
let host: HTMLDivElement;

const render = (ready: boolean) => act(async () => {
  root.render(<I18nProvider><AppStartupOverlay ready={ready} /></I18nProvider>);
});
const wait = (ms: number) => act(async () => {
  jest.advanceTimersByTime(ms);
});

beforeEach(() => {
  jest.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  jest.useRealTimers();
});

test('a start that is still on the logo after ten seconds says it is slow', async () => {
  await render(false);
  await wait(SLOW_HINT_DELAY_MS - 1);
  expect(host.textContent).not.toContain(SLOW_HINT);
  expect(host.querySelectorAll('svg')).toHaveLength(1);
  await wait(1);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(SLOW_HINT);
  expect(host.querySelectorAll('svg')).toHaveLength(1);
});

test('a start that begins again waits its own ten seconds', async () => {
  await render(false);
  await wait(SLOW_HINT_DELAY_MS);
  expect(host.textContent).toContain(SLOW_HINT);
  await render(true);
  await render(false);
  expect(host.textContent).not.toContain(SLOW_HINT);
  await wait(SLOW_HINT_DELAY_MS - 1);
  expect(host.textContent).not.toContain(SLOW_HINT);
  await wait(1);
  expect(host.textContent).toContain(SLOW_HINT);
});

test('a start that finishes in time never shows the slow hint', async () => {
  await render(false);
  await wait(SLOW_HINT_DELAY_MS - 1);
  await render(true);
  await wait(SLOW_HINT_DELAY_MS);
  expect(host.textContent).not.toContain(SLOW_HINT);
});
