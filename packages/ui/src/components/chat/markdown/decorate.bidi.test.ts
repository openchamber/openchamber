import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLAnchorElement: dom.HTMLAnchorElement,
});

const { decorateMarkdown, getMarkdownCodeText } = await import('./decorate');
const context: Parameters<typeof decorateMarkdown>[1] = {
  labels: {
    copy: 'Copy', copied: 'Copied', enableCodeWrap: 'Wrap', disableCodeWrap: 'Unwrap',
    copyTable: 'Copy table', downloadTable: 'Download table', copyDiagram: 'Copy diagram',
    downloadDiagram: 'Download diagram', zoomInDiagram: 'Zoom in', zoomOutDiagram: 'Zoom out',
    resetDiagramView: 'Reset', previewLabel: 'Preview', previewTitle: 'Preview',
  },
  mermaidControls: { download: false, copy: false, showPanZoomControls: false },
  codeBlockLineWrap: false,
  renderMermaid: () => ({}),
};

afterEach(() => document.body.replaceChildren());
afterAll(() => dom.happyDOM.close());

test('direction belongs to list items and quotes, including loose and nested lists', () => {
  const root = document.createElement('div');
  root.innerHTML = '<ul><li><p>مرحبا <code>fn(1);</code></p><ul><li>English.</li></ul></li></ul><blockquote><p>שלום.</p><p>English.</p></blockquote>';
  document.body.append(root);
  const originalText = root.textContent;
  decorateMarkdown(root, context);

  expect(Array.from(root.querySelectorAll('li, blockquote'), (element) => element.getAttribute('dir')))
    .toEqual(['auto', 'auto', 'auto']);
  expect(root.querySelector('p')?.hasAttribute('dir')).toBe(false);
  expect(root.querySelector('code')?.getAttribute('dir')).toBe('ltr');
  expect(root.textContent).toBe(originalText);
  const decorated = root.innerHTML;
  decorateMarkdown(root, context);
  expect(root.innerHTML).toBe(decorated);
});

test('an Arabic code comment keeps the complete widget LTR and copy text unchanged', () => {
  const root = document.createElement('div');
  root.innerHTML = '<blockquote><p>مرحبا</p><pre><code class="language-js">// שלום\nconst value = 1;\n</code></pre></blockquote>';
  document.body.append(root);
  decorateMarkdown(root, context);

  const code = root.querySelector('pre code');
  if (!(code instanceof HTMLElement)) throw new Error('Missing code block');
  expect(root.querySelector('[data-component="markdown-code"]')?.getAttribute('dir')).toBe('ltr');
  expect(getMarkdownCodeText(code)).toBe('// שלום\nconst value = 1;\n');
  decorateMarkdown(root, context);
  expect(root.querySelectorAll('[data-component="markdown-code"]')).toHaveLength(1);
});

test('bare URLs are isolated without forcing the direction of translated link labels', () => {
  const root = document.createElement('div');
  root.innerHTML = '<p>مرحبا <a href="https://example.test/path/">https://example.test/path/</a> <a href="https://example.test/">مرحبا</a></p>';
  document.body.append(root);
  decorateMarkdown(root, context);
  const links = root.querySelectorAll('a');
  expect(links[0]?.getAttribute('dir')).toBe('ltr');
  expect(links[1]?.hasAttribute('dir')).toBe(false);
});
