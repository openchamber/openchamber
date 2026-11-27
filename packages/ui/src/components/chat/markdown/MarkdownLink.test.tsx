import { afterAll, expect, test } from 'bun:test';
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
  if (url.includes('/api/fs/stat')) return Response.json({ exists: true });
  if (url.includes('/api/location')) return Response.json({ directory: '/repo', project: { directory: '/repo' } });
  return Response.json([]);
};

const { MarkdownContent } = await import('../MarkdownRendererImpl');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => {
  await act(() => root.unmount());
  browser.happyDOM.abort();
  globalThis.fetch = realFetch;
});

test('local href clicks prevent browser navigation and open decoded files through MarkdownLink', async () => {
  for (const [href, path] of [
    ['docs/%E4%B8%AD%E6%96%87.md', '/repo/docs/中文.md'],
    ['docs/a%20%20b.md', '/repo/docs/a  b.md'],
    ['report.md', '/repo/report.md'],
    ['%20%20report.md', '/repo/  report.md'],
    ['report.md%20%20', '/repo/report.md  '],
    ['docs/a%3Cb.md', '/repo/docs/a<b.md'],
    ['docs/a%3Eb.md', '/repo/docs/a>b.md'],
    ['docs/a%3A%2F%2Fb.md', '/repo/docs/a:/b.md'],
    ['docs/50%2525off.md', '/repo/docs/50%25off.md'],
  ]) {
    await act(() => root.render(<I18nProvider>
      <MarkdownContent content={`[Open file](${href})`} directory="/repo" mode="static" />
    </I18nProvider>));
    const link = host.querySelector('a');
    if (!link) throw new Error(`Missing rendered link for ${href}`);
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    await act(() => { link.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(useUIStore.getState().pendingFileFocusPath).toBe(path);
    const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
    expect(panel.tabs.find((tab) => tab.id === panel.activeTabId)?.targetPath).toBe(path);
  }
});

test('fragment clicks scroll to decoded or literal IDs without browser navigation', async () => {
  await act(() => root.render(<I18nProvider>
    <MarkdownContent content="[Malformed](#%zz) [Encoded](#review%2Dnotes)" mode="static" />
  </I18nProvider>));
  const markdown = host.querySelector('[data-markdown-content]');
  if (!markdown) throw new Error('Missing rendered Markdown');

  for (const [href, id] of [['#%zz', '%zz'], ['#review%2Dnotes', 'review-notes']]) {
    const link = markdown.querySelector(`a[href="${href}"]`);
    if (!link) throw new Error(`Missing rendered link for ${href}`);
    const heading = document.createElement('h2');
    heading.id = id;
    let scrolled = false;
    heading.scrollIntoView = () => { scrolled = true; };
    markdown.append(heading);
    try {
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      await act(() => { link.dispatchEvent(click); });
      expect(click.defaultPrevented).toBe(true);
      expect(scrolled).toBe(true);
    } finally {
      heading.remove();
    }
  }
});

test('desktop mail links open through the local bridge and never fall back to the browser', async () => {
  const opened: string[] = [];
  const browserOpened: string[] = [];
  const previousElectron = Object.getOwnPropertyDescriptor(window, '__OPENCHAMBER_ELECTRON__');
  const previousDesktop = Object.getOwnPropertyDescriptor(window, '__OPENCHAMBER_DESKTOP__');
  const previousOpen = window.open;
  window.open = (url?: string | URL) => {
    browserOpened.push(String(url ?? ''));
    return null;
  };
  const clickMail = async () => {
    await act(() => root.render(<I18nProvider>
      <MarkdownContent content="[Email support](mailto:support@example.test?subject=Help)" directory="/repo" mode="static" />
    </I18nProvider>));
    const link = host.querySelector('a[href="mailto:support@example.test?subject=Help"]');
    if (!link) throw new Error('Missing rendered mailto link');
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    await act(() => { link.dispatchEvent(click); });
    return click.defaultPrevented;
  };
  try {
    Object.defineProperty(window, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
    Object.defineProperty(window, '__OPENCHAMBER_DESKTOP__', {
      configurable: true,
      value: { openExternal: async (url: string) => { opened.push(url); } },
    });
    expect(await clickMail()).toBe(true);
    expect(opened).toEqual(['mailto:support@example.test?subject=Help']);

    // A remote page in the desktop shell has no openExternal bridge.
    Object.defineProperty(window, '__OPENCHAMBER_DESKTOP__', { configurable: true, value: {} });
    expect(await clickMail()).toBe(true);
    expect(opened).toEqual(['mailto:support@example.test?subject=Help']);
    expect(browserOpened).toEqual([]);

  } finally {
    if (previousElectron) Object.defineProperty(window, '__OPENCHAMBER_ELECTRON__', previousElectron);
    else Reflect.deleteProperty(window, '__OPENCHAMBER_ELECTRON__');
    if (previousDesktop) Object.defineProperty(window, '__OPENCHAMBER_DESKTOP__', previousDesktop);
    else Reflect.deleteProperty(window, '__OPENCHAMBER_DESKTOP__');
    window.open = previousOpen;
  }
});
