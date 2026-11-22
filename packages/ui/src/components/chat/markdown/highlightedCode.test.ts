import { expect, test } from 'bun:test';

// Plain text takes the foreground color.
const PLAIN = '<span style="color:var(--md-foreground, var(--md-syntax-foreground))">';

import { getHighlightedCode, getHighlightedLines, highlightCode, highlightLines } from './highlightedCode';

test('results are ready synchronously once Highlights has loaded', async () => {
  const lines = await highlightLines('x = 1\n# note', 'python');
  expect(lines).toHaveLength(2);
  expect(lines?.[1]).toBe('<span style="color:var(--md-syntax-comment)"># note</span>');
  expect(getHighlightedLines('const a = 1;', 'typescript')?.[0]).toContain('var(--md-token-storageModifier)');
  expect(getHighlightedCode('const a = 1;', 'typescript')?.startsWith('<pre class="highlights"')).toBe(true);
});

test('unchanged code returns the same result without tokenizing again', async () => {
  const lines = await highlightLines('let cached = 1;', 'typescript');
  expect(getHighlightedLines('let cached = 1;', 'typescript')).toBe(lines!);
  expect(await highlightCode('let cached = 1;', 'typescript')).toBe(getHighlightedCode('let cached = 1;', 'typescript')!);
});

test('an unknown language and ANSI output render as escaped plain text', async () => {
  const esc = String.fromCharCode(27);
  expect(await highlightLines('a <b>', 'no-such-language')).toEqual([`${PLAIN}a &lt;b&gt;</span>`]);
  expect(await highlightLines(`${esc}[32mok${esc}[0m`, 'ansi')).toEqual([`${PLAIN}ok</span>`]);
  expect(await highlightCode(`${esc}[32mok${esc}[0m`, 'ansi')).toContain('<code>ok</code>');
});
