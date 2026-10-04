import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { marked } from 'marked';
import { attachMarkdownInteractions, decorateMarkdown, type DecorateContext } from './decorate';

const win = new Window({ url: 'https://openchamber.test/' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  Element: win.Element,
  HTMLTableElement: win.HTMLTableElement,
});

const context: DecorateContext = {
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

describe('Markdown table actions', () => {
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
