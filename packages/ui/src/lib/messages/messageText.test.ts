import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';

import { flattenAssistantTextParts, flattenUserTextParts, suggestPlanTitleFromText } from './messageText';

// SAFETY: the fixture supplies every required SDK TextPart field, and its `type: 'text'` discriminant selects that Part variant.
const basePart = (overrides: Record<string, unknown>): Part => ({
  id: 'p1',
  sessionID: 's',
  messageID: 'm',
  type: 'text',
  text: '',
  ...overrides,
} as Part);

const textPart = (id: string, text: string): Part => basePart({ id, text });

const textParts = (...texts: string[]): Part[] => texts.map((text, index) => textPart(`part-${index}`, text));

// SAFETY: shellAction is the existing display-only bridge property attached to text parts by MessageList.
const shellPart = (id: string, shellAction: { output?: string; command?: string }): Part =>
  basePart({ id, shellAction });

describe('flattenAssistantTextParts', () => {
  test('preserves fenced-code blank lines while normalizing Markdown boundaries', () => {
    expect(flattenAssistantTextParts(textParts(
      'First paragraph',
      '- item 1\n- item 2',
      '```ts\nconst first = 1;\n\n  \n\nconst second = 2;\n```\n\n\n\nFollowing paragraph',
    ))).toBe([
      'First paragraph',
      '- item 1\n- item 2',
      '```ts\nconst first = 1;\n\n  \n\nconst second = 2;\n```',
      'Following paragraph',
    ].join('\n\n'));
  });

  test('recognizes tilde fences as code boundaries', () => {
    expect(flattenAssistantTextParts(textParts(
      'Before\n\n\n~~~text\nfirst\n\n\nsecond\n~~~\n\n\nAfter',
    ))).toBe('Before\n\n~~~text\nfirst\n\n\nsecond\n~~~\n\nAfter');
  });

  test('normalizes CRLF line endings in paragraphs and fenced code', () => {
    expect(flattenAssistantTextParts(textParts(
      'First paragraph\r\n\r\nSecond paragraph\r\n\r\n```ts\r\nconst first = 1;\r\n\r\nconst second = 2;\r\n```\r\n\r\nFollowing paragraph',
    ))).toBe([
      'First paragraph',
      '',
      'Second paragraph',
      '',
      '```ts',
      'const first = 1;',
      '',
      'const second = 2;',
      '```',
      '',
      'Following paragraph',
    ].join('\n'));
  });

  test('keeps one blank line at each text-part boundary', () => {
    expect(flattenAssistantTextParts(textParts('First paragraph', 'Second paragraph')))
      .toBe('First paragraph\n\nSecond paragraph');
  });

  test('does not add a blank line when a fenced block splits without a newline', () => {
    expect(flattenAssistantTextParts(textParts(
      '```ts',
      'const value = 1;\n```',
    ))).toBe('```ts\nconst value = 1;\n```');
  });

  test('does not add a blank line when an indented code block splits without a newline', () => {
    expect(flattenAssistantTextParts(textParts(
      '    const first = 1;',
      '    const second = 2;',
    ))).toBe('    const first = 1;\n    const second = 2;');
  });

  test('collapses excessive blank-line runs to one blank line', () => {
    expect(flattenAssistantTextParts(textParts('First\n\n\n\nSecond\n \n\n\nThird')))
      .toBe('First\n\nSecond\n\nThird');
  });

  test('normalizes blank lines in list continuations', () => {
    expect(flattenAssistantTextParts(textParts(
      '- item\n    continuation\n\n\n\n    next continuation',
    ))).toBe('- item\n    continuation\n\n    next continuation');
  });

  test('preserves blank lines in indented code blocks', () => {
    expect(flattenAssistantTextParts(textParts(
      'Before\n\n\n\n    const first = 1;\n\n\n\n    const second = 2;\n\n\n\nAfter',
    ))).toBe(
      'Before\n\n    const first = 1;\n\n\n\n    const second = 2;\n\nAfter',
    );
  });

  test('preserves blank lines in mixed-space/tab indented code blocks', () => {
    expect(flattenAssistantTextParts(textParts(
      '   \tconst first = 1;\n\n\n\n   \tconst second = 2',
    ))).toBe('   \tconst first = 1;\n\n\n\n   \tconst second = 2');
  });

  test('treats a tab-indented fence-like block as indented code', () => {
    expect(flattenAssistantTextParts(textParts(
      '\t```\n\n\n\tconst value = 1;\n\n\n\nAfter',
    ))).toBe('\t```\n\n\n\tconst value = 1;\n\nAfter');
  });

  test('preserves indentation on leading indented code', () => {
    expect(flattenAssistantTextParts(textParts(
      '\n\n    const first = 1;\n\n    const second = 2\n\n',
    ))).toBe('    const first = 1;\n\n    const second = 2');
  });

  test('preserves indentation when a fenced block spans text parts', () => {
    expect(flattenAssistantTextParts(textParts(
      '```ts\n',
      '\n    const value = 1;\n```',
    ))).toBe('```ts\n\n    const value = 1;\n```');
  });

  test('preserves multiple fenced-code blank lines split across text parts', () => {
    expect(flattenAssistantTextParts(textParts(
      '```ts\nconst first = 1;\n',
      '\n\n',
      '\nconst second = 2;\n```',
    ))).toBe([
      '```ts',
      'const first = 1;',
      '',
      '',
      '',
      'const second = 2;',
      '```',
    ].join('\n'));
  });
});

describe('flattenUserTextParts', () => {
  test('keeps plain text block separators', () => {
    expect(flattenUserTextParts(textParts('First paragraph\n\n\nSecond paragraph', 'Next paragraph')))
      .toBe('First paragraph\n\n\nSecond paragraph\n\nNext paragraph');
  });

  test('prefers shell output and joins separate outputs with blank lines', () => {
    const parts = [
      textPart('plain', 'ignored when shell output exists'),
      shellPart('shell-command', { command: 'ls -la' }),
      shellPart('shell-output-1', { output: '  file-a\nfile-b  ' }),
      shellPart('shell-output-2', { output: 'done' }),
    ];

    expect(flattenUserTextParts(parts)).toBe('file-a\nfile-b\n\ndone');
  });

  test('falls back to shell commands when no output is available', () => {
    const parts = [
      shellPart('command-1', { command: ' bun install ' }),
      shellPart('command-2', { command: 'bun test' }),
      textPart('plain', 'ignored when commands exist'),
    ];

    expect(flattenUserTextParts(parts)).toBe('bun install\nbun test');
  });

  test('returns empty text when no visible text parts exist', () => {
    expect(flattenUserTextParts([])).toBe('');
    expect(flattenUserTextParts(textParts('  '))).toBe('');
  });
});

describe('suggestPlanTitleFromText', () => {
  test('keeps deriving a title from the first non-empty line', () => {
    expect(suggestPlanTitleFromText('\n\n## Preserve Markdown spacing\n\nMore detail'))
      .toBe('Preserve Markdown spacing');
  });
});
