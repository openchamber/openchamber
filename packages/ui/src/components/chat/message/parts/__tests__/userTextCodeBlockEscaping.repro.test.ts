/**
 * Reproduction test for Issue #1744
 * https://github.com/openchamber/openchamber/issues/1744
 *
 * Bug: Code blocks in outgoing (user) messages display HTML entities
 * (&lt;, &gt;, &amp;) instead of the actual characters (<, >, &).
 *
 * Root cause: In UserTextPart.tsx line 151, escapeHtml() is applied to the
 * ENTIRE user message content (including code fence content) BEFORE markdown
 * parsing. This causes double-escaping:
 *
 *   1. User types: <i32> inside ```rust
 *   2. escapeHtml() converts < to &lt; and & to &amp;
 *      (UserTextPart.tsx:30-37)
 *   3. marked.parse() sees already-escaped content and re-escapes it:
 *      &lt; -> &amp;lt; and &amp; -> &amp;amp;
 *   4. unescapeHtml() in highlightCodeBlocks (markdownCore.ts:235-241)
 *      only undoes ONE level of escaping
 *   5. Result: HTML entities displayed literally
 *
 * The fix: Skip HTML escaping inside code fence content, or use the markdown
 * parser's built-in escaping (marked + DOMPurify already handle XSS).
 *
 * run: bun test --cwd packages/ui
 */

import { describe, expect, test } from 'bun:test';

/**
 * Direct reproduction of the escapeHtml function from UserTextPart.tsx:30-37
 */
const escapeHtml = (text: string): string => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

const rustCode = `impl Solution {
    pub fn max_ice_cream(costs: Vec<i32>, mut coins: i32) -> i32 {
        let max_price = *costs.iter().max().unwrap_or(&1);
    }
}`;

const userMessage = '```rust\n' + rustCode + '\n```';

describe('Issue #1744 - Code blocks in outgoing messages show HTML entities', () => {
  test('escapeHtml corrupts code fence content', () => {
    const afterEscape = escapeHtml(userMessage);

    // The escape corrupts content inside the code block
    expect(afterEscape).toContain('&lt;i32&gt;');
    expect(afterEscape).toContain('&amp;1');
    expect(afterEscape).not.toContain('<i32>');

    // Expected: content inside ```rust code fence should be preserved as-is
    // Actual: HTML entities have been introduced
    console.log('Raw user message contains:', '<i32>');
    console.log('After escapeHtml: contains', '&lt;i32&gt;');
    console.log('BUG: Content inside code fence was HTML-escaped');
  });

  test('unescapeHtml does not fully recover double-escaped content', async () => {
    const { marked } = await import('marked');

    const afterEscape = escapeHtml(userMessage);
    const parsed = await marked.parse(afterEscape, { gfm: true, breaks: false });

    // Extract code block content from the parsed HTML
    const match = parsed.match(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/);
    expect(match).not.toBeNull();
    const codeContent = match![1]!;

    // marked re-escapes the already-escaped content
    expect(codeContent).toContain('&amp;lt;');
    expect(codeContent).not.toContain('<i32>');

    // Simulate unescapeHtml from markdownCore.ts:235-241
    const unescapeHtml = (value: string): string =>
      value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');

    const afterUnescape = unescapeHtml(codeContent);

    // After unescapeHtml, one level is stripped but entities remain
    expect(afterUnescape).toContain('&lt;');
    expect(afterUnescape).not.toContain('<i32>');

    // The correct output should contain <i32> — but it still has &lt;i32&gt;
    console.log('Code block content after markdown + unescapeHtml:');
    console.log(afterUnescape);
    console.log('BUG: Still contains &lt; instead of <');
  });

  test('demonstrates the full corruption chain for &1', async () => {
    const { marked } = await import('marked');
    const unescapeHtml = (value: string): string =>
      value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');

    // Step 1: Raw content has `&1`
    expect(userMessage).toContain('&1');

    // Step 2: escapeHtml converts & to &amp;
    const afterEscape = escapeHtml(userMessage);
    expect(afterEscape).toContain('&amp;1'); // &1 -> &amp;1 (WRONG inside code block)

    // Step 3: marked double-escapes &amp;1 -> &amp;amp;1
    const parsed = await marked.parse(afterEscape, { gfm: true, breaks: false });
    const match = parsed.match(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/);
    const codeContent = match![1]!;
    expect(codeContent).toContain('&amp;amp;1');

    // Step 4: unescapeHtml only strips one level -> &amp;1 remains
    const afterUnescape = unescapeHtml(codeContent);
    expect(afterUnescape).toContain('&amp;1');

    // Expected: The code block should display `&1`
    // Actual: It displays `&amp;1`
    console.log('Chain: &1 -> &amp;1 -> &amp;amp;1 -> &amp;1 (still wrong)');
    console.log('Expected final: &1');
    const matchResult = afterUnescape.match(/&amp;1/);
    console.log('Actual final:   ' + (matchResult ? matchResult[0] : 'not found'));
  });
});
