import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!doctype html><html><body></body></html>');
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  const payload = url.includes('/api/location') ? { directory: '/proposal-test', project: { directory: '/proposal-test' } }
    : url.includes('/api/session') ? [] : {};
  return Response.json(payload);
};
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  Text: browser.Text, customElements: browser.customElements,
  CSSStyleSheet: browser.CSSStyleSheet, SVGElement: browser.SVGElement,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const { MarkdownContent } = await import('../MarkdownRendererImpl');
const { I18nProvider } = await import('@/lib/i18n');
const { serializeRenderedMarkdown } = await import('./selectionMarkdown');
const { TOOL_DIFF_PREVIEW_MAX_CHARS } = await import('../message/parts/toolDiffPreview');
await import('./MarkdownDiffPreview');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => { await act(() => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = realFetch; });

const patch = '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const old = 1;\n+const next = 2;';
const draw = async (source: string, closed = true, purpose?: 'copy' | 'image') => {
  await act(async () => {
    root.render(<I18nProvider><MarkdownContent
      content={`\`\`\`diff\n${source}${closed ? '\n```' : ''}`}
      mode="streaming" isStreaming={!closed} enableFileReferences={false} purpose={purpose}
    /></I18nProvider>);
  });
};

test('a proposal uses rich diffs, names the file without file actions, and copies its source', async () => {
  await draw(patch);
  expect(host.querySelector('[data-streamdown="code-block-header"]')?.textContent).toBe('Proposal');
  expect(host.querySelectorAll('diffs-container')).toHaveLength(1);
  const diffRoot = host.querySelector('diffs-container')?.shadowRoot;
  for (let attempt = 0; attempt < 100 && !diffRoot?.querySelector('[data-line]'); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  expect(diffRoot?.querySelector('[data-line][data-line-type="change-deletion"]')?.textContent).toContain('const old = 1;');
  expect(diffRoot?.querySelector('[data-line][data-line-type="change-addition"]')?.textContent).toContain('const next = 2;');
  expect(diffRoot?.querySelectorAll('[data-diff-header], button')).toHaveLength(0);
  expect(host.textContent).toContain('src/example.ts');
  expect(Array.from(host.querySelectorAll('button'), (button) => button.title)).toEqual(['Copy code']);
  expect(host.querySelectorAll('a, [data-openchamber-file-link]')).toHaveLength(0);
  expect(serializeRenderedMarkdown(host)).toBe(`\`\`\`diff\n${patch}\n\`\`\``);
  const copied: string[] = [];
  Object.defineProperty(browser.navigator, 'clipboard', {
    configurable: true, value: { writeText: async (text: string) => { copied.push(text); } },
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
  expect(copied).toEqual([patch]);
});

test('headerless snippets and multiple files render without inventing copy text', async () => {
  await draw('-old\n+new');
  expect(host.querySelectorAll('diffs-container')).toHaveLength(1);
  expect(serializeRenderedMarkdown(host)).toBe('```diff\n-old\n+new\n```');
  await draw(`${patch}\n${patch.replaceAll('example.ts', 'second.ts')}`);
  expect(host.querySelectorAll('diffs-container')).toHaveLength(2);
  expect(host.textContent).toContain('src/second.ts');
});

test('streaming, malformed and oversized proposals preserve readable source', async () => {
  await draw('--- a/example\n+++', false);
  expect(host.querySelectorAll('diffs-container')).toHaveLength(0);
  expect(host.querySelector('pre')?.textContent).toBe('--- a/example\n+++');
  await draw(patch);
  expect(host.querySelectorAll('diffs-container')).toHaveLength(1);
  await draw('not a patch <script>alert(1)</script>');
  expect(host.querySelectorAll('diffs-container, script')).toHaveLength(0);
  expect(host.querySelector('pre')?.textContent).toContain('<script>alert(1)</script>');
  const oversized = '+' + 'x'.repeat(TOOL_DIFF_PREVIEW_MAX_CHARS);
  await draw(oversized);
  expect(host.querySelectorAll('diffs-container')).toHaveLength(0);
  expect(host.querySelector('pre')?.textContent?.length).toBeLessThan(oversized.length + 2);
  expect(host.querySelector('[data-oc-code-source]')?.getAttribute('data-oc-code-source')).toBe(oversized);
});

test('export keeps the proposal label and original patch in ordinary code markup', async () => {
  for (const purpose of ['copy', 'image'] as const) {
    await draw(patch, true, purpose);
    expect(host.querySelectorAll('diffs-container, button')).toHaveLength(0);
    expect(host.textContent).toContain('Proposal');
    expect(host.querySelector('pre code')).not.toBeNull();
    expect(serializeRenderedMarkdown(host)).toBe(`\`\`\`diff\n${patch}\n\`\`\``);
  }
});
