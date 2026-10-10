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
  __scanStatsForTests,
  extractMarkdownImageCandidates,
  getCachedMarkdownBlocks,
  LINKIFY_SOURCE_LIMIT,
  renderMarkdownBlocks,
  renderMarkdownSync,
  resetScanStatsForTests,
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

  test('keeps session links, including pasted ones, and strips other OpenChamber routes', () => {
    const html = renderMarkdownSync([
      'Pasted: openchamber://session/ses_abc?message=msg_123',
      '[labelled](openchamber://session/ses_abc)',
      '[pairing](openchamber://connect?v=2&p=secret)',
    ].join('\n\n'), 'inline');

    expect(html).toContain('href="openchamber://session/ses_abc?message=msg_123"');
    expect(html).toContain('href="openchamber://session/ses_abc"');
    expect(html).not.toContain('href="openchamber://connect');
  });

  test('renders an attachment citation as a labelled chip without a link', () => {
    const html = renderMarkdownSync('See [shot.png](#openchamber-attachment:png:shot%40%282x%29.png) here', 'inline');

    expect(html).toContain('data-attachment-citation="png"');
    expect(html).toContain('>shot@(2x).png</span>');
    expect(html).not.toContain('href="#openchamber-attachment');
  });

  test('renders a skill link as a chip that still opens the skill', () => {
    const html = renderMarkdownSync('Use [/review](#openchamber-skill:review) here', 'inline');

    expect(html).toContain('data-skill-name="review"');
    expect(html).toContain('title="$review">review</a>');
  });

});

describe('Markdown parser failures', () => {
  // Real parser recursion overflow, rather than a mocked parse failure. Each
  // quote level re-lexes the rest of the line, so the cost grows with the square
  // of the depth an overflow needs. Bun on Windows allows a stack several times
  // deeper than on Linux, where one parse then takes seconds, so these tests get
  // their own timeout. A bare `>` nests the same way at half the length.
  const PARSER_OVERFLOW_TIMEOUT_MS = 60_000;
  const source = `${'>'.repeat(20000)}<img src=x onerror="alert(1)"> & text\n  **unfinished`;
  const fallback = `<div class="whitespace-pre-wrap break-words">${escapeRawMarkdownHtml(source)}</div>`;

  test('preserves source as inert text on first paint in both image modes', () => {
    expect(renderMarkdownSync(source, 'inline')).toBe(fallback);
    expect(renderMarkdownSync(source, 'label')).toBe(fallback);
    expect(renderMarkdownSync('**healthy**')).toContain('<strong>healthy</strong>');
  }, PARSER_OVERFLOW_TIMEOUT_MS);

  test('keeps streaming and settled rendering readable and caches the settled fallback', async () => {
    resetMarkdownHtmlCacheForTests();
    for (const streaming of [true, false]) {
      const blocks = await renderMarkdownBlocks(source, streaming);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.html).toBe(fallback);
    }
    expect(getCachedMarkdownBlocks(source)?.[0]?.html).toBe(fallback);
    const healthy = await renderMarkdownBlocks('**still healthy**', false);
    expect(healthy[0]?.html).toContain('<strong>still healthy</strong>');
  }, PARSER_OVERFLOW_TIMEOUT_MS);

  test('keeps images from other messages when one message cannot be scanned', () => {
    expect(extractMarkdownImageCandidates([
      '![before](https://example.test/before.png)',
      source,
      '![after](https://example.test/after.png)',
    ])).toEqual([
      { source: 'https://example.test/before.png', filename: 'before.png' },
      { source: 'https://example.test/after.png', filename: 'after.png' },
    ]);
  }, PARSER_OVERFLOW_TIMEOUT_MS);
});

describe('Markdown disclosures', () => {
  test('renders summaries and rich Markdown without allowing raw HTML attributes', () => {
    const html = renderMarkdownSync('<details open><summary>Review **ready**</summary>\n\n> Quoted review\n\n1. First\n2. Second\n\n```sh\nbun test\n```\n\n</details>\n\nAfter');
    expect(html).toContain('<details data-md-details open>');
    expect(html).toContain('<summary>Review <strong>ready</strong></summary>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<code class="language-sh">bun test');
    expect(html).toContain('</details><p>After</p>');
    const unsafe = renderMarkdownSync('<details onclick="alert(1)"><summary>Unsafe</summary>text</details>');
    expect(unsafe).not.toContain('<details');
    expect(unsafe).toContain('&lt;details');
    expect(renderMarkdownSync('<details><summary>Safe</summary>\n\n<style>body{display:none}</style>\n\n</details>')).not.toContain('<style>');
  });

  test('keeps nested disclosures and literal closing tags inside code in their owner', () => {
    const source = '<details><summary>Outer</summary>\n\n`</details>`\n\n```html\n</details>\n```\n\n<details open><summary>Inner</summary>\n\n**Nested**\n\n</details>\n\nOuter end\n\n</details>\n\nAfter';
    const html = renderMarkdownSync(source);
    expect(html.match(/<details /g)).toHaveLength(2);
    expect(html).toContain('<code>&lt;/details&gt;</code>');
    expect(html).toContain('<strong>Nested</strong>');
    expect(html).toContain('</details><p>Outer end</p>');
    expect(html).toContain('</details><p>After</p>');
    expect(renderMarkdownSync('```html\n<details><summary>Example</summary></details>\n```')).not.toContain('<details');
  });

  test('keeps streamed bodies together and settled leading blocks cache-stable', async () => {
    const prefix = 'Introduction\n\n<details><summary>Review</summary>\n\n';
    const first = await renderMarkdownBlocks(`${prefix}> First\n\n1. Item`, true);
    const next = await renderMarkdownBlocks(`${prefix}> First\n\n1. Item\n2. More\n\n\`\`\`sh\nbun test`, true);
    expect(first).toHaveLength(2);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(first[0]);
    expect(next[1]?.html).toContain('<details data-md-details>');
    expect(next[1]?.html).toContain('<li>More</li>');
    expect(next[1]?.html).toContain('bun test');
    expect(next[1]?.html.endsWith('</details>')).toBe(true);
    const finished = await renderMarkdownBlocks(`${prefix}> First\n\n</details>\n\nAfter`, true);
    expect(finished).toHaveLength(3);
    expect(finished[2]?.html).toContain('<p>After</p>');
  });

  test('handles incomplete summary and closing tag prefixes without losing content', async () => {
    const source = '<details><summary>Review</summary>\n\n**Body**\n\n</details>';
    for (let length = 1; length <= source.length; length += 1) {
      const blocks = await renderMarkdownBlocks(source.slice(0, length), true);
      const html = blocks.map((block) => block.html).join('');
      if (length >= source.indexOf('\n\n')) expect(html).toContain('<details data-md-details>');
      if (length >= source.indexOf('\n\n</details>')) {
        expect(html).toContain('<strong>Body</strong>');
      }
    }
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

  test('links remote images in tool output and keeps local ones drawn', () => {
    const html = renderMarkdownSync([
      '![tracker](https://evil.example/pixel.png?seen=secret)',
      '![screenshot](screens/run.png)',
      '[![badge](https://img.shields.io/badge/ci-passing-green)](https://ci.example)',
    ].join('\n\n'), 'local');

    // The remote image never becomes an <img>: it is a link to open on purpose.
    expect(html).not.toContain('<img src="https://');
    expect(html).toContain('<a href="https://evil.example/pixel.png?seen=secret" class="external-link"');
    expect(html).toContain('<img src="screens/run.png" alt="screenshot">');
    // A badge inside a link stays a label: a link cannot hold another.
    expect(html.match(/<a /g)).toHaveLength(2);
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

describe('Long paragraphs', () => {
  const hrefOf = (html: string): string | null => /<a\b[^>]*href="([^"]*)"/.exec(html)?.[1] ?? null;
  const LIMIT = LINKIFY_SOURCE_LIMIT;
  const cjkLink = 'https://example.com。 ';
  // The link opens the paragraph, so linkify sees the whole paragraph as the
  // text that remains.
  const paragraphOf = (length: number): string => `${cjkLink}${'x'.repeat(length - cjkLink.length)}`;

  // The reporter's data dump from openchamber/openchamber#4204: pretty-printed
  // JSON with no blank line, about 250 KB in one paragraph.
  const dataDump = (): string => {
    let seed = 7;
    const pick = (values: readonly string[]): string | undefined => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return values[Math.floor((seed / 0x100000000) * values.length)];
    };
    const rows = Array.from({ length: 1800 }, (_, i) => ({
      id: `item_${i}`,
      label: pick(['alpha_beta', 'gamma_delta', 'epsilon_zeta', 'eta_theta', 'iota_kappa']),
      link: pick(['/Main', '/List', '/Detail', '/data/nested']),
      count_a: 1000 + i,
      ratio_b: 30 + (i % 20),
      state: pick(['ok', 'warning', 'unread']),
    }));
    return `Review the following data dump. Docs: https://example.com/docs\n\n${JSON.stringify(rows, null, 2)}\nwith \\(x^2\\) at the end`;
  };

  test('a paragraph up to the limit keeps the CJK-aware link boundary', () => {
    expect(paragraphOf(LIMIT)).toHaveLength(LIMIT);
    expect(hrefOf(renderMarkdownSync(paragraphOf(LIMIT)))).toBe('https://example.com');
    expect(hrefOf(renderMarkdownSync(paragraphOf(LIMIT - 1)))).toBe('https://example.com');
  });

  test('a longer paragraph still links bare URLs, through the GFM autolink', () => {
    expect(hrefOf(renderMarkdownSync(paragraphOf(LIMIT + 1)))).toBe('https://example.com。');
  });

  test('long messages of short paragraphs and large code blocks keep linkify', () => {
    const log = Array.from({ length: 400 }, (_, i) => `line ${i}: status ok`).join('\n');
    const withCode = `See ${cjkLink}\n\n\`\`\`\n${log}\n\`\`\``;
    expect(log.length).toBeGreaterThan(LIMIT);
    expect(hrefOf(renderMarkdownSync(withCode))).toBe('https://example.com');

    const crlf = Array.from({ length: 200 }, () => `See ${cjkLink}`).join('\r\n\r\n');
    expect(crlf.length).toBeGreaterThan(LIMIT);
    const html = renderMarkdownSync(crlf);
    expect(html.match(/href="https:\/\/example\.com"/g)).toHaveLength(200);
  });

  test('the data dump from the report opens without the quadratic rescan', async () => {
    resetMarkdownHtmlCacheForTests();
    const text = dataDump();
    expect(text.length).toBeGreaterThan(250_000);
    // Opening a message paints it synchronously, then renders its blocks.
    // Before the fix linkify searched the rest of the paragraph at every inline
    // token, billions of characters for this dump. Now it only searches while
    // at most LIMIT characters remain, which bounds each paragraph by LIMIT².
    resetScanStatsForTests();
    const html = renderMarkdownSync(text);
    const settled = await renderMarkdownBlocks(text, false);
    expect(__scanStatsForTests().linkify).toBeLessThan(2 * LIMIT * LIMIT);
    expect(html).toContain('item_1799');
    expect(hrefOf(html)).toBe('https://example.com/docs');
    expect(html).toContain('class="katex"');
    expect(settled.map((block) => block.html).join('')).toContain('item_1799');
  });

  test('a paragraph without `:`, `/` or `@` skips the linkify search', () => {
    // Every bold and emphasis span is an inline token, and linkify searched the
    // rest of the paragraph at each one (openchamber/openchamber#4648).
    const prose = 'A simple sentence with **bold** and _emphasis_. '.repeat(80);
    expect(prose.length).toBeLessThan(LIMIT);
    resetScanStatsForTests();
    expect(renderMarkdownSync(prose)).toContain('<strong>bold</strong>');
    expect(__scanStatsForTests().linkify).toBe(0);

    resetScanStatsForTests();
    expect(hrefOf(renderMarkdownSync(`${prose}${cjkLink}`))).toBe('https://example.com');
    expect(__scanStatsForTests().linkify).toBeGreaterThan(0);
  });
});

describe('Many short paragraphs', () => {
  const paragraphs = Array.from({ length: 16_000 }, (_, i) => `Paragraph ${i} is short.`).join('\n\n');
  const text = `${paragraphs}\n\n\\[\nx^2\n\\]\n\n<details><summary>More</summary>\n\nHidden text\n\n</details>`;

  // Before, each block searched the rest of the message for `\\[` and
  // `<details>`: about 3 billion characters here. Now each search stops at the
  // end of the paragraph. User messages reach the renderer with every newline
  // turned into "  \n", so their empty lines hold two spaces.
  for (const [label, source] of [
    ['assistant text', text],
    ['user text', text.replace(/ *\n/g, '  \n')],
  ] as const) test(`block math and disclosures after thousands of paragraphs render in linear work (${label})`, () => {
    expect(source.length).toBeGreaterThan(400_000);
    resetScanStatsForTests();
    const html = renderMarkdownSync(source);
    expect(__scanStatsForTests().blockStart).toBeLessThan(4 * source.length);
    expect(html).toContain('Paragraph 15999 is short.');
    expect(html.match(/<p>/g)?.length).toBeGreaterThan(16_000);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('Hidden text');
  });

  // A line that interrupts a paragraph but is not a block of its own (an empty
  // list marker, a table header with a broken delimiter row) used to be glued
  // back onto the paragraph only when `\\[` or `<details>` appeared further down.
  for (const [label, source, expected] of [
    ['an empty list marker', 'text\n1. ', '<p>text</p>\n<p>1. </p>'],
    ['a broken table', 'Intro text\n| a |\n|---|---|\nrow', '<p>Intro text</p>\n<p>| a |'],
  ] as const) test(`${label} renders the same whether or not math follows`, () => {
    const withoutMath = renderMarkdownSync(`${source}\n\nmore`);
    const withMath = renderMarkdownSync(`${source}\n\n\\[x\\]`);
    expect(withoutMath.startsWith(expected)).toBe(true);
    expect(withMath.startsWith(expected)).toBe(true);
  });

  test('a disclosure or display math right after a paragraph line still ends it', () => {
    expect(renderMarkdownSync('Intro line\n\\[\nx\n\\]')).toContain('<p>Intro line</p>');
    const disclosure = renderMarkdownSync('Intro line\n<details><summary>S</summary>\n\nBody\n\n</details>');
    expect(/<p>Intro line<\/p>\s*<details data-md-details>/.test(disclosure)).toBe(true);
  });
});

describe('Streaming heal', () => {
  const streamed = async (text: string): Promise<string> =>
    (await renderMarkdownBlocks(text, true)).map((block) => block.html).join('');

  test('an unfinished image is left out while it streams', async () => {
    resetMarkdownHtmlCacheForTests();
    expect(await streamed('See ![alt](https://exampl')).toBe('<p>See</p>\n');
    const html = await streamed('x ![a](https://e.test/a.png) z ![b](htt');
    expect(html).toContain('<img src="https://e.test/a.png"');
    expect(html).not.toContain('streamdown:');
    expect(html).not.toContain('alt="b"');
    // Brackets or an opened marker in the alt text must not leave a broken
    // image or a stray closer behind.
    expect(await streamed('x ![a [b] c](https://e')).toBe('<p>x</p>\n');
    expect(await streamed('a ![alt **bold](http')).toBe('<p>a</p>\n');
  });

  test('a finished paragraph streams the way it settles', async () => {
    resetMarkdownHtmlCacheForTests();
    // remend reads a ``` mid-sentence as an open fence. Healing finished
    // blocks showed this paragraph as code until the stream ended.
    const finished = 'Wrap it in ``` fences.';
    const html = await streamed(`${finished}\n\nNext paragraph`);
    expect(html.startsWith(renderMarkdownSync(finished))).toBe(true);
    expect(html).not.toContain('<code>');
  });

  test('a single tilde between words streams the way it settles', async () => {
    resetMarkdownHtmlCacheForTests();
    const text = 'temp 20~25C and 30~40C';
    expect(await streamed(text)).toBe(renderMarkdownSync(text));
  });

  test('healing a long streamed block full of underscores stays fast', async () => {
    resetMarkdownHtmlCacheForTests();
    // One list of snake_case rows: marked parses it in tens of ms, and remend
    // 1.2.1 took about 3 s per stream step on it (openchamber/openchamber#4204).
    const list = Array.from({ length: 5000 }, (_, i) => `- row_${i} has value_a and value_b_${i}`).join('\n');
    expect(list.length).toBeGreaterThan(190_000);
    const started = performance.now();
    const html = await streamed(list);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(html).toContain('row_4999 has value_a and value_b_4999');
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

describe('Dollar math rendering', () => {
  // Follow-up to openchamber/openchamber#2318: single-dollar inline math used
  // to be unsupported, so `$y$` reached the chat as literal text.
  test('renders single-dollar inline math in prose', () => {
    const html = renderMarkdownSync('$y$：$n\\times 1$ 观测向量，$X$：$n \\times (p+1)$ 设计矩阵');
    expect(html).toContain('katex');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('katex-display');
    expect(html).not.toContain('$y$');
    expect(html).not.toContain('$n');
    expect(html).not.toContain('$X');
  });

  test('renders inline math with a comparison operator', () => {
    // `>` is HTML-escaped by marked before this pass runs.
    const html = renderMarkdownSync('当 $n > p$ 且 $\\mathrm{rank}(X) = p+1$ 时可解');
    expect(html).toContain('katex');
    expect(html).not.toContain('katex-error');
  });

  test('renders display math containing apostrophes and ampersands', () => {
    // Regression: marked escapes rendered text (`'` → `&#39;`, `&` → `&amp;`)
    // before this pass runs, so a transpose or alignment ampersand used to
    // reach KaTeX as entities and parse-fail into a red `katex-error`.
    const html = renderMarkdownSync("$$S(\\beta) = |y - X\\beta|^2 = (y-X\\beta)'(y-X\\beta)$$");
    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('&#39;');

    const aligned = renderMarkdownSync("$$\\begin{aligned} X'X\\;\\hat\\beta &= X'y \\end{aligned}$$");
    expect(aligned).toContain('katex-display');
    expect(aligned).not.toContain('katex-error');
  });

  test('leaves currency prose as literal text', () => {
    const cases = [
      'US$ 680',
      'raised $50M to $72M, then $100M',
      '总价 $5 and $10，合计 $50',
      '价格是 $100$ 整',
      'the mysterious $1 on the 11580 — dedicated key. Gathering facts in parallel (wrapper key mechanics, the Go card "$" display logic)',
    ];
    for (const text of cases) {
      const html = renderMarkdownSync(text);
      expect(html).not.toContain('katex');
    }
    // The dollar signs survive verbatim instead of being eaten as delimiters.
    expect(renderMarkdownSync('US$ 680')).toContain('US$ 680');
    expect(renderMarkdownSync('价格是 $100$ 整')).toContain('$100$');
    // A digit-leading span such as $2\pi r$ is math, not currency.
    expect(renderMarkdownSync('$2\\pi r$')).toContain('katex');
  });

  test('keeps dollar pairs out of code and out of link attributes', () => {
    expect(renderMarkdownSync('`$x$`')).not.toContain('katex');
    expect(renderMarkdownSync('```\n$y = x$\n```')).not.toContain('katex');

    // An href may legitimately hold `$`; math never reaches into attributes.
    const html = renderMarkdownSync('see [docs](https://example.com/?q=$a$&lang=en)');
    expect(html).not.toContain('katex');
    expect(html).toContain('q=$a$');
  });

  test('a display pair must live in one text run', () => {
    // `$$` pairs used to match across `</p><p>` with the tags themselves fed
    // to KaTeX as LaTeX — a guaranteed red `katex-error`. Now the orphaned
    // opener stays literal and only the closed pair renders.
    const html = renderMarkdownSync('before\n\n$$a\n\n$$b$$\n\nafter');
    expect(html).toContain('$$a');
    expect(html).toContain('katex');
    expect(html).not.toContain('katex-error');

    const multi = renderMarkdownSync('$$a$$ 段落\n\n$$b$$ 段落');
    expect(multi.match(/katex-display/g)).toHaveLength(2);
  });
});
