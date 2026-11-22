import { expect, test } from 'bun:test';
import { MarkdownCodeHighlighter } from './markdownCodeHighlighter';

// Plain text takes the foreground color.
const FOREGROUND = 'var(--md-foreground, var(--md-syntax-foreground))';

const text = (result: { tokens: Array<Array<{ content: string }>> } | null | undefined) =>
  result?.tokens.map((line) => line.map((token) => token.content).join('')).join('\n');

test('tokens match the source and take colors from the markdown variables', async () => {
  const owner = new MarkdownCodeHighlighter();
  const code = '// Немає запису — 中文\nconst value: string = "Власник";';
  const result = await owner.highlight(code, 'typescript', false);
  expect(text(result)).toBe(code);
  expect(result?.tokens.flat().some((token) => token.color?.includes('--md-'))).toBe(true);
  expect(result?.tokens[1][0]).toEqual({ color: 'var(--md-token-storageModifier)', bgColor: undefined, htmlStyle: {}, offset: code.indexOf('const'), content: 'const ' });
});

test('a result is ready on the first synchronous lookup once Highlights has loaded', async () => {
  const owner = new MarkdownCodeHighlighter();
  await owner.highlight('warm', 'typescript', false);
  const code = 'const first = "paint";';
  const result = owner.cached(code, 'typescript');
  expect(text(result)).toBe(code);
  expect(owner.cached(code, 'typescript')).toBe(result!);
});

test('a language without a lexer takes its relative, an unknown one stays readable', async () => {
  const owner = new MarkdownCodeHighlighter();
  const relative = await owner.highlight('-- note\nvalue = 1', 'purescript', false);
  expect(text(relative)).toBe('-- note\nvalue = 1');
  expect(relative?.tokens[0][0].color).toBe('var(--md-syntax-comment)');
  const unknown = await owner.highlight('plain "text"', 'no-such-language', false);
  expect(unknown?.tokens).toEqual([[{ color: FOREGROUND, bgColor: undefined, htmlStyle: {}, offset: 0, content: 'plain "text"' }]]);
});

test('ANSI output loses its escapes and its colors', async () => {
  const owner = new MarkdownCodeHighlighter();
  const esc = String.fromCharCode(27);
  const result = await owner.highlight(`${esc}[31ma${esc}[31mb${esc}[0m plain\nnext ${esc}[32mgreen${esc}[0m`, 'ansi', false);
  expect(text(result)).toBe('ab plain\nnext green');
  expect(result?.tokens.flat().every((token) => token.color === FOREGROUND)).toBe(true);
});

test('completed results retain identity while only the last streaming results stay', async () => {
  const owner = new MarkdownCodeHighlighter();
  const code = 'const cached = "重用";';
  const result = await owner.highlight(code, 'typescript', false);
  expect(owner.cached(code, 'typescript')).toBe(result!);
  expect(await owner.highlight(code, 'typescript', false)).toBe(result!);
  const prefix = 'let transient =';
  const transient = await owner.highlight(prefix, 'typescript', true);
  expect(await owner.highlight(prefix, 'typescript', false)).toBe(transient!);
  for (let index = 0; index < 70; index++) await owner.highlight(`completed ${index}`, 'typescript', false);
  const streaming = await owner.highlight('streaming 0', 'typescript', true);
  for (let index = 1; index < 6; index++) await owner.highlight(`streaming ${index}`, 'typescript', true);
  expect(owner.cached(code, 'typescript')).toBe(result!);
  expect(owner.cached(prefix, 'typescript')).toBe(transient!);
  expect(owner.cached('streaming 0', 'typescript', true)).not.toBe(streaming!);
});

test('a streaming block keeps unchanged rows by identity', async () => {
  const owner = new MarkdownCodeHighlighter();
  await owner.highlight('warm', 'typescript', false);
  const first = owner.cached('const a = 1;\nconst b', 'typescript', true);
  const next = owner.cached('const a = 1;\nconst b = 2;\nconst c', 'typescript', true);
  expect(next?.tokens[0]).toBe(first?.tokens[0]);
  expect(next?.tokens[1]).not.toBe(first?.tokens[1]);
  const comment = owner.cached('/* const a = 1;\nconst b = 2;', 'typescript', true);
  expect(comment?.tokens[0]).not.toBe(next?.tokens[0]);
});
