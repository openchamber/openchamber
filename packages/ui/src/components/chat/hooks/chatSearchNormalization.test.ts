import { describe, expect, test } from 'bun:test';

import { stripMarkdownForSearch } from './chatSearchNormalization';

describe('stripMarkdownForSearch structural syntax', () => {
  test('removes heading syntax but keeps heading text', () => {
    expect(stripMarkdownForSearch('# needle')).toBe('needle');
  });

  test('removes list bullets but keeps list text', () => {
    expect(stripMarkdownForSearch('- needle')).toBe('needle');
  });

  test('removes blockquote markers but keeps quoted text', () => {
    expect(stripMarkdownForSearch('> needle')).toBe('needle');
  });

  test('removes table pipes and separator syntax without changing cell text', () => {
    expect(stripMarkdownForSearch('| Name | Value |\n| --- | --- |\n| needle | yes |')).toBe('Name Value\nneedle yes');
  });

  test('preserves punctuation in prose and identifiers', () => {
    expect(stripMarkdownForSearch('value - needle and foo-bar')).toBe('value - needle and foo-bar');
  });
});
