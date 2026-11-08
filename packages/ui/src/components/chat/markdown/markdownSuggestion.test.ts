import { describe, expect, test } from 'bun:test';

import { isSuggestionLanguage, suggestionPatch } from './markdownSuggestion';

describe('review suggestions', () => {
  test('replace the excerpt lines in one hunk at their own line numbers', () => {
    expect(suggestionPatch('  const c = 5;', { startLine: 12, lines: ['  const c = 4;', '  return a;'] }))
      .toBe('@@ -12,2 +12,1 @@\n-  const c = 4;\n-  return a;\n+  const c = 5;');
  });

  test('an empty suggestion deletes the lines; without an excerpt it only adds', () => {
    expect(suggestionPatch('', { startLine: 4, lines: ['gone'] })).toBe('@@ -4,1 +3,0 @@\n-gone');
    expect(suggestionPatch('a\nb', null)).toBe('@@ -0,0 +1,2 @@\n+a\n+b');
  });

  test('reads GitHub and GitLab fences only', () => {
    expect(isSuggestionLanguage('suggestion')).toBe(true);
    expect(isSuggestionLanguage('suggestion:-0+2')).toBe(true);
    expect(isSuggestionLanguage('suggestions')).toBe(false);
    expect(isSuggestionLanguage('diff')).toBe(false);
  });
});
