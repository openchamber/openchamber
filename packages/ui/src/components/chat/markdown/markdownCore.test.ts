import { describe, expect, mock, test } from 'bun:test';

type SanitizeAttribute = {
  attrName: string;
  attrValue: string;
  forceKeepAttr?: boolean;
};

class TestAnchorElement {
  target = '';

  setAttribute(name: string, value: string): void {
    if (name === 'target') this.target = value;
  }
}

const sanitizeHooks: {
  uponSanitizeAttribute?: (node: unknown, data: SanitizeAttribute) => void;
  afterSanitizeAttributes?: (node: unknown) => void;
} = {};

// Mirrors DOMPurify's default URI policy: approved schemes plus relative URLs.
const DOMPURIFY_ALLOWED_URI_RE =
  // Keep this byte-aligned with DOMPurify's default IS_ALLOWED_URI expression.
  // eslint-disable-next-line no-useless-escape
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
const URI_ATTRIBUTE_WHITESPACE_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

Object.assign(globalThis, {
  window: {},
  HTMLAnchorElement: TestAnchorElement,
});

mock.module('dompurify', () => ({
  default: {
    isSupported: true,
    addHook: (name: keyof typeof sanitizeHooks, hook: never) => {
      sanitizeHooks[name] = hook;
    },
    sanitize: (html: string) => html.replace(/ href="([^"]*)"/g, (attribute, href: string) => {
      const anchor = new TestAnchorElement();
      const data: SanitizeAttribute = { attrName: 'href', attrValue: href };
      sanitizeHooks.uponSanitizeAttribute?.(anchor, data);
      sanitizeHooks.afterSanitizeAttributes?.(anchor);

      const normalizedHref = href.replace(URI_ATTRIBUTE_WHITESPACE_RE, '');
      return data.forceKeepAttr || DOMPURIFY_ALLOWED_URI_RE.test(normalizedHref)
        ? attribute
        : '';
    }),
  },
}));
mock.module('./markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
}));

import { escapeRawMarkdownHtml, isLocalFileUrl, MARKDOWN_FORBIDDEN_TAGS } from './markdownSecurity';

const {
  __markdownImageCandidateCacheForTests,
  extractMarkdownImageCandidates,
  getCachedMarkdownBlocks,
  renderMarkdownBlocks,
  renderMarkdownSync,
  resetMarkdownHtmlCacheForTests,
} = await import('./markdownCore');
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

  test('keeps app and local file links while stripping blocked schemes', () => {
    const html = renderMarkdownSync([
      '[app](obsidian://open?vault=Notebook)',
      '[file](file:///workspace/notes.md)',
      '[script](javascript:alert(1))',
      '[diagnostic](ms-msdt:/id%20PCWDiagnostic)',
    ].join('\n\n'), 'inline');

    expect(html).toContain('href="obsidian://open?vault=Notebook"');
    expect(html).toContain('href="file:///workspace/notes.md"');
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).not.toContain('href="ms-msdt:/id%20PCWDiagnostic"');
  });

});

describe('Markdown block cache reads', () => {
  test('returns all settled blocks synchronously after a full cache hit', async () => {
    resetMarkdownHtmlCacheForTests();
    const text = '**cached** settled markdown';

    expect(getCachedMarkdownBlocks(text)).toBeNull();
    const rendered = await renderMarkdownBlocks(text, false);

    expect(getCachedMarkdownBlocks(text)).toEqual(rendered);
  });

  test('returns null for a cold or partial settled miss', async () => {
    resetMarkdownHtmlCacheForTests();
    const first = 'first settled block';
    const changed = 'first settled block\n\nsecond settled block';

    await renderMarkdownBlocks(first, false);

    expect(getCachedMarkdownBlocks(changed)).toBeNull();
  });

  test('keeps image mode identity out of the settled full hit', async () => {
    resetMarkdownHtmlCacheForTests();
    const text = '![image](https://example.test/image.png)';

    await renderMarkdownBlocks(text, false, 'inline');

    expect(getCachedMarkdownBlocks(text, 'label')).toBeNull();
    expect(getCachedMarkdownBlocks(text, 'inline')).not.toBeNull();
  });

  test('does not treat streaming live-cache entries as settled full hits', async () => {
    resetMarkdownHtmlCacheForTests();
    const text = 'streaming markdown';

    await renderMarkdownBlocks(text, true);

    expect(getCachedMarkdownBlocks(text)).toBeNull();
  });
});

describe('Markdown images', () => {
  test('renders assistant images as icon-ready text without loading the source', () => {
    const html = renderMarkdownSync([
      '[linked image](packages/vscode/extension.jpg)',
      '![image syntax](packages/vscode/extension.jpg)',
    ].join('\n\n'), 'label');

    expect(html).toContain('data-openchamber-markdown-image-label="true"');
    expect(html).toContain('extension.jpg');
    expect(html).not.toContain('image syntax');
    expect(html).not.toContain('<img');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  test('keeps non-chat Markdown images inline', () => {
    const html = renderMarkdownSync([
      '[remote link](https://example.test/image.png)',
      '![remote image](https://example.test/image.png)',
    ].join('\n\n'));

    expect(html).toContain('<a href="https://example.test/image.png"');
    expect(html).toContain('<img src="https://example.test/image.png" alt="remote image">');
    expect(html).not.toContain('data-openchamber-markdown-image-label');
  });

  test('collects image syntax across mixed Markdown and ignores links and code', () => {
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

  test('does not add an ordinary local image link to the gallery', () => {
    expect(extractMarkdownImageCandidates(['[download](screens/image.png)'])).toEqual([]);
  });

  test('limits one finalized message gallery to twelve unique candidates', () => {
    const markdown = Array.from({ length: 14 }, (_, index) => `![image ${index}](screens/${index}.png)`).join('\n');

    const candidates = extractMarkdownImageCandidates([markdown]);

    expect(candidates).toHaveLength(12);
    expect(candidates.at(-1)?.source).toBe('screens/11.png');
  });

  test('reuses extracted candidates across virtualized remounts without changing gallery behavior', () => {
    __markdownImageCandidateCacheForTests.reset();
    const contents = Array.from({ length: 20 }, (_, index) => `![image ${index}](screens/${index}.png)`);

    expect(extractMarkdownImageCandidates(contents)).toHaveLength(12);
    expect(__markdownImageCandidateCacheForTests.stats().scans).toBe(12);

    for (let round = 0; round < 1000; round += 1) {
      expect(extractMarkdownImageCandidates(contents)).toHaveLength(12);
    }

    const stats = __markdownImageCandidateCacheForTests.stats();
    expect(stats.entries).toBe(12);
    expect(stats.scans).toBe(12);
  });

  test('scans one thousand independent messages once across virtualized remounts', () => {
    __markdownImageCandidateCacheForTests.reset();
    const messages = Array.from(
      { length: 1000 },
      (_, index) => `![image ${index}](screens/${index}.png)`,
    );

    for (const message of messages) extractMarkdownImageCandidates([message]);
    for (const message of messages) extractMarkdownImageCandidates([message]);

    const stats = __markdownImageCandidateCacheForTests.stats();
    expect(stats.entries).toBe(1000);
    expect(stats.scans).toBe(1000);
  });

  test('gives embedded images without alt text a stable filename', () => {
    const source = 'data:image/png;base64,AAAA';

    expect(extractMarkdownImageCandidates([`![](${source})`])).toEqual([
      { source, filename: 'image.png' },
    ]);
    expect(renderMarkdownSync(`![](${source})`, 'label')).toContain('image.png');
  });

  test('bounds cached candidate entries and bytes, and skips oversized individual content', () => {
    __markdownImageCandidateCacheForTests.reset();
    for (let index = 0; index < 1025; index += 1) {
      extractMarkdownImageCandidates([`![image ${index}](screens/${index}.png)`]);
    }
    const boundedStats = __markdownImageCandidateCacheForTests.stats();
    expect(boundedStats.entries).toBe(1024);
    expect(boundedStats.bytes <= 2 * 1024 * 1024).toBe(true);

    __markdownImageCandidateCacheForTests.reset();
    const oversized = `![image](screens/large.png)\n${'x'.repeat(64 * 1024)}`;

    extractMarkdownImageCandidates([oversized]);
    extractMarkdownImageCandidates([oversized]);
    expect(__markdownImageCandidateCacheForTests.stats()).toEqual({ entries: 0, bytes: 0, scans: 2 });
  });

  test('validates embedded image bytes against the declared MIME type', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const signal = new AbortController().signal;

    expect(await resolveMarkdownImageSource(`data:image/png;base64,${png}`, signal)).toBe(`data:image/png;base64,${png}`);
    await resolveMarkdownImageSource(`data:image/jpeg;base64,${png}`, signal).then(
      () => { throw new Error('Expected mismatched image data to fail'); },
      (error: unknown) => expect((error as Error).message).toBe('Unsupported image data'),
    );
  });

  test('does not resolve images after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    await resolveMarkdownImageSource('https://example.test/image.png', controller.signal).then(
      () => { throw new Error('Expected an aborted image load to fail'); },
      (error: unknown) => expect((error as Error).name).toBe('AbortError'),
    );
  });

  test('keeps the existing image renderer outside finalized assistant text', () => {
    const html = renderMarkdownSync('![tool image](https://example.test/image.png)');

    expect(html).toContain('<img src="https://example.test/image.png"');
    expect(html).not.toContain('data-openchamber-markdown-image');
  });
});

describe('CJK-aware link parsing', () => {
  const hrefOf = (html: string): string | null => /<a\b[^>]*href="([^"]*)"/.exec(html)?.[1] ?? null;

  test('bare URL followed by a CJK annotation trims the annotation from the href', () => {
    const html = renderMarkdownSync('访问 https://example.com/docs（中文说明）了解更多');
    expect(hrefOf(html)).toBe('https://example.com/docs');
  });

  test('bare URL followed by CJK punctuation trims the punctuation', () => {
    expect(hrefOf(renderMarkdownSync('地址 https://example.com/guide，详见'))).toBe(
      'https://example.com/guide',
    );
    expect(hrefOf(renderMarkdownSync('官网 https://example.com。'))).toBe('https://example.com');
  });

  test('correct links are unaffected', () => {
    expect(hrefOf(renderMarkdownSync('官方文档见 [这里](https://docs.example.com)（中文说明）'))).toBe(
      'https://docs.example.com',
    );
    expect(hrefOf(renderMarkdownSync('[下载](https://dl.example.com/安装包（正式版）)'))).toBe(
      'https://dl.example.com/安装包（正式版）',
    );
    expect(hrefOf(renderMarkdownSync('[a](url(1))'))).toBe('url(1)');
    expect(hrefOf(renderMarkdownSync('[a](url "title")'))).toBe('url');
  });
});

describe('Escaped brackets versus display math', () => {
  // `\[...\]` is display math in LaTeX and an escaped bracket pair in
  // CommonMark. Prose escapes brackets far more often than it opens display
  // math mid-sentence, so math only wins when it owns its line.
  test('keeps escaped brackets inside a link as link text', () => {
    const html = renderMarkdownSync(
      '[OpenChamber session completed: OPE-316 \\[Bug\\] Opening files](https://example.com/?session=ses_1)',
    );
    expect(html).toContain('href="https://example.com/?session=ses_1"');
    expect(html).toContain('[Bug]');
    expect(html).not.toContain('katex');
  });

  test('leaves escaped brackets in prose as literal brackets', () => {
    const html = renderMarkdownSync('Release \\[Bug\\] fixed in v2.');
    expect(html).toContain('[Bug]');
    expect(html).not.toContain('katex');
  });

  // Verbatim body of a Linear status comment, which Linear itself renders as
  // one link while we used to split it into three blocks.
  test('renders a Linear comment with an escaped-bracket title as one link', () => {
    const html = renderMarkdownSync(
      '[OpenChamber session completed: OPE-316 \\[Bug\\] Opening files with template-literal'
      + ' code triggers catastrophic backtracking → renderer OOM → black/frozen desktop app'
      + ' (v1.17.2)](http://127.0.0.1:63418/?session=ses_fb0bb916effe26bQ1Ofr6Rv4Ei)',
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('[Bug]');
    expect(html).not.toContain('katex');
  });

  test('still renders display math that owns its line', () => {
    expect(renderMarkdownSync('\\[x = y\\]')).toContain('katex');
    expect(renderMarkdownSync('Before\n\n\\[\nx = y\n\\]\n\nAfter')).toContain('katex');
  });
});
