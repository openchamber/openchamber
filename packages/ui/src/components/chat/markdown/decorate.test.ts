import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { marked } from 'marked';
import { cloneMessageImageExportSource } from '../message/imageExport';
import { attachMarkdownInteractions, decorateMarkdown, stabilizeMarkdownTableWidths, type DecorateContext } from './decorate';

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
