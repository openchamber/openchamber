import { describe, expect, mock, test } from 'bun:test';

mock.module('dompurify', () => ({
  default: {
    isSupported: true,
    addHook: () => undefined,
    sanitize: (html: string) => html,
  },
}));
mock.module('./markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
}));

import { escapeRawMarkdownHtml, isLocalFileUrl, MARKDOWN_FORBIDDEN_TAGS } from './markdownSecurity';

const { extractMarkdownImageCandidates, renderMarkdownSync } = await import('./markdownCore');
const { resolveMarkdownImageSource } = await import('./markdownImageAssets');

describe('markdown sanitization', () => {
  test('turns raw assistant HTML into inert visible text', () => {
    const payload = '<style>@import url("https://example.test/theme.css");</style>';

    expect(escapeRawMarkdownHtml(payload)).toBe(
      '&lt;style&gt;@import url(&quot;https://example.test/theme.css&quot;);&lt;/style&gt;',
    );
  });

  test('forbids script and stylesheet elements as active content', () => {
    expect(MARKDOWN_FORBIDDEN_TAGS).toContain('script');
    expect(MARKDOWN_FORBIDDEN_TAGS).toContain('style');
  });

  test('allows only local file URLs through the sanitizer policy', () => {
    expect(isLocalFileUrl('file:///private/tmp/report%20viewer.html')).toBe(true);
    expect(isLocalFileUrl('file://localhost/private/tmp/REPORT.md')).toBe(true);
    expect(isLocalFileUrl('file://remote-host/share/report.html')).toBe(false);
    expect(isLocalFileUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('Markdown images', () => {
  test('keeps local image links in text and emits inert image placeholders', () => {
    const html = renderMarkdownSync([
      '[linked image](packages/vscode/extension.jpg)',
      '![image syntax](packages/vscode/extension.jpg)',
    ].join('\n\n'), true);

    expect(html).toContain('data-openchamber-markdown-image-link="true"');
    expect(html.match(/data-openchamber-markdown-image-source="packages\/vscode\/extension.jpg"/g)).toHaveLength(1);
    expect(html).toContain('data-openchamber-markdown-image-placeholder="true"');
    expect(html).toContain('image syntax');
    expect(html).not.toContain('src="packages/vscode/extension.jpg"');
    expect(html).not.toContain('data-openchamber-markdown-image-state');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test('keeps HTTP links as links and defers remote image tokens to finalized rendering', () => {
    const html = renderMarkdownSync([
      '[remote link](https://example.test/image.png)',
      '![remote image](https://example.test/image.png)',
    ].join('\n\n'), true);

    expect(html).toContain('<a href="https://example.test/image.png"');
    expect(html).not.toContain('<img');
    expect(html).toContain('data-openchamber-markdown-image-placeholder="true"');
    expect(html).toContain('remote image');
  });

  test('preserves file URLs inertly and never activates unknown schemes', () => {
    const html = renderMarkdownSync([
      '![file](file:///workspace/image.png)',
      '![unsafe](javascript:alert(1))',
    ].join('\n\n'), true);

    expect(html).toContain('role="img"');
    expect(html).not.toContain('src="file:');
    expect(html).not.toContain('src="javascript:');
  });

  test('collects a single ordered gallery across mixed Markdown and ignores code', () => {
    const candidates = extractMarkdownImageCandidates([
      [
        'Before [local link](screens/first%20view.png) and `![code](ignored.png)`.',
        '',
        '- ![duplicate](screens/first%20view.png)',
        '- ![remote](https://example.test/second.webp?size=2)',
        '',
        '```md',
        '![fenced](ignored-too.jpg)',
        '```',
      ].join('\n'),
      'After ![third](data:image/png;base64,AAAA).',
    ]);

    expect(candidates).toEqual([
      { source: 'screens/first%20view.png', filename: 'first view.png' },
      { source: 'https://example.test/second.webp?size=2', filename: 'second.webp' },
      { source: 'data:image/png;base64,AAAA', filename: 'third' },
    ]);
  });

  test('limits one finalized message gallery to twelve unique candidates', () => {
    const markdown = Array.from({ length: 14 }, (_, index) => `![image ${index}](screens/${index}.png)`).join('\n');

    const candidates = extractMarkdownImageCandidates([markdown]);

    expect(candidates).toHaveLength(12);
    expect(candidates.at(-1)?.source).toBe('screens/11.png');
  });

  test('validates embedded image bytes against the declared MIME type', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const signal = new AbortController().signal;

    expect(await resolveMarkdownImageSource(`data:image/png;base64,${png}`, '', signal)).toBe(`data:image/png;base64,${png}`);
    await resolveMarkdownImageSource(`data:image/jpeg;base64,${png}`, '', signal).then(
      () => { throw new Error('Expected mismatched image data to fail'); },
      (error: unknown) => expect((error as Error).message).toBe('Unsupported image data'),
    );
  });

  test('does not resolve images after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    await resolveMarkdownImageSource('https://example.test/image.png', '', controller.signal).then(
      () => { throw new Error('Expected an aborted image load to fail'); },
      (error: unknown) => expect((error as Error).name).toBe('AbortError'),
    );
  });

  test('keeps the existing image renderer outside finalized assistant text', () => {
    const html = renderMarkdownSync('![tool image](https://example.test/image.png)');

    expect(html).toContain('<img src="https://example.test/image.png"');
    expect(html).not.toContain('data-openchamber-markdown-image-placeholder');
  });
});
