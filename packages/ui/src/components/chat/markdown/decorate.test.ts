import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { marked } from 'marked';
import { cloneMessageImageExportSource } from '../message/imageExport';
import {
  applyMarkdownCodeBlockWrapState,
  attachMarkdownInteractions,
  decorateMarkdown,
  stabilizeMarkdownTableWidths,
  type DecorateContext,
} from './decorate';

const win = new Window({ url: 'https://openchamber.test/' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  HTMLTableElement: win.HTMLTableElement,
});

const context: DecorateContext = {
  labels: {
    copy: 'Copy', copied: 'Copied', enableCodeWrap: 'Wrap', disableCodeWrap: 'Unwrap',
    enableTableWrap: 'Wrap cells', disableTableWrap: 'Unwrap cells',
    copyTable: 'Copy table', downloadTable: 'Download table', copyDiagram: 'Copy diagram',
    downloadDiagram: 'Download diagram', zoomInDiagram: 'Zoom in', zoomOutDiagram: 'Zoom out',
    resetDiagramView: 'Reset', previewLabel: 'Preview', previewTitle: 'Preview',
  },
  mermaidControls: { download: false, copy: false, showPanZoomControls: false },
  codeBlockLineWrap: false,
  tableCellWrap: false,
  renderMermaid: () => ({}),
};

describe('Markdown table actions', () => {
  test('wrap button reflects the setting and toggles it', () => {
    let toggles = 0;
    const wrapContext: DecorateContext = { ...context, tableCellWrap: true, onToggleTableCellWrap: () => { toggles += 1; } };
    const root = document.createElement('div');
    root.innerHTML = '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>cell</td></tr></tbody></table>';
    document.body.appendChild(root);
    decorateMarkdown(root, wrapContext);
    const detach = attachMarkdownInteractions(root, wrapContext);

    try {
      const button = root.querySelector<HTMLButtonElement>('[data-md-action="toggle-table-wrap"]');
      expect(button?.getAttribute('aria-pressed')).toBe('true');
      expect(button?.getAttribute('title')).toBe('Unwrap cells');
      expect(root.querySelector('table')?.classList.contains('w-max')).toBe(false);
      button?.click();
      expect(toggles).toBe(1);
    } finally {
      detach();
      root.remove();
    }
  });

  test('wrapping fits columns into the available width and keeps short ones whole', () => {
    // Natural column width: 10px per character of its cells; 600px of room.
    const proto = win.HTMLElement.prototype;
    const rect = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
    const clientWidth = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    Object.defineProperty(proto, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) { return { width: (this.textContent?.length ?? 0) * 10 }; },
    });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 600 });

    const root = document.createElement('div');
    root.innerHTML = `<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
      <tbody><tr><td>short</td><td>${'b'.repeat(100)}</td><td>${'c'.repeat(60)}</td></tr></tbody></table>`;
    document.body.appendChild(root);
    const columnWidths = () => Array.from(root.querySelectorAll<HTMLElement>('colgroup col')).map((col) => col.style.width);

    try {
      decorateMarkdown(root, context);
      stabilizeMarkdownTableWidths(root, false);
      expect(columnWidths()).toEqual(['120px', '600px', '600px']);

      stabilizeMarkdownTableWidths(root, true);
      expect(columnWidths()).toEqual(['120px', '240px', '240px']);
      expect(root.querySelector('table')?.getAttribute('data-md-table-wrap')).toBe('true');
    } finally {
      root.remove();
      if (rect) Object.defineProperty(proto, 'getBoundingClientRect', rect);
      else Reflect.deleteProperty(proto, 'getBoundingClientRect');
      if (clientWidth) Object.defineProperty(proto, 'clientWidth', clientWidth);
      else Reflect.deleteProperty(proto, 'clientWidth');
    }
  });

  test('a refit at a new width reuses the measured columns, and a cached-only refit never measures', () => {
    const proto = win.HTMLElement.prototype;
    const rect = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
    const clientWidth = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    let availableWidth = 600;
    let measured = 0;
    Object.defineProperty(proto, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) { measured += 1; return { width: (this.textContent?.length ?? 0) * 10 }; },
    });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => availableWidth });

    const root = document.createElement('div');
    root.innerHTML = `<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
      <tbody><tr><td>short</td><td>${'b'.repeat(100)}</td><td>${'c'.repeat(60)}</td></tr></tbody></table>`;
    document.body.appendChild(root);
    const columnWidths = () => Array.from(root.querySelectorAll<HTMLElement>('colgroup col')).map((col) => col.style.width);

    try {
      decorateMarkdown(root, context);
      // Nothing measured yet: the cached-only path declines and leaves the table alone.
      expect(stabilizeMarkdownTableWidths(root, true, { cachedOnly: true })).toBe(false);
      expect(columnWidths()).toEqual([]);
      expect(measured).toBe(0);

      expect(stabilizeMarkdownTableWidths(root, true)).toBe(true);
      expect(columnWidths()).toEqual(['120px', '240px', '240px']);
      const afterFirstLayout = measured;
      expect(afterFirstLayout).toBeGreaterThan(0);

      // Every frame of a resize: arithmetic only, the same columns as a full layout.
      availableWidth = 1000;
      expect(stabilizeMarkdownTableWidths(root, true, { cachedOnly: true })).toBe(true);
      expect(columnWidths()).toEqual(['120px', '440px', '440px']);
      availableWidth = 400;
      expect(stabilizeMarkdownTableWidths(root, true, { cachedOnly: true })).toBe(true);
      expect(columnWidths()).toEqual(['120px', '140px', '140px']);
      expect(stabilizeMarkdownTableWidths(root, false, { cachedOnly: true })).toBe(true);
      expect(columnWidths()).toEqual(['120px', '400px', '400px']);
      expect(measured).toBe(afterFirstLayout);
      expect(root.querySelectorAll('colgroup')).toHaveLength(1);
    } finally {
      root.remove();
      if (rect) Object.defineProperty(proto, 'getBoundingClientRect', rect);
      else Reflect.deleteProperty(proto, 'getBoundingClientRect');
      if (clientWidth) Object.defineProperty(proto, 'clientWidth', clientWidth);
      else Reflect.deleteProperty(proto, 'clientWidth');
    }
  });

  test('wrapping refits columns when the available width changes', () => {
    const proto = win.HTMLElement.prototype;
    const rect = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
    const clientWidth = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    let availableWidth = 600;
    Object.defineProperty(proto, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) { return { width: (this.textContent?.length ?? 0) * 10 }; },
    });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => availableWidth });

    const root = document.createElement('div');
    root.innerHTML = `<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
      <tbody><tr><td>short</td><td>${'b'.repeat(100)}</td><td>${'c'.repeat(60)}</td></tr></tbody></table>`;
    document.body.appendChild(root);
    const columnWidths = () => Array.from(root.querySelectorAll<HTMLElement>('colgroup col')).map((col) => col.style.width);

    try {
      decorateMarkdown(root, context);
      stabilizeMarkdownTableWidths(root, true);
      expect(columnWidths()).toEqual(['120px', '240px', '240px']);

      availableWidth = 1000;
      stabilizeMarkdownTableWidths(root, true);
      expect(columnWidths()).toEqual(['120px', '440px', '440px']);

      availableWidth = 400;
      stabilizeMarkdownTableWidths(root, true);
      expect(columnWidths()).toEqual(['120px', '140px', '140px']);
      expect(root.querySelector<HTMLElement>('[data-markdown="table-wrapper"]')?.style.width).toBe('');
    } finally {
      root.remove();
      if (rect) Object.defineProperty(proto, 'getBoundingClientRect', rect);
      else Reflect.deleteProperty(proto, 'getBoundingClientRect');
      if (clientWidth) Object.defineProperty(proto, 'clientWidth', clientWidth);
      else Reflect.deleteProperty(proto, 'clientWidth');
    }
  });

  test('copies links in Markdown, CSV, and TSV', async () => {
    const copied: string[] = [];
    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } },
    });
    Object.assign(globalThis, { navigator: win.navigator });

    const root = document.createElement('div');
    root.innerHTML = `<table>
      <thead><tr><th>Repository</th><th>Review</th></tr></thead>
      <tbody>
        <tr><td>Example</td><td><a href="https://example.test/reviews/42">Review request</a> and <a href="/docs/start">guide</a></td></tr>
        <tr><td>Docs</td><td><a href="https://example.test/docs">Documentation</a></td></tr>
        <tr><td>Files</td><td><a href="https://example.test/my file.txt">Remote file</a> and <a href="my file.txt">Local file</a> and <a>plain text</a></td></tr>
      </tbody>
    </table>`;
    document.body.appendChild(root);
    decorateMarkdown(root, context);
    const detach = attachMarkdownInteractions(root, context);

    try {
      for (const format of ['markdown', 'csv', 'tsv']) {
        root.querySelector<HTMLButtonElement>(`[data-md-action="table-copy-${format}"]`)?.click();
      }

      expect(copied).toEqual([
        '| Repository | Review |\n| --- | --- |\n| Example | [Review request](https://example.test/reviews/42) and [guide](/docs/start) |\n| Docs | [Documentation](https://example.test/docs) |\n| Files | [Remote file](https://example.test/my%20file.txt) and [Local file](my%20file.txt) and plain text |',
        'Repository,Review\nExample,https://example.test/reviews/42 and /docs/start\nDocs,https://example.test/docs\nFiles,https://example.test/my%20file.txt and my%20file.txt and plain text',
        'Repository\tReview\nExample\thttps://example.test/reviews/42 and /docs/start\nDocs\thttps://example.test/docs\nFiles\thttps://example.test/my%20file.txt and my%20file.txt and plain text',
      ]);
      const reparsed = marked.parse(copied[0] ?? '');
      expect(reparsed).toContain('href="https://example.test/my%20file.txt"');
      expect(reparsed).toContain('href="my%20file.txt"');
    } finally {
      detach();
      root.remove();
    }
  });

  test('downloads Markdown with links and CSV with their URLs', async () => {
    const downloads: Blob[] = [];
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (object) => {
      if (object instanceof Blob) downloads.push(object);
      return 'blob:https://openchamber.test/table';
    };
    URL.revokeObjectURL = () => {};

    const root = document.createElement('div');
    root.innerHTML = `<table>
      <thead><tr><th>Review | Link</th></tr></thead>
      <tbody><tr><td>See <a href="https://example.test/reviews/42_(draft)?tags=a,b">[draft] | item</a> and A | B</td></tr></tbody>
    </table>`;
    document.body.appendChild(root);
    decorateMarkdown(root, context);
    const detach = attachMarkdownInteractions(root, context);

    try {
      root.querySelector<HTMLButtonElement>('[data-md-action="table-download-markdown"]')?.click();
      expect(downloads).toHaveLength(1);
      const markdown = await downloads[0]?.text();
      expect(markdown).toBe(
        '| Review \\| Link |\n| --- |\n| See [\\[draft\\] \\| item](<https://example.test/reviews/42_(draft)?tags=a,b>) and A \\| B |',
      );
      expect(marked.parse(markdown ?? '')).toContain('href="https://example.test/reviews/42_(draft)?tags=a,b"');

      root.querySelector<HTMLButtonElement>('[data-md-action="table-download-csv"]')?.click();
      expect(downloads).toHaveLength(2);
      expect(await downloads[1]?.text()).toBe(
        'Review | Link\n"See https://example.test/reviews/42_(draft)?tags=a,b and A | B"',
      );
    } finally {
      detach();
      root.remove();
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });
});

describe('Mermaid toolbar', () => {
  test('is not hidden by hover-only classes, so touch screens can reach zoom, and stays out of shared images', () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre><code class="language-mermaid">graph TD; A-->B</code></pre>';
    decorateMarkdown(root, {
      ...context,
      mermaidControls: { download: false, copy: false, showPanZoomControls: true },
      renderMermaid: () => ({ svg: '<svg viewBox="0 0 100 50"></svg>' }),
    });

    const toolbar = root.querySelector('[data-markdown="mermaid-toolbar"]');
    expect(toolbar?.querySelector('[data-md-action="mermaid-zoom-in"]')).not.toBeNull();
    const hoverOnly = Array.from(toolbar?.classList ?? []).filter((name) => name === 'opacity-0' || name.startsWith('group-'));
    expect(hoverOnly).toEqual([]);
    expect(cloneMessageImageExportSource(root).querySelector('[data-markdown="mermaid-toolbar"]')).toBeNull();
  });
});

describe('Markdown selection copy', () => {
  const copySelection = async (getCopyFormat: DecorateContext['getCopyFormat']): Promise<string[]> => {
    const copied: string[] = [];
    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } },
    });
    Object.assign(globalThis, { navigator: win.navigator });

    const root = document.createElement('div');
    root.setAttribute('data-markdown-content', '');
    root.innerHTML = '<h2>Setup</h2><ul><li>Install <strong><code>playwright</code></strong></li></ul>';
    document.body.appendChild(root);
    const detach = attachMarkdownInteractions(root, { ...context, getCopyFormat });

    try {
      const range = document.createRange();
      range.selectNodeContents(root);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      win.dispatchEvent(new win.Event('openchamber:copy', { cancelable: true }));
      await Promise.resolve();
      return copied;
    } finally {
      document.getSelection()?.removeAllRanges();
      detach();
      root.remove();
    }
  };

  test('copies Markdown source by default', async () => {
    expect(await copySelection(undefined)).toEqual(['## Setup\n\n- Install **`playwright`**']);
  });

  test('copies the visible text when the user chose plain text', async () => {
    expect(await copySelection(() => 'plain')).toEqual(['Setup\n\n• Install playwright']);
  });
});

describe('Code block lines', () => {
  const SOURCE = 'const a = 1;\n\nconst b = 2;\n';
  const highlighted = '<pre data-md-lang="ts"><code><span class="line"><span style="color:red">const a = 1;</span></span>\n<span class="line"></span>\n<span class="line"><span>const b = 2;</span></span>\n<span class="line"></span></code></pre>';

  const decorated = (html: string, ctx: DecorateContext = context): HTMLElement => {
    const root = document.createElement('div');
    root.innerHTML = html;
    decorateMarkdown(root, ctx);
    return root;
  };
  const codeOf = (root: HTMLElement): HTMLElement => {
    const code = root.querySelector<HTMLElement>('pre > code');
    if (!code) throw new Error('missing code');
    return code;
  };
  // The shape the line-number counter reads: `.line` children separated by
  // single line breaks, and nothing else.
  const codeChildren = (code: HTMLElement): string[] => Array.from(code.childNodes, (node) => (
    node instanceof Element ? `${node.className}:${node.textContent}` : JSON.stringify(node.textContent)
  ));

  test('Shiki lines are kept as they are: no element per line number', () => {
    const root = decorated(highlighted);
    const code = codeOf(root);
    expect(code.hasAttribute('data-md-code-lines')).toBe(true);
    expect(codeChildren(code)).toEqual(['line:const a = 1;', '"\\n"', 'line:', '"\\n"', 'line:const b = 2;', '"\\n"', 'line:']);
    expect(code.querySelectorAll('*')).toHaveLength(6);
    expect(code.textContent).toBe(SOURCE);
  });

  test('unhighlighted code gets the lines Shiki would give it', () => {
    const code = codeOf(decorated(marked.parse(`\`\`\`ts\n${SOURCE}\`\`\``, { async: false })));
    expect(codeChildren(code)).toEqual(codeChildren(codeOf(decorated(highlighted))));
    expect(code.textContent).toBe(SOURCE);
    // Decorating again changes nothing.
    const parent = code.closest<HTMLElement>('[data-component="markdown-code"]')?.parentElement;
    if (!parent) throw new Error('missing wrapper');
    const html = parent.innerHTML;
    decorateMarkdown(parent, context);
    expect(parent.innerHTML).toBe(html);
  });

  test('the empty line after a trailing line break is emptied so it is hidden and unnumbered', () => {
    // Shiki's plain-text grammar puts an empty token span in that line.
    const code = codeOf(decorated('<pre data-md-lang="text"><code><span class="line"><span>row 1</span></span>\n<span class="line"><span></span></span></code></pre>'));
    expect(codeChildren(code)).toEqual(['line:row 1', '"\\n"', 'line:']);
    expect(code.lastElementChild?.childNodes).toHaveLength(0);
    expect(code.textContent).toBe('row 1\n');
  });

  test('an empty block keeps one line', () => {
    const code = codeOf(decorated('<pre><code></code></pre>'));
    expect(codeChildren(code)).toEqual(['line:']);
  });

  test('the wrap setting styles the block, not each line', () => {
    const root = decorated(highlighted);
    applyMarkdownCodeBlockWrapState(root, true, context.labels);
    expect(codeOf(root).style.whiteSpace).toBe('pre-wrap');
    expect(Array.from(codeOf(root).querySelectorAll<HTMLElement>('.line')).some((line) => line.getAttribute('style'))).toBe(false);
  });

  test('the copy button and a copied selection give the source without line numbers', async () => {
    const copied: string[] = [];
    Object.defineProperty(win.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } },
    });
    Object.assign(globalThis, { navigator: win.navigator });
    const root = decorated(highlighted);
    root.setAttribute('data-markdown-content', '');
    document.body.appendChild(root);
    const detach = attachMarkdownInteractions(root, context);

    try {
      root.querySelector<HTMLButtonElement>('[data-md-action="copy-code"]')?.click();
      await Promise.resolve();
      expect(copied).toEqual([SOURCE]);

      // From inside line 1 to inside line 3, across the empty line.
      const lines = codeOf(root).querySelectorAll('.line');
      const first = lines[0]?.firstChild?.firstChild;
      const third = lines[2]?.firstChild?.firstChild;
      if (!first || !third) throw new Error('missing line text');
      const range = document.createRange();
      range.setStart(first, 6);
      range.setEnd(third, 7);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const clipboard = new Map<string, string>();
      const event = new win.Event('copy', { cancelable: true, bubbles: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: (type: string, value: string) => { clipboard.set(type, value); } },
      });
      win.document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(clipboard.get('text/plain')).toBe('a = 1;\n\nconst b');
      expect(clipboard.has('text/html')).toBe(false);
    } finally {
      document.getSelection()?.removeAllRanges();
      detach();
      root.remove();
    }
  });
});
