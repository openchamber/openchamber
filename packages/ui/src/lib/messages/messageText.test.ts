import { describe, expect, test } from 'bun:test';

import type { Part } from '@opencode-ai/sdk/v2';
import { flattenAssistantTextParts, flattenUserTextParts } from './messageText';

// Regression tests for https://github.com/openchamber/openchamber/issues/2867
//
// `flattenAssistantTextParts` used to collapse every blank line into a single
// `\n`. Markdown block structure (paragraphs, lists, fenced code blocks)
// requires a blank line (`\n\n`); a single `\n` is a CommonMark soft break.
// `ChatMessage.tsx`'s `handleCopyMessage` feeds the flattened string into
// `copyMarkdownToClipboard`, which writes it to `text/plain`, `text/markdown`
// and its markdown-rendered HTML into `text/html`.

const basePart = (overrides: Record<string, unknown>): Part =>
  ({
    id: 'p1',
    sessionID: 's',
    messageID: 'm',
    type: 'text',
    text: '',
    ...overrides,
  }) as Part;

const makeParts = (texts: string[]): Part[] =>
  texts.map((text, index) => basePart({ id: `p${index}`, text }));

const makeUserParts = (
  entries: Array<{ text?: string; shellAction?: { output?: unknown; command?: unknown } }>,
): Part[] =>
  entries.map((entry, index) =>
    basePart({ id: `u${index}`, text: entry.text ?? '', shellAction: entry.shellAction }),
  );

describe('flattenAssistantTextParts', () => {
  const parts = makeParts([
    '第一段',
    '第二段',
    '```js\nconsole.log(1)\n```',
    '第三段',
    '- item 1\n- item 2',
  ]);

  test('blank lines between paragraphs/code blocks/lists are preserved', () => {
    expect(flattenAssistantTextParts(parts)).toBe(
      '第一段\n\n第二段\n\n```js\nconsole.log(1)\n```\n\n第三段\n\n- item 1\n- item 2',
    );
  });

  test('a code fence is not glued to the following paragraph', () => {
    const flattened = flattenAssistantTextParts(parts);
    expect(flattened).not.toContain('```\n第三段');
    expect(flattened).toContain('```\n\n第三段');
  });

  test('list items keep single newlines inside their part', () => {
    expect(flattenAssistantTextParts(parts)).toContain('\n\n- item 1\n- item 2');
  });

  test('internal blank-line runs are preserved', () => {
    const text = 'a\n\n\n\nb\n \n \nd';
    expect(flattenAssistantTextParts(makeParts([text]))).toBe(text);
  });

  test('multiple blank lines inside a fenced code block are preserved', () => {
    const fenced = '```js\na\n\n\nb\n```';
    expect(flattenAssistantTextParts(makeParts([fenced]))).toBe(fenced);
  });

  test('part boundaries produce block separators', () => {
    expect(flattenAssistantTextParts(makeParts(['first', 'second']))).toBe('first\n\nsecond');
  });

  test('empty and whitespace-only parts are dropped', () => {
    expect(flattenAssistantTextParts([])).toBe('');
    expect(flattenAssistantTextParts(makeParts(['', '   ', '\n']))).toBe('');
  });

  test('single part without blank lines is returned unchanged', () => {
    const single = 'only line\nsecond line';
    expect(flattenAssistantTextParts(makeParts([single]))).toBe(single);
  });

  test('non-text parts are ignored', () => {
    const partsWithTool: Part[] = [
      ...makeParts(['before']),
      { id: 't1', sessionID: 's', messageID: 'm', type: 'tool', tool: 'bash' } as Part,
      ...makeParts(['after']),
    ];
    expect(flattenAssistantTextParts(partsWithTool)).toBe('before\n\nafter');
  });
});

describe('flattenUserTextParts', () => {
  test('plain text parts keep blank-line block separators', () => {
    const parts = makeUserParts([{ text: '第一段\n\n\n第二段' }, { text: '下一段' }]);
    expect(flattenUserTextParts(parts)).toBe('第一段\n\n\n第二段\n\n下一段');
  });

  test('shell outputs win over other content and are joined with blank lines', () => {
    const parts = makeUserParts([
      { text: 'note', shellAction: { command: 'ls -la' } },
      { text: '', shellAction: { output: '  file-a\nfile-b  ' } },
      { text: '', shellAction: { output: 'done' } },
    ]);
    expect(flattenUserTextParts(parts)).toBe('file-a\nfile-b\n\ndone');
  });

  test('shell commands fall back to a single-newline command list', () => {
    const parts = makeUserParts([
      { shellAction: { command: ' bun install ' } },
      { shellAction: { command: 'bun test' } },
      { text: 'ignored when commands exist' },
    ]);
    expect(flattenUserTextParts(parts)).toBe('bun install\nbun test');
  });

  test('returns empty string for parts without text', () => {
    expect(flattenUserTextParts([])).toBe('');
    expect(flattenUserTextParts(makeUserParts([{ text: '  ' }]))).toBe('');
  });
});
