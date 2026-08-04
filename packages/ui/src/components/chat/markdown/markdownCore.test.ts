import { describe, expect, test } from 'bun:test';

import { escapeRawMarkdownHtml, MARKDOWN_FORBIDDEN_TAGS } from './markdownSecurity';

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
});
