import { afterAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
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
