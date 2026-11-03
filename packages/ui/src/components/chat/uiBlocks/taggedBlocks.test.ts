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
});
