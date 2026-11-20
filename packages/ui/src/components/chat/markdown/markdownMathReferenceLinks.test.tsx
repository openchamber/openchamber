import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';

const browser = new Window({ url: 'http://localhost/' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, {
  window: browser, document: browser.document, Event: browser.Event, CustomEvent: browser.CustomEvent,
  navigator: browser.navigator, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement, HTMLAnchorElement: browser.HTMLAnchorElement, Element: browser.Element,
  Node: browser.Node, Text: browser.Text, SVGElement: browser.SVGElement, customElements: browser.customElements,
  MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser, XMLSerializer: browser.XMLSerializer,
  IntersectionObserver: browser.IntersectionObserver, ResizeObserver: browser.ResizeObserver,
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const { MarkdownContent } = await import('../MarkdownRendererImpl');
const { I18nProvider } = await import('@/lib/i18n');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => { await act(() => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = originalFetch; });

const repositoryLinks = { descriptor: githubLikeDescriptor(), origin: 'https://github.com', owner: 'acme', repo: 'app' };
const emojiShortcodes = new Map([['tada', '🎉']]);
const formula = '\\[\nx+\n\ny\n\\]';
const draw = async (content: string, repository = true, emoji = true) => act(() => root.render(
  <I18nProvider><MarkdownContent content={content} repositoryLinks={repository ? repositoryLinks : null}
    emojiShortcodes={emoji ? emojiShortcodes : null} allowRawHtml enableFileReferences={false} /></I18nProvider>,
));

test('renders formulas beside repository links and emoji', async () => {
  await draw(`Fixes #12 :tada:.\n\n${formula}`);
  expect(host.querySelector('.katex-display annotation')?.textContent).toContain('x+\n\ny');
  expect(host.querySelector('a[href="https://github.com/acme/app/issues/12"]')?.textContent).toBe('#12');
  expect(host.textContent).toContain('🎉');
});

test('renders a simple streaming formula beside emoji', async () => {
  const content = `Ready :tada:.\n\n${formula}`;
  await act(() => root.render(<I18nProvider><MarkdownContent content={content} emojiShortcodes={emojiShortcodes}
    mode="streaming" isStreaming enableFileReferences={false} /></I18nProvider>));
  expect(host.textContent).toContain('🎉');
  expect(host.querySelector('.katex-display annotation')?.textContent).toContain('x+\n\ny');
});

test('keeps a repository reference inside a candidate as a link', async () => {
  await draw('\\[\nx+\n\n#12\n\\]', true, false);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.querySelector('a[href="https://github.com/acme/app/issues/12"]')?.textContent).toBe('#12');
});

test('keeps emoji replacement inside a candidate', async () => {
  await draw('\\[\nx+\n\n:tada:\n\\]', false, true);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.textContent).toContain('🎉');
});

test('updates emoji when the shortcode table loads for a visible message', async () => {
  const text = `Ready :tada:.\n\n${formula}`;
  await draw(text, false, false);
  expect(host.textContent).toContain(':tada:');
  await draw(text, false, true);
  expect(host.textContent).toContain('🎉');
  expect(host.querySelector('.katex-display')).not.toBeNull();
});

test('keeps one formula when a different candidate contains a repository reference', async () => {
  await draw(`${formula}\n\n\\[\nx+\n\n#12\n\\]`, true, false);
  expect(host.querySelectorAll('.katex-display')).toHaveLength(1);
  expect(host.querySelector('a[href="https://github.com/acme/app/issues/12"]')?.textContent).toBe('#12');
});

test('keeps Markdown links inside a candidate', async () => {
  await draw('\\[\nx+\n\n[guide](https://example.com)\n\\]');
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.querySelector('a[href="https://example.com"]')?.textContent).toBe('guide');
});

test('updates a changed repository context without changing the message', async () => {
  const content = `Fixes #12.\n\n${formula}`;
  const render = async (owner: string) => act(() => root.render(
    <I18nProvider><MarkdownContent content={content} repositoryLinks={{ ...repositoryLinks, owner }} enableFileReferences={false} /></I18nProvider>,
  ));
  await render('acme');
  expect(host.querySelector('a[href="https://github.com/acme/app/issues/12"]')).not.toBeNull();
  await render('other');
  expect(host.querySelector('a[href="https://github.com/other/app/issues/12"]')).not.toBeNull();
  expect(host.querySelector('.katex-display')).not.toBeNull();
});

test('updates the parsed text when an emoji table is replaced', async () => {
  const content = '\\[\nx+\n\n:tada:\n\\]';
  const render = async (table: ReadonlyMap<string, string>) => act(() => root.render(
    <I18nProvider><MarkdownContent content={content} emojiShortcodes={table} enableFileReferences={false} /></I18nProvider>,
  ));
  await render(new Map());
  expect(host.querySelector('.katex-display')).not.toBeNull();
  await render(new Map([['tada', '🎉']]));
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.textContent).toContain('🎉');
});

test('leaves raw code and links as written when rules are active', async () => {
  for (const [open, close, selector] of [
    ['<code>', '</code>', 'code'],
    ['<a href="https://example.com">', '</a>', 'a[href="https://example.com"]'],
  ]) {
    await draw(`${open}\n\n${formula}\n\n${close}\n\nOutside\n\n\\[\na+\n\nb\n\\]`, true, false);
    expect(host.querySelector(`${selector} .katex-display`)).toBeNull();
    expect(host.querySelector(selector)?.textContent).toContain('x+');
    expect(host.querySelectorAll('.katex-display')).toHaveLength(0);
    expect(host.textContent).toContain('a+');
    await draw(`${open}\n\n${formula}\n\n${close}`, true, false);
    expect(host.querySelector('.katex-display')).toBeNull();
  }
});

test('renders a formula after an HTML example in fenced code', async () => {
  await draw(`\`\`\`html\n<code>\n\`\`\`\n\n${formula}`, true, false);
  expect(host.querySelector('.katex-display annotation')?.textContent).toContain('x+\n\ny');
});

test('ignores an unmatched closing tag inside a raw link', async () => {
  await draw(`<a href="https://example.com">\n\n</code>\n\n${formula}\n\n</a>`, true, false);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.querySelector('a[href="https://example.com"]')?.textContent).toContain('x+');
});

test('keeps formulas outside HTML code when raw HTML is disabled', async () => {
  const content = `Use <code> for code.\n\n${formula}`;
  for (const literalText of [false, true]) {
    await act(() => root.render(<I18nProvider><MarkdownContent content={content} literalText={literalText}
      repositoryLinks={repositoryLinks} enableFileReferences={false} /></I18nProvider>));
    expect(host.querySelector('.katex-display annotation')?.textContent).toContain('x+\n\ny');
  }
});

test('leaves a formula unchanged after a raw HTML tag', async () => {
  await draw(`<span title="<code>">text</span>\n\n${formula}`, true, false);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.textContent).toContain('x+');
});

test('renders a block formula after inline math containing tag-shaped text', async () => {
  await draw(`Inline \\(a <b> c\\).\n\n${formula}`, true, false);
  expect(host.querySelector('.katex-display annotation')?.textContent).toContain('x+\n\ny');
  expect(host.querySelectorAll('.katex')).toHaveLength(2);
});

test('leaves list formulas unchanged when raw HTML follows them', async () => {
  await draw('- \\[\n  x+\n\n  y\n  \\]\n\n- text <code>hello\n\n</code>', true, false);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.textContent).toContain('x+');
});

test('preserves formulas inside HTML code after pre, self-closing and crossed tags', async () => {
  for (const [prefix, suffix] of [
    ['<pre>literal</pre><code>', '</code>'],
    ['<code/>', '</code>'],
    ['<a href="https://example.com"><code>\n\n</a>', '</code>'],
  ]) {
    await draw(`${prefix}\n\n${formula}\n\n${suffix}`, true, false);
    expect(host.querySelector('.katex-display')).toBeNull();
  }
});
