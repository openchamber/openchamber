import { beforeAll, describe, expect, test } from 'bun:test';
import { fenceUiBlocks, loadProgramCheck } from './taggedBlocks';

describe('fenceUiBlocks', () => {
  beforeAll(async () => { await loadProgramCheck(); });

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

  test('a program spaced any way the parser accepts still counts', () => {
    expect(fenceUiBlocks('```\nroot=Stack([a])\na = Text("x")\n```'))
      .toBe('```openui-lang\nroot=Stack([a])\na = Text("x")\n```');
    expect(fenceUiBlocks('```\nroot = Stack ([a])\na = Text("x")\n```'))
      .toBe('```openui-lang\nroot = Stack ([a])\na = Text("x")\n```');
  });

  test('blank lines between the fence and the program still count', () => {
    expect(fenceUiBlocks('```\n\n\nroot = Stack([])\n```'))
      .toBe('```openui-lang\n\n\nroot = Stack([])\n```');
  });

  test('an unclosed fence while streaming is rewritten the same way', () => {
    expect(fenceUiBlocks('```\nroot = Stack([')).toBe('```openui-lang\nroot = Stack([');
    expect(fenceUiBlocks('~~~\nroot = Stack([a])')).toBe('~~~openui-lang\nroot = Stack([a])');
  });

  test('a fence labelled as plain text is source the agent chose to show', () => {
    for (const label of ['text', 'plaintext', 'txt', 'md', 'markdown', 'TEXT']) {
      const text = `\`\`\`${label}\nroot = Stack([])\n\`\`\``;
      expect(fenceUiBlocks(text)).toBe(text);
    }
  });

  test('a fenced example inside a list item or quote stays as written', () => {
    const listed = '- Example:\n- ````md\n  ```\n  root = Stack([])\n  ```\n  ````\n\nDone.';
    expect(fenceUiBlocks(listed)).toBe(listed);
    const quoted = '> ````md\n> ```\n> root = Stack([])\n> ```\n> ````';
    expect(fenceUiBlocks(quoted)).toBe(quoted);
  });

  test('an inline code span on its own line does not hide a fence after it', () => {
    expect(fenceUiBlocks('```example```\n\n```\nroot = Stack([])\n```'))
      .toBe('```example```\n\n```openui-lang\nroot = Stack([])\n```');
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

  test('a fence continuing a list item stays as written', () => {
    const text = '- Example:\n\n  ```\n  root = Stack([])\n  ```\n\nDone.';
    expect(fenceUiBlocks(text)).toBe(text);
  });

  test('a fence left open in a quote ends with the quote', () => {
    expect(fenceUiBlocks('> ```sh\n> echo hi\n\n```\nroot = Stack([])\n```'))
      .toBe('> ```sh\n> echo hi\n\n```openui-lang\nroot = Stack([])\n```');
    expect(fenceUiBlocks('> ```sh\n> echo hi\n\n```openui\nroot = Stack([])\n```'))
      .toBe('> ```sh\n> echo hi\n\n```openui-lang\nroot = Stack([])\n```');
  });

  test('a closed fence without a language counts only when the parser accepts its program', () => {
    const code = '```\nroot = Stack(items)\nprint(root)\n```';
    expect(fenceUiBlocks(code)).toBe(code);
    expect(fenceUiBlocks('```\n// Picks\nroot = Stack([a])\na = Text("x")\n```'))
      .toBe('```openui-lang\n// Picks\nroot = Stack([a])\na = Text("x")\n```');
  });

  test('an openui-lang fence keeps its language', () => {
    const text = '```openui-lang\nroot = Stack([])\n```';
    expect(fenceUiBlocks(text)).toBe(text);
  });
});
