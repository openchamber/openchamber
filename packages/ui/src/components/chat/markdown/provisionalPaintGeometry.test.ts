import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createHighlighter } from 'shiki';
import type { DecorateContext } from './decorate';

// A freshly opened session shows its first, unhighlighted markdown paint
// without waiting for highlighting (the timeline reveal gate no longer holds
// for it). That is only acceptable while the highlighted paint lays out
// exactly like the provisional one, so the chat cannot jump when colours land.
// These tests compare the two decorated DOMs on everything that sizes a code
// block: line rows and gutter, header, classes, inline layout styles, and the
// text of every line.

const win = new Window({ url: 'https://openchamber.test/' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  HTMLAnchorElement: win.HTMLAnchorElement,
  Node: win.Node,
  DocumentFragment: win.DocumentFragment,
});

// Bun cannot load Vite's `?worker&url` import that markdown-worker makes.
mock.module('./markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));

// The sanitizer binds to the window when its module loads.
const { renderMarkdownSync } = await import('./markdownCore');
const { decorateMarkdown } = await import('./decorate');

const THEME = 'github-dark';
// Classes Shiki puts on its <pre>. No stylesheet rule targets them.
const SHIKI_PRE_CLASSES = new Set(['shiki', THEME]);

let highlighter: Awaited<ReturnType<typeof createHighlighter>>;
beforeAll(async () => {
  highlighter = await createHighlighter({ themes: [THEME], langs: ['typescript', 'markdown', 'python'] });
});

const context = (codeBlockLineWrap: boolean): DecorateContext => ({
  labels: {
    copy: 'Copy', copied: 'Copied', enableCodeWrap: 'Wrap', disableCodeWrap: 'Unwrap',
    enableTableWrap: 'Wrap cells', disableTableWrap: 'Unwrap cells',
    copyTable: 'Copy table', downloadTable: 'Download table', copyDiagram: 'Copy diagram',
    downloadDiagram: 'Download diagram', zoomInDiagram: 'Zoom in', zoomOutDiagram: 'Zoom out',
    resetDiagramView: 'Reset', previewLabel: 'Preview', previewTitle: 'Preview',
  },
  mermaidControls: { download: false, copy: false, showPanZoomControls: false },
  codeBlockLineWrap,
  tableCellWrap: false,
  renderMermaid: () => ({}),
});

const CODE_BLOCK_RE = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;

const unescapeHtml = (value: string): string => {
  const element = document.createElement('div');
  element.innerHTML = value;
  return element.textContent ?? '';
};

// Mirrors the highlight pass in markdownCore: each fence is replaced by
// Shiki's output, stamped with the requested language in lower case.
const highlightLikeTheWorker = (html: string): string => html.replace(CODE_BLOCK_RE, (_full, rawLang: string | undefined, escaped: string) => {
  const requested = (rawLang || 'text').toLowerCase();
  const lang = highlighter.getLoadedLanguages().includes(requested) ? requested : 'text';
  const highlighted = highlighter.codeToHtml(unescapeHtml(escaped), { lang, theme: THEME, tabindex: false });
  return highlighted.replace(/^<pre/, `<pre data-md-lang="${requested}"`);
});

const decorate = (html: string, wrap: boolean): HTMLElement => {
  const root = document.createElement('div');
  root.innerHTML = html;
  decorateMarkdown(root, context(wrap));
  return root;
};

// marked's `language-*` class on <code>, which Shiki's output does not carry.
// No stylesheet rule targets it either.
const isMarkedLanguageClass = (name: string): boolean => name.startsWith('language-');

const layoutClasses = (element: Element | null): string[] => (
  Array.from(element?.classList ?? []).filter((name) => !SHIKI_PRE_CLASSES.has(name) && !isMarkedLanguageClass(name)).sort()
);

const layoutStyle = (element: HTMLElement | null) => ({
  whiteSpace: element?.style.whiteSpace,
  overflowWrap: element?.style.overflowWrap,
  margin: element?.style.margin,
  padding: element?.style.padding,
  display: element?.style.display,
  fontSize: element?.style.fontSize,
  lineHeight: element?.style.lineHeight,
});

// Everything about a code block that decides its size.
const codeBlockGeometry = (wrapper: HTMLElement) => {
  const pre = wrapper.querySelector<HTMLElement>('pre');
  const code = wrapper.querySelector<HTMLElement>('pre > code');
  const rows = Array.from(wrapper.querySelectorAll<HTMLElement>('[data-md-code-line]'));
  return {
    wrapperClasses: layoutClasses(wrapper),
    wrapperState: wrapper.getAttribute('data-code-wrap'),
    header: {
      classes: layoutClasses(wrapper.firstElementChild),
      label: wrapper.firstElementChild?.firstElementChild?.textContent,
      actions: wrapper.querySelectorAll('[data-md-action]').length,
    },
    bodyClasses: layoutClasses(wrapper.querySelector('[data-md-code-body]')),
    preClasses: layoutClasses(pre),
    preStyle: layoutStyle(pre),
    preGutterReserved: pre?.hasAttribute('data-md-gutter-reserved'),
    codeClasses: layoutClasses(code),
    codeStyle: layoutStyle(code),
    codeLines: code?.hasAttribute('data-md-code-lines'),
    trailingNewline: code?.hasAttribute('data-md-code-trailing-newline'),
    rows: rows.map((row) => ({
      number: row.querySelector('[data-md-code-line-number]')?.getAttribute('data-md-code-line-number'),
      text: row.querySelector('[data-md-code-line-content]')?.textContent,
      contentStyle: layoutStyle(row.querySelector<HTMLElement>('[data-md-code-line-content]')),
    })),
    lineBreaks: wrapper.querySelectorAll('[data-md-code-line-break]').length,
  };
};

const SOURCE = [
  'Intro paragraph with `inline code`.',
  '',
  '```TypeScript',
  'export function add(a: number, b: number): number {',
  '\treturn a + b; // tab-indented',
  '}',
  '',
  '```',
  '',
  '```python',
  'def call(vm):',
  '    """Docstring."""',
  '    return vm',
  '```',
  '',
  '```markdown',
  '# Title',
  '',
  '- item **bold** and _italic_',
  '```',
  '',
  '```',
  'plain fence without a language',
  '```',
  '',
  '```unknownlang',
  'x <y> & z',
  '```',
].join('\n');

describe('provisional markdown paint geometry', () => {
  for (const wrap of [false, true]) {
    test(`a highlighted code block lays out like its provisional paint (line wrap ${wrap ? 'on' : 'off'})`, () => {
      const provisionalHtml = renderMarkdownSync(SOURCE);
      const provisional = decorate(provisionalHtml, wrap);
      const highlighted = decorate(highlightLikeTheWorker(provisionalHtml), wrap);

      const provisionalBlocks = Array.from(provisional.querySelectorAll<HTMLElement>('[data-component="markdown-code"]'));
      const highlightedBlocks = Array.from(highlighted.querySelectorAll<HTMLElement>('[data-component="markdown-code"]'));

      expect(provisionalBlocks).toHaveLength(5);
      expect(highlightedBlocks).toHaveLength(provisionalBlocks.length);
      // The highlighted paint really is a different DOM: coloured tokens.
      expect(highlighted.querySelector('[data-md-code-line-content] span[style]')).not.toBeNull();
      expect(provisional.querySelector('[data-md-code-line-content] span[style]')).toBeNull();

      provisionalBlocks.forEach((block, index) => {
        const target = highlightedBlocks[index];
        if (!target) throw new Error(`missing highlighted block ${index}`);
        expect(codeBlockGeometry(target)).toEqual(codeBlockGeometry(block));
      });
      // Outside code blocks the two paints are the same markup.
      expect(highlighted.querySelector('p')?.outerHTML).toBe(provisional.querySelector('p')?.outerHTML ?? '');
    });
  }

  test('the language label keeps its case-folded form across the two paints', () => {
    const provisional = decorate(renderMarkdownSync('```TypeScript\nconst a = 1;\n```'), false);
    const label = provisional.querySelector('[data-component="markdown-code"]')?.firstElementChild?.firstElementChild?.textContent;

    expect(label).toBe('typescript');
  });
});
