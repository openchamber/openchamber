import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

// The real sanitizer on a happy-dom window: these tests count the work each
// stage does and compare the HTML the same pipeline produces either way.
const win = new Window({ url: 'https://openchamber.test/' });
Object.assign(globalThis, {
  window: win,
  document: win.document,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  HTMLAnchorElement: win.HTMLAnchorElement,
  Node: win.Node,
  DocumentFragment: win.DocumentFragment,
});
// Without a Worker the highlighter client resolves every request to null, so
// code keeps marked's plain rendering on both paths.
Reflect.deleteProperty(globalThis, 'Worker');

// Bun cannot load Vite's `?worker&url` import that markdown-worker makes.
mock.module('./markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));

// The sanitizer binds to the window when its module loads.
const {
  __pipelineStatsForTests,
  renderMarkdownBlocks,
  renderMarkdownSync,
  resetLiveSplitMemoForTests,
  resetMarkdownHtmlCacheForTests,
  resetPipelineStatsForTests,
} = await import('./markdownCore');

// A ~300-line reply: prose with an em-dash, lists, tables and TypeScript fences.
const buildReply = (): string => {
  const out: string[] = [];
  for (let section = 0; section < 6; section += 1) {
    out.push(`## Section ${section} — overview`, '');
    out.push(`This paragraph explains step ${section} in some detail — it mentions \`code\`, a [link](https://example.com/${section}) and **bold** text so the inline lexer has real work.`, '');
    out.push('- first item with `inline` code', '- second item — with a dash', '  continued line of the second item', '- third item', '');
    out.push('| name | value | note |', '| --- | ---: | --- |');
    for (let row = 0; row < 4; row += 1) out.push(`| row${row} | ${row * 10} | note ${row} |`);
    out.push('', '```ts');
    for (let line = 0; line < 30; line += 1) {
      out.push(line % 7 === 0 ? `// comment line ${line}` : `export const value${line} = compute(${line}, "str${line}") + other.call(${line});`);
    }
    out.push('```', '', '1. ordered one', '2. ordered two', '');
  }
  out.push('Final words.');
  return out.join('\n');
};

// Arbitrary chunk boundaries, as the 100 ms text throttle delivers them.
const streamPrefixes = (text: string, chunk = 60): string[] => {
  const prefixes: string[] = [];
  for (let end = chunk; end < text.length; end += chunk) prefixes.push(text.slice(0, end));
  prefixes.push(text);
  return prefixes;
};

const reset = (): void => {
  resetMarkdownHtmlCacheForTests();
  resetLiveSplitMemoForTests();
  resetPipelineStatsForTests();
};

describe('streaming render work', () => {
  const reply = buildReply();

  // Before incremental lexing and per-segment hashes, this reply (12.8K
  // characters, 213 steps) lexed 333K characters and hashed 1.36M: every step
  // read the whole message again.
  test('a streamed reply is lexed and hashed in proportion to what changed', async () => {
    reset();
    for (const prefix of streamPrefixes(reply)) await renderMarkdownBlocks(prefix, true, 'label');
    const stats = __pipelineStatsForTests();
    expect(stats.lexedChars).toBeLessThan(reply.length * 8);
    expect(stats.hashedChars).toBeLessThan(reply.length * 8);
  });

  // Before, the finished reply became one block: the whole message was parsed
  // and sanitized again (12.8K characters, one 170K-character sanitize) in the
  // task that ended the stream.
  test('finishing the stream renders only the block that was still live', async () => {
    reset();
    for (const prefix of streamPrefixes(reply)) await renderMarkdownBlocks(prefix, true, 'label');
    const streamed = await renderMarkdownBlocks(reply, true, 'label');
    resetPipelineStatsForTests();

    const settled = await renderMarkdownBlocks(reply, false, 'label');
    const stats = __pipelineStatsForTests();

    expect(stats.lexedChars).toBe(0);
    expect(stats.parsedChars).toBe('Final words.'.length);
    expect(stats.sanitizeCalls).toBe(1);
    expect(settled.map((block) => block.id).slice(0, -1)).toEqual(streamed.map((block) => block.id).slice(0, -1));
  });
});

describe('settled rendering per block', () => {
  const documents = {
    lists: '- one\n- two\n\n  loose continuation\n\n- three\n\n1. a\n1. b\n\n* [ ] task\n* [x] done\n',
    tables: 'Lead\n| a | b |\n|:--|--:|\n| `x` | **y** |\n\nAfter.\n',
    'nested fences': '````md\n```ts\nconst a = 1\n```\n````\n\nText ~~struck~~ and $x^2$ math.\n',
    'reference links': 'See [the docs][docs] and a footnote.[^1]\n\n[docs]: https://example.com "Docs"\n\n[^1]: The note.\n',
    'headings and quotes': '# H1\n\nPara\n===\n\n> quote\n> > nested\n\n---\n\nend',
    reply: buildReply(),
  } satisfies Record<string, string>;

  for (const [name, text] of Object.entries(documents)) {
    test(`${name}: blocks join into the one-shot render`, async () => {
      reset();
      const blocks = await renderMarkdownBlocks(text, false, 'label');
      expect(blocks.map((block) => block.html).join('')).toBe(renderMarkdownSync(text, 'label'));
    });

    test(`${name}: a streamed reply settles to the one-shot render`, async () => {
      reset();
      for (const prefix of streamPrefixes(text, 7)) await renderMarkdownBlocks(prefix, true, 'label');
      const blocks = await renderMarkdownBlocks(text, false, 'label');
      expect(blocks.map((block) => block.html).join('')).toBe(renderMarkdownSync(text, 'label'));
    });
  }
});
