import { afterAll, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, Event: browser.Event, CustomEvent: browser.CustomEvent, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement, HTMLAnchorElement: browser.HTMLAnchorElement,
  Element: browser.Element, Node: browser.Node, Text: browser.Text,
  SVGElement: browser.SVGElement, customElements: browser.customElements,
  MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser,
  XMLSerializer: browser.XMLSerializer, IntersectionObserver: browser.IntersectionObserver,
  ResizeObserver: browser.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
});
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/api/fs/stat')) return Response.json({ path: '/repo/src/app.ts', isFile: true });
  if (url.includes('/api/location')) return Response.json({ directory: '/repo', project: { directory: '/repo' } });
  return Response.json([]);
};

const { MarkdownContent } = await import('../MarkdownRendererImpl');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');

const roots: ReturnType<typeof createRoot>[] = [];
afterAll(async () => {
  for (const root of roots) await act(() => root.unmount());
  browser.happyDOM.abort();
  globalThis.fetch = realFetch;
});

const openedPath = () => {
  const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
  return panel?.tabs.find((tab) => tab.id === panel.activeTabId)?.targetPath;
};

const reference = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => root.render(<I18nProvider>
    <MarkdownContent content="Open `src/app.ts` first." directory="/repo" mode="static" />
  </I18nProvider>));
  let code: HTMLElement | null = null;
  for (let turn = 0; turn < 50 && !code; turn += 1) {
    await act(async () => {});
    code = host.querySelector<HTMLElement>('[data-openchamber-file-link="true"]');
  }
  if (!code) throw new Error('Missing confirmed file reference');
  return code;
};

const press = async (element: HTMLElement, from: number, to: number, path: number[] = [], release: Element = element) => {
  await act(() => {
    element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: from, clientY: 10 }));
  });
  await act(() => {
    for (const x of path) element.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x, clientY: 10 }));
    release.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, clientX: to, clientY: 10 }));
    release.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: to, clientY: 10 }));
  });
};

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {} });
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});

test('a drag across a file reference that selects nothing opens nothing', async () => {
  const code = await reference();
  await press(code, 10, 40);
  expect(openedPath()).toBeUndefined();
});

test('a plain click focuses the file reference and opens it, so Enter works next', async () => {
  const code = await reference();
  await press(code, 10, 11);
  expect(openedPath()).toBe('/repo/src/app.ts');
  expect(code.getAttribute('tabindex')).toBe('0');
  expect(document.activeElement).toBe(code);
});

test('a drag that returns to where it started opens nothing', async () => {
  const code = await reference();
  await press(code, 10, 10, [30, 10]);
  expect(openedPath()).toBeUndefined();
});

test('a press released outside the reference does not swallow a later element.click()', async () => {
  const code = await reference();
  await press(code, 10, 60, [60], document.body);
  expect(openedPath()).toBeUndefined();
  await act(() => { code.click(); });
  expect(openedPath()).toBe('/repo/src/app.ts');
});
