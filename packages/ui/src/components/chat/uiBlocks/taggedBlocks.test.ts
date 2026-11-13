import { describe, expect, test } from 'bun:test';
import { fenceUiBlocks } from './taggedBlocks';

describe('fenceUiBlocks', () => {
  test('a tag on its own lines becomes a fence', () => {
    expect(fenceUiBlocks('Picks:\n<openui-lang>\nroot = Stack([a])\na = Text("x")\n</openui-lang>\nMore.'))
      .toBe('Picks:\n```openui-lang\nroot = Stack([a])\na = Text("x")\n```\nMore.');
  });

  test('a tag that shares lines with the program keeps every line of it', () => {
    expect(fenceUiBlocks('<openui-lang> root = Stack([a])\na = Text("x") </openui-lang> After'))
      .toBe('```openui-lang\n root = Stack([a])\na = Text("x") \n```\nAfter');
  });

  test('an unclosed tag while streaming is an unclosed fence', () => {
    expect(fenceUiBlocks('<openui-lang>\nroot = Stack([')).toBe('```openui-lang\nroot = Stack([');
  });

  test('a tag inside code or mid-sentence stays text', () => {
    const text = 'Write `<openui-lang>` like this:\n```md\n<openui-lang>\nroot = Stack([])\n</openui-lang>\n```\nSee <openui-lang> above.';
    expect(fenceUiBlocks(text)).toBe(text);
  });

  test('a fence opened as openui becomes an openui-lang fence', () => {
    expect(fenceUiBlocks('Path:\n```openui\nroot = Stack([a])\na = Text("x")\n```'))
      .toBe('Path:\n```openui-lang\nroot = Stack([a])\na = Text("x")\n```');
    expect(fenceUiBlocks('```openui\r\nroot = Stack([])\r\n```')).toBe('```openui-lang\nroot = Stack([])\r\n```');
    expect(fenceUiBlocks('~~~~ openui \nroot = Stack([')).toBe('~~~~openui-lang\nroot = Stack([');
  });

  test('an openui fence inside another fence stays as written', () => {
    const text = '````md\n```openui\nroot = Stack([])\n```\n````';
    expect(fenceUiBlocks(text)).toBe(text);
  });

  test('a fence left without a language becomes an openui-lang fence when a program follows', () => {
    expect(fenceUiBlocks('Here:\n```\nroot = Stack([a])\na = Text("x")\n```'))
      .toBe('Here:\n```openui-lang\nroot = Stack([a])\na = Text("x")\n```');
    expect(fenceUiBlocks('```\n  root = Stack([])\n```')).toBe('```openui-lang\n  root = Stack([])\n```');
  });

  test('a fence labelled as plain text becomes an openui-lang fence', () => {
    for (const label of ['text', 'plaintext', 'txt', 'md', 'markdown', 'TEXT', 'Markdown']) {
      expect(fenceUiBlocks(`\`\`\`${label}\nroot = Stack([])\n\`\`\``))
        .toBe('```openui-lang\nroot = Stack([])\n```');
    }
  });

  test('blank lines between the fence and the program still count', () => {
    expect(fenceUiBlocks('```text\n\n\nroot = Stack([])\n```'))
      .toBe('```openui-lang\n\n\nroot = Stack([])\n```');
  });

  test('an unclosed fence while streaming is rewritten the same way', () => {
    expect(fenceUiBlocks('```\nroot = Stack([')).toBe('```openui-lang\nroot = Stack([');
    expect(fenceUiBlocks('```txt\nroot = Stack([a])')).toBe('```openui-lang\nroot = Stack([a])');
  });

  test('a fence labelled with another language, or a fence holding prose, stays as written', () => {
    const code = '```json\nroot = Stack([])\n```';
    expect(fenceUiBlocks(code)).toBe(code);
    const prose = '```\nJust some text\n```';
    expect(fenceUiBlocks(prose)).toBe(prose);
    const indented = '```\n    not = Stack([])\n```';
    expect(fenceUiBlocks(indented)).toBe(indented);
  });

  test('a program inside another fence stays as written', () => {
    const text = '````md\n```\nroot = Stack([])\n```\n````';
    expect(fenceUiBlocks(text)).toBe(text);
  });

  test('a program mentioned in prose does not rewrite a fence', () => {
    const text = 'Write root = Stack([...]) to start.\n\n```\nplain text\n```';
    expect(fenceUiBlocks(text)).toBe(text);
    expect(fenceUiBlocks('Use `root = Stack(` at the top.')).toBe('Use `root = Stack(` at the top.');
  });

  test('an openui-lang fence keeps its language', () => {
    const text = '```openui-lang\nroot = Stack([])\n```';
    expect(fenceUiBlocks(text)).toBe(text);
  });
});
