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
});

describe('isHttpUrl', () => {
  test('keeps http(s) only', () => {
    expect(isHttpUrl('https://uploads.linear.app/a.png')).toBe(true);
    expect(isHttpUrl('http://example.com/a.png')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});
