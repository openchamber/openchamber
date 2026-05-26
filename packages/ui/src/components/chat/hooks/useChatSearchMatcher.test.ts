import { describe, test, expect } from 'bun:test';
import { stripMarkdownForSearch } from './useChatSearchMatcher';

describe('stripMarkdownForSearch', () => {
  test('removes fenced code blocks', () => {
    const result = stripMarkdownForSearch('before ```code block``` after');
    expect(result).toContain('before');
    expect(result).toContain('after');
    expect(result).not.toContain('code block');
  });

  test('removes inline code backticks but keeps content', () => {
    expect(stripMarkdownForSearch('use `Header.tsx` here')).toBe('use Header.tsx here');
  });

  test('enables search spanning inline-code boundary', () => {
    const text = stripMarkdownForSearch('the store but `Header.tsx` never reads show');
    expect(text).toBe('the store but Header.tsx never reads show');
  });

  test('strips bold **markers**', () => {
    expect(stripMarkdownForSearch('hello **world** friend')).toBe('hello world friend');
  });

  test('strips bold __markers__', () => {
    expect(stripMarkdownForSearch('hello __world__ friend')).toBe('hello world friend');
  });

  test('strips italic *markers*', () => {
    expect(stripMarkdownForSearch('hello *world* friend')).toBe('hello world friend');
  });

  test('strips italic _markers_', () => {
    expect(stripMarkdownForSearch('hello _world_ friend')).toBe('hello world friend');
  });

  test('strips strikethrough ~~markers~~', () => {
    expect(stripMarkdownForSearch('~~deleted~~ text')).toBe('deleted text');
  });

  test('collapses link syntax to label', () => {
    expect(stripMarkdownForSearch('[click here](https://example.com)')).toBe('click here');
  });

  test('collapses image syntax to alt text', () => {
    expect(stripMarkdownForSearch('![alt text](image.png)')).toBe('alt text');
  });

  test('enables search spanning bold boundary: "hello world" finds "hello **world**"', () => {
    const normalized = stripMarkdownForSearch('hello **world** ok');
    expect(normalized).toBe('hello world ok');
    const re = /hello world/gi;
    expect(re.test(normalized)).toBe(true);
  });
});