import { describe, expect, test } from 'bun:test';
import { fenceTaggedUiBlocks } from './taggedBlocks';

describe('fenceTaggedUiBlocks', () => {
  test('a tag on its own lines becomes a fence', () => {
    expect(fenceTaggedUiBlocks('Picks:\n<openui-lang>\nroot = Stack([a])\na = Text("x")\n</openui-lang>\nMore.'))
      .toBe('Picks:\n```openui-lang\nroot = Stack([a])\na = Text("x")\n```\nMore.');
  });

  test('a tag that shares lines with the program keeps every line of it', () => {
    expect(fenceTaggedUiBlocks('<openui-lang> root = Stack([a])\na = Text("x") </openui-lang> After'))
      .toBe('```openui-lang\n root = Stack([a])\na = Text("x") \n```\nAfter');
  });

  test('an unclosed tag while streaming is an unclosed fence', () => {
    expect(fenceTaggedUiBlocks('<openui-lang>\nroot = Stack([')).toBe('```openui-lang\nroot = Stack([');
  });

  test('a tag inside code or mid-sentence stays text', () => {
    const text = 'Write `<openui-lang>` like this:\n```md\n<openui-lang>\nroot = Stack([])\n</openui-lang>\n```\nSee <openui-lang> above.';
    expect(fenceTaggedUiBlocks(text)).toBe(text);
  });
});
