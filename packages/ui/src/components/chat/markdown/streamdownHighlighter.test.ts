import { expect, test } from 'bun:test';
import { codeToTokens } from '@pierre/highlights';
import { bundledLanguages, createHighlighter } from 'shiki';
import { createStreamdownHighlighter } from './streamdownHighlighter';
import { MARKDOWN_SHIKI_THEME_DEFINITION } from './markdownShikiThemeDefinition';
import { packCodeTokens, unpackCodeTokens } from './streamdown-code-protocol';
import { sanitizeTemplateCallGrammar } from '@/lib/shiki/sanitizeTemplateCallGrammar';
import { MARKDOWN_HIGHLIGHTS_THEME } from '@/lib/shiki/zedThemeFromAppTheme';

// CoffeeScript has no Highlights lexer, so it exercises the Oniguruma path and
// its carried grammar state.
test('incremental grammar state matches full tokenization at each character and after edits', async () => {
  const grammar = await bundledLanguages.coffee();
  const full = await createHighlighter({ themes: [MARKDOWN_SHIKI_THEME_DEFINITION], langs: grammar.default.map(sanitizeTemplateCallGrammar) });
  const highlight = createStreamdownHighlighter();
  const code = '### 中文\n still comment ###\nvalue = """hello\n#{1 + 2} 😀"""\n';
  const sources = Array.from({ length: code.length + 1 }, (_, length) => code.slice(0, length));
  sources.push('### edited ###\nx = 2', 'x = "a"\r\ny = "б"');
  for (const source of sources) {
    const result = await highlight(source, 'coffee');
    const expected = full.codeToTokensBase(source, { lang: 'coffee', theme: MARKDOWN_SHIKI_THEME_DEFINITION });
    expect(result).toEqual(expected);
    const packed = packCodeTokens(result);
    const moved = structuredClone(packed, { transfer: [packed.spans.buffer, packed.lines.buffer] });
    expect(packed.spans.byteLength).toBe(0);
    expect(unpackCodeTokens(source, moved).tokens.map((line) => line.map((token) => token.content).join(''))).toEqual(expected.map((line) => line.map((token) => token.content).join('')));
  }
  full.dispose();
});

test('whitespace compaction reduces spans without crossing font, background or decoration boundaries', () => {
  const source = '  x y z';
  const tokens = [[
    { content: '  ', offset: 0, color: '#111' },
    { content: 'x', offset: 2, color: '#222' },
    { content: ' ', offset: 3, fontStyle: 1 },
    { content: 'y', offset: 4, fontStyle: 0 },
    { content: ' ', offset: 5, bgColor: '#333' },
    { content: 'z', offset: 6 },
  ]];
  const result = unpackCodeTokens(source, packCodeTokens(tokens));
  expect(result.tokens[0]).toHaveLength(5);
  expect(result.tokens[0][0]).toMatchObject({ content: '  x', offset: 0, color: '#222' });
  expect(result.tokens[0].map((token) => token.content).join('')).toBe(source);
});

test('transfer preserves UTF-16 source ranges and all font-style bits', () => {
  const source = '😀 bold 中文';
  const packed = packCodeTokens([[{ content: source, offset: 0, color: 'var(--md-syntax-string)', bgColor: '#123456', fontStyle: 1 | 2 | 4 }]]);
  const moved = structuredClone(packed, { transfer: [packed.lines.buffer, packed.spans.buffer] });
  expect(unpackCodeTokens(source, moved).tokens).toEqual([[{
    content: source, offset: 0, color: 'var(--md-syntax-string)', bgColor: '#123456',
    htmlStyle: { fontStyle: 'italic', fontWeight: 'bold', textDecoration: 'underline' },
  }]]);
});

test('Highlights languages and aliases tokenize every streamed prefix as one whole pass', async () => {
  const highlight = createStreamdownHighlighter();
  for (const [lang, lines] of [
    ['python', ['def f():', '    """中文', '    still a string"""', '    return 1']],
    ['ts', ['/* comment', 'done */', 'const text = "😀";']],
    ['text', ['plain', '中文', 'tail']],
  ] as const) {
    for (let count = 1; count <= lines.length; count++) {
      const source = lines.slice(0, count).join('\n') + '\n';
      const expected = codeToTokens(source, { lang, theme: MARKDOWN_HIGHLIGHTS_THEME }).tokens;
      expect(await highlight(source, lang)).toEqual(expected);
      expect(await highlight(source, lang, true)).toEqual(expected);
      expect(expected.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(source);
    }
  }
});

test('Highlights colors chat code through the markdown syntax variables', async () => {
  const highlight = createStreamdownHighlighter();
  const tokens = (await highlight('// note\nconst value = "text";', 'typescript')).flat();
  const colorOf = (content: string) => tokens.find((token) => token.content.trim() === content)?.color;
  expect(colorOf('// note')).toBe('var(--md-syntax-comment)');
  expect(colorOf('"text"')).toBe('var(--md-syntax-string)');
  expect(colorOf('const')).toBe('var(--md-token-storageModifier)');
});
