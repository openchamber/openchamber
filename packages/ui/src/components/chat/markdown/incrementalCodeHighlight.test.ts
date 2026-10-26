import { describe, expect, test } from 'bun:test';
import { createHighlighter, hastToHtml } from 'shiki';

import { createIncrementalCodeHighlighter, type ChunkRenderer } from './incrementalCodeHighlight';

const THEME = 'github-dark';

// Constructs whose tokens depend on the lines before them: a template literal
// and a block comment that stay open across lines, a Python docstring, and a
// markdown document carrying a fence of its own.
const SAMPLES: Array<{ lang: string; code: string }> = [
  {
    lang: 'typescript',
    code: [
      'const greeting = `hello',
      '  ${user.name},',
      '  welcome back`',
      '/* a comment that',
      '   runs over lines */',
      'export function add(a: number, b: number): number {',
      '  return a + b // trailing',
      '}',
      '',
      'type Pair<T> = [T, T]',
    ].join('\n'),
  },
  {
    lang: 'python',
    code: ['def call(vm, argc):', '    """Docstring that', '    spans lines."""', '    frame = Frame(vm)', "    return f'{frame!r}'"].join('\n'),
  },
  {
    lang: 'markdown',
    code: ['# Title', '', '```js', 'let x = `a', 'b`', '```', '', '- item **bold**'].join('\n'),
  },
  { lang: 'text', code: ['plain line one', 'plain <line> & two', ''].join('\n') },
];

let instance: Awaited<ReturnType<typeof createHighlighter>>;
let renderedChars = 0;

const render: ChunkRenderer = (chunk, lang, grammarState) => {
  renderedChars += chunk.length;
  const hast = instance.codeToHast(chunk, { lang, theme: THEME, tabindex: false, grammarState });
  return { html: hastToHtml(hast), grammarState: instance.getLastGrammarState(hast) };
};

const fullPass = (code: string, lang: string): string => instance.codeToHtml(code, { lang, theme: THEME, tabindex: false });

const highlighterReady = createHighlighter({ themes: [THEME], langs: ['typescript', 'python', 'markdown', 'javascript'] });

const ready = async (): Promise<void> => {
  instance = await highlighterReady;
};

describe('incremental code highlighting', () => {
  test('equals one full pass at every line of a growing block', async () => {
    await ready();
    for (const { lang, code } of SAMPLES) {
      const highlighter = createIncrementalCodeHighlighter({ render });
      const lines = code.split('\n');
      for (let count = 1; count <= lines.length; count += 1) {
        // The shape marked hands over: complete lines and a final break.
        const soFar = `${lines.slice(0, count).join('\n')}\n`;
        expect(highlighter.highlight(soFar, lang)).toBe(fullPass(soFar, lang));
      }
    }
  });

  test('equals one full pass at every character, including an unfinished last line', async () => {
    await ready();
    const { lang, code } = SAMPLES[0]!;
    const highlighter = createIncrementalCodeHighlighter({ render });
    for (let length = 0; length <= code.length; length += 1) {
      const soFar = code.slice(0, length);
      expect(highlighter.highlight(soFar, lang)).toBe(fullPass(soFar, lang));
    }
  });

  test('tokenizes each line once instead of the whole block on every step', async () => {
    await ready();
    const line = 'const value = compute(input, { retries: 3 }) // step\n';
    const lineCount = 200;
    const highlighter = createIncrementalCodeHighlighter({ render });
    renderedChars = 0;
    for (let count = 1; count <= lineCount; count += 1) {
      highlighter.highlight(line.repeat(count), 'typescript');
    }
    const blockChars = line.length * lineCount;
    // A full pass per step would render about lineCount / 2 times the block.
    expect(renderedChars).toBeLessThan(blockChars * 1.5);
  });

  test('two blocks that share a beginning and then diverge both stay correct', async () => {
    await ready();
    const highlighter = createIncrementalCodeHighlighter({ render });
    const shared = 'const a = `open\n';
    const left = `${shared}still string\`\nconst b = 1\n`;
    const right = `${shared}\${value}\`\nfunction c() {}\n`;
    expect(highlighter.highlight(shared, 'typescript')).toBe(fullPass(shared, 'typescript'));
    expect(highlighter.highlight(left, 'typescript')).toBe(fullPass(left, 'typescript'));
    expect(highlighter.highlight(right, 'typescript')).toBe(fullPass(right, 'typescript'));
    expect(highlighter.highlight(left, 'typescript')).toBe(fullPass(left, 'typescript'));
  });

  test('a shorter or edited block is highlighted from scratch, never from a stale state', async () => {
    await ready();
    const highlighter = createIncrementalCodeHighlighter({ render });
    const original = 'let a = 1\n/* open\nstill comment\n';
    const edited = 'let a = 1\nlet b = 2\nstill comment\n';
    highlighter.highlight(original, 'typescript');
    expect(highlighter.highlight(edited, 'typescript')).toBe(fullPass(edited, 'typescript'));
    expect(highlighter.highlight('let a = 1\n', 'typescript')).toBe(fullPass('let a = 1\n', 'typescript'));
  });

  test('the same text in another language does not reuse the state', async () => {
    await ready();
    const highlighter = createIncrementalCodeHighlighter({ render });
    const code = 'x = "value"\n# note\n';
    highlighter.highlight(code, 'python');
    expect(highlighter.highlight(code, 'typescript')).toBe(fullPass(code, 'typescript'));
  });

  test('declines what it cannot resume, so the caller falls back to a full pass', async () => {
    await ready();
    const highlighter = createIncrementalCodeHighlighter({ render, maxLineageChars: 40 });
    expect(highlighter.highlight('[31mred[0m\n', 'ansi')).toBeNull();
    expect(highlighter.highlight('x'.repeat(41), 'typescript')).toBeNull();

    const stateless = createIncrementalCodeHighlighter({
      render: (chunk, lang, grammarState) => ({ ...render(chunk, lang, grammarState), grammarState: undefined }),
    });
    expect(stateless.highlight('const a = 1\n', 'typescript')).toBeNull();
    expect(stateless.highlight('plain\n', 'text')).toBe(fullPass('plain\n', 'text'));
  });

  test('keeps a bounded number of blocks in memory', async () => {
    await ready();
    const highlighter = createIncrementalCodeHighlighter({ render, maxLineages: 2 });
    const blocks = ['let one = 1\n', 'let two = 2\n', 'let three = 3\n'];
    for (const block of blocks) highlighter.highlight(block, 'typescript');
    renderedChars = 0;
    // The oldest block was dropped: extending it starts over and stays correct.
    const extended = `${blocks[0]}let more = 4\n`;
    expect(highlighter.highlight(extended, 'typescript')).toBe(fullPass(extended, 'typescript'));
    expect(renderedChars).toBeGreaterThanOrEqual(extended.length - 1);
  });
});
