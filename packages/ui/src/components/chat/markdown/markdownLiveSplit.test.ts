import { describe, expect, mock, test } from 'bun:test';

mock.module('./markdown-worker', () => ({
  highlightCodeInWorker: mock(async () => null),
  highlightLinesInWorker: mock(async () => null),
  highlightTokensInWorker: mock(async () => null),
  resetMarkdownWorkerClientCacheForTests: mock(() => undefined),
}));

const { __liveSplitStatsForTests, __streamBlocksForTests, resetLiveSplitMemoForTests } = await import('./markdownCore');

// Every prefix split from nothing: what the full lexer path answers.
const splitFresh = (text: string) => {
  resetLiveSplitMemoForTests();
  return __streamBlocksForTests(text, true);
};

const expectSameAsFreshAtEveryStep = (head: string, growth: string): { reused: number; lexed: number } => {
  const prefixes = Array.from({ length: growth.length + 1 }, (_, length) => head + growth.slice(0, length));
  const fresh = prefixes.map(splitFresh);

  resetLiveSplitMemoForTests();
  prefixes.forEach((prefix, index) => {
    expect(__streamBlocksForTests(prefix, true)).toEqual(fresh[index]!);
  });
  return __liveSplitStatsForTests();
};

describe('live split while a fence stays open', () => {
  const head = 'Intro paragraph with **bold**.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\n';

  test('matches a fresh split at every character and stops lexing the message', () => {
    const growth = 'const a = `open\nstill ${inside}`\n\n# not a heading\nfunction f() {}\n';
    const stats = expectSameAsFreshAtEveryStep(head, growth);
    expect(stats.lexed).toBe(1);
    expect(stats.reused).toBe(growth.length);
  });

  test('a closing fence, arriving character by character, goes back to the lexer', () => {
    const growth = 'let x = 1\n```\n\nProse after the block with a [link](https://example.com).\n';
    const stats = expectSameAsFreshAtEveryStep(head, growth);
    expect(stats.lexed).toBeGreaterThan(1);
    expect(stats.reused).toBeGreaterThan(0);
  });

  test('a shorter marker or the other marker character does not close the fence', () => {
    const tildeHead = 'Text.\n\n~~~~md\n';
    const stats = expectSameAsFreshAtEveryStep(tildeHead, '```\ninner\n```\n~~~\nstill inside\n');
    expect(stats.lexed).toBe(1);
  });

  test('a reference definition inside the code takes the full path, as the lexer path does', () => {
    expectSameAsFreshAtEveryStep(head, 'ok\n[ref]: https://example.com\nmore\n');
  });

  test('a message that opens with a fence holding a reference definition matches the lexer path', () => {
    expectSameAsFreshAtEveryStep('```ts\n[ref]: https://example.com\n', `${'x\n'.repeat(305)}y`);
  });

  test('text that is not an extension of a remembered split is lexed', () => {
    resetLiveSplitMemoForTests();
    __streamBlocksForTests(`${head}let a = 1\n`, true);
    const other = 'Different message.\n\n```py\nprint(1)\n';
    expect(__streamBlocksForTests(other, true)).toEqual(splitFresh(other));
  });

  test('two parts streaming side by side each keep their own split', () => {
    resetLiveSplitMemoForTests();
    const first = `${head}let a = 1\n`;
    const second = 'Second part.\n\n```py\nx = 1\n';
    __streamBlocksForTests(first, true);
    __streamBlocksForTests(second, true);
    const before = __liveSplitStatsForTests().reused;
    __streamBlocksForTests(`${first}let b = 2\n`, true);
    __streamBlocksForTests(`${second}y = 2\n`, true);
    expect(__liveSplitStatsForTests().reused).toBe(before + 2);
  });

  test('a fence over the highlight line limit turns highlighting off on both paths', () => {
    const manyLines = 'x\n'.repeat(320);
    resetLiveSplitMemoForTests();
    __streamBlocksForTests(head, true);
    const extended = __streamBlocksForTests(head + manyLines, true);
    expect(extended).toEqual(splitFresh(head + manyLines));
    expect(extended.at(-1)?.highlight).toBe(false);
  });
});
