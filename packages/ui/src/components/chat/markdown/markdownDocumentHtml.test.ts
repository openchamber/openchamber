import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

// Real DOMPurify on a happy-dom window. One caveat shapes the cases below:
// under happy-dom, DOMPurify stops visiting the siblings that follow an element
// it removed, which browsers do not do. Each payload therefore stands alone.
const dom = new Window({ url: 'http://preview.test' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  Element: dom.Element,
  HTMLAnchorElement: dom.HTMLAnchorElement,
});
mock.module('./markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
}));

const { renderMarkdownBlocks, renderMarkdownSync, resetMarkdownHtmlCacheForTests } = await import('./markdownCore');
const { isGeneratedMarkdownClass, isSafeSrcset } = await import('./markdownSecurity');

const renderDocument = (markdown: string): string => renderMarkdownSync(markdown, 'inline', 'sanitize');

const README_HEAD = [
  '# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg"><img src="docs/logo-light.svg" width="32" height="32" align="absmiddle" /></picture> OpenChamber',
  '',
  '[![GitHub stars](https://img.shields.io/github/stars/openchamber/openchamber?style=flat)](https://github.com/openchamber/openchamber/stargazers)',
  '',
  '<a href="https://www.blacksmith.sh/"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/blacksmith-dark.svg"><img src="docs/blacksmith-light.svg" height="28" alt="CI powered by Blacksmith" /></picture></a>',
  '',
  '<p align="center"><sub>small</sub> <kbd>Ctrl</kbd></p>',
].join('\n');

describe('document raw HTML', () => {
  test('renders GitHub-style README markup: pictures, badges and aligned blocks', () => {
    const html = renderDocument(README_HEAD);

    expect(html).toContain('<h1><picture><source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg"><img src="docs/logo-light.svg" width="32" height="32" align="absmiddle" style="height:32px"></picture> OpenChamber</h1>');
    expect(html).toContain('<img src="https://img.shields.io/github/stars/openchamber/openchamber?style=flat" alt="GitHub stars"></a>');
    expect(html).toContain('<a href="https://www.blacksmith.sh/"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/blacksmith-dark.svg"><img src="docs/blacksmith-light.svg" height="28" alt="CI powered by Blacksmith" style="height:28px"></picture></a>');
    expect(html).toContain('<p align="center"><sub>small</sub> <kbd>Ctrl</kbd></p>');
  });

  const strippedPayloads: Array<[name: string, markdown: string, forbidden: RegExp]> = [
    ['script element', 'x <script>alert(1)</script>', /<script|alert/],
    ['event handler', 'x <img src="a.png" onerror="alert(1)">', /onerror/],
    ['javascript: link', 'x <a href="javascript:alert(1)">j</a>', /javascript:/],
    ['iframe', 'x <iframe src="https://example.test"></iframe>', /<iframe/],
    ['style element', '<style>body { display: none }</style>', /<style|display/],
    ['author style attribute', '<div style="position:fixed;inset:0">x</div>', /style=/],
    ['app utility class', '<div class="fixed inset-0 z-50">x</div>', /class=/],
    ['renderer data attribute', '<button data-md-action="copy">x</button>', /data-md-action|<button/],
    ['form control', 'x <input type="text" value="a">', /<input/],
    ['javascript: srcset candidate', 'x <picture><source srcset="a.png 1x, javascript:alert(1) 2x"></picture>', /srcset|javascript:/],
    ['svg', '<svg><circle r="4"></circle></svg>', /<svg|<circle/],
  ];
  for (const [name, markdown, forbidden] of strippedPayloads) {
    test(`strips ${name}`, () => {
      expect(forbidden.test(renderDocument(markdown))).toBe(false);
    });
  }

  test('keeps the task-list checkbox marked renders, disabled', () => {
    const html = renderDocument('- [x] done');

    expect(/<input[^>]*type="checkbox"/.test(html)).toBe(true);
    expect(/<input[^>]*disabled/.test(html)).toBe(true);
  });

  test('keeps rendering backslash math, which needs styles the allowlist drops', () => {
    const html = renderDocument('Area \\(\\pi r^2\\) and $x$');

    expect(html).toContain('class="katex"');
    expect(html).not.toContain('data-oc-math');
  });

  test('keeps assistant output inert: raw HTML stays text, also inside link text', () => {
    const html = renderMarkdownSync('<picture><img src="a.png"></picture> [<div style="position:fixed">x</div>](https://example.test)', 'label');

    expect(html).toContain('&lt;picture&gt;');
    expect(html).toContain('&lt;div style="position:fixed"&gt;');
    expect(html).not.toContain('<picture');
  });

  test('renders a badge inside link text in both image modes', () => {
    const badge = '[![stars](https://img.shields.io/x.svg)](https://github.com/o/r) [**bold**](https://example.test)';

    expect(renderMarkdownSync(badge, 'inline')).toContain('<a href="https://github.com/o/r" class="external-link" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/x.svg" alt="stars"></a>');
    expect(renderMarkdownSync(badge, 'label')).toContain('data-openchamber-markdown-image-label="true">x.svg</span></a>');
    expect(renderMarkdownSync(badge)).toContain('<strong>bold</strong></a>');
  });

  test('caches documents apart from escaped renders of the same text', async () => {
    resetMarkdownHtmlCacheForTests();
    const text = 'x <kbd>K</kbd>';
    const [escaped] = await renderMarkdownBlocks(text, false, 'inline');
    const [document] = await renderMarkdownBlocks(text, false, 'inline', 'sanitize');

    expect(escaped?.html).toContain('&lt;kbd&gt;');
    expect(document?.html).toContain('<kbd>K</kbd>');
    expect(document?.id).not.toBe(escaped?.id);
  });
});

describe('document HTML policy helpers', () => {
  test('keeps only the classes the renderer emits', () => {
    expect(isGeneratedMarkdownClass('external-link')).toBe(true);
    expect(isGeneratedMarkdownClass('language-ts')).toBe(true);
    expect(isGeneratedMarkdownClass('fixed inset-0')).toBe(false);
    expect(isGeneratedMarkdownClass('language-ts fixed')).toBe(false);
  });

  test('accepts relative and http(s) srcset candidates only', () => {
    expect(isSafeSrcset('docs/a.svg')).toBe(true);
    expect(isSafeSrcset('a.png 1x, https://cdn.test/b.png 2x')).toBe(true);
    expect(isSafeSrcset('a.png 1x, javascript:alert(1) 2x')).toBe(false);
    expect(isSafeSrcset('data:image/svg+xml,<svg/>')).toBe(false);
  });
});
