import { describe, expect, test } from 'bun:test';

import { isHttpUrl, splitTextMedia } from './text.ts';

describe('splitTextMedia', () => {
  test('keeps plain text', () => {
    expect(splitTextMedia('Ship the picker.')).toEqual([
      { kind: 'text', text: 'Ship the picker.' },
    ]);
  });

  test('lifts markdown images and links in order', () => {
    expect(splitTextMedia('See ![login](https://uploads.linear.app/a.png) and [docs](https://linear.app/docs).')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'image', src: 'https://uploads.linear.app/a.png', alt: 'login' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', href: 'https://linear.app/docs', label: 'docs' },
      { kind: 'text', text: '.' },
    ]);
  });

  test('lifts a loopback session link', () => {
    const body = '[OpenChamber session completed: OPE-296](http://127.0.0.1:3901/?session=ses_1)';
    expect(splitTextMedia(body)).toEqual([
      { kind: 'link', href: 'http://127.0.0.1:3901/?session=ses_1', label: 'OpenChamber session completed: OPE-296' },
    ]);
  });

  test('uses the href as label when the label is empty', () => {
    expect(splitTextMedia('[](https://example.com)')).toEqual([
      { kind: 'link', href: 'https://example.com', label: 'https://example.com' },
    ]);
  });

  test('leaves a javascript URL as text', () => {
    expect(splitTextMedia('![x](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '![x](javascript:alert(1))' },
    ]);
    expect(splitTextMedia('[x](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[x](javascript:alert(1))' },
    ]);
  });

  // The label holds no '[': a label interrupted by one ends that attempt, and a
  // token that starts inside the brackets keeps its own label. Both are pinned
  // here so a change to how tokens are found cannot quietly change the render.
  test('ends a label at an interrupted bracket instead of swallowing it', () => {
    expect(splitTextMedia('[tail [b](https://one.example) [c]')).toEqual([
      { kind: 'text', text: '[tail ' },
      { kind: 'link', href: 'https://one.example', label: 'b' },
      { kind: 'text', text: ' [c]' },
    ]);
    expect(splitTextMedia('[label [nested]](https://nested.example) after')).toEqual([
      { kind: 'text', text: '[label [nested]](https://nested.example) after' },
    ]);
    expect(splitTextMedia('[[[[ nested deep [x](https://deep.example)')).toEqual([
      { kind: 'text', text: '[[[[ nested deep ' },
      { kind: 'link', href: 'https://deep.example', label: 'x' },
    ]);
  });

  test('keeps text that is not a link', () => {
    expect(splitTextMedia('[no closing bracket')).toEqual([
      { kind: 'text', text: '[no closing bracket' },
    ]);
    expect(splitTextMedia('[a](not a url)')).toEqual([
      { kind: 'text', text: '[a](not a url)' },
    ]);
    expect(splitTextMedia('[][]')).toEqual([{ kind: 'text', text: '[][]' }]);
    // A space ends the href, so the label before it is not a URL and the whole
    // piece stays text.
    expect(splitTextMedia('[x](https://spaced.example/a b)')).toEqual([
      { kind: 'text', text: '[x](https://spaced.example/a b)' },
    ]);
  });

  // The parser must stay linear in the text it is handed: a panel supplies this
  // text, and one unmatched bracket per character used to cost about a second
  // of CPU at this size.
  test('parses a bracket-heavy text in bounded time', () => {
    const text = '['.repeat(30_000);
    const started = performance.now();
    const parts = splitTextMedia(text);
    const elapsed = performance.now() - started;
    expect(parts).toEqual([{ kind: 'text', text }]);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('isHttpUrl', () => {
  test('keeps http(s) only', () => {
    expect(isHttpUrl('https://uploads.linear.app/a.png')).toBe(true);
    expect(isHttpUrl('http://example.com/a.png')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});
