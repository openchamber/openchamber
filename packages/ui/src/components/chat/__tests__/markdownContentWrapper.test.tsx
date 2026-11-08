/**
 * `MarkdownContent` from `MarkdownRenderer.tsx` keeps one path for a mount's
 * whole life. Content that mounted before the renderer loaded stays on the
 * lazy component after it loads: swapping in the loaded component at the
 * same spot would remount the content and load its images again.
 */
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

const FakeContent = ({ content }: { content: string }) => <div data-markdown-content="">{content}</div>;
const fakeModule = { MarkdownContent: FakeContent, MarkdownRenderer: FakeContent, SimpleMarkdownRenderer: FakeContent };
let loaded: typeof fakeModule | null = null;
let resolveLoad: (module: typeof fakeModule) => void = () => undefined;
const loading = new Promise<typeof fakeModule>((resolve) => { resolveLoad = resolve; });
mock.module('@/components/chat/markdownRendererLoader', () => ({
  getLoadedMarkdownRendererModule: () => loaded,
  loadMarkdownRendererModule: () => loading,
  preloadMarkdownRenderer: () => undefined,
}));

const { MarkdownContent } = await import('../MarkdownRenderer');

test('content mounted before the renderer loaded keeps its node after it loads', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const draw = (content: string) => act(() => root.render(<MarkdownContent content={content} />));

  await draw('![](image.png)');
  expect(host.querySelector('[data-markdown-content]')).toBe(null);

  await act(async () => {
    loaded = fakeModule;
    resolveLoad(fakeModule);
    await loading;
  });
  const first = host.querySelector('[data-markdown-content]');
  expect(first?.textContent).toBe('![](image.png)');

  await draw('![](image.png) ');
  expect(host.querySelector('[data-markdown-content]')).toBe(first);
  await act(() => root.unmount());
});
