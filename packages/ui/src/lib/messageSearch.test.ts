import { describe, expect, test } from 'bun:test';

import { isSearchableQuery, MATCH_END, MATCH_START, splitSnippet } from './messageSearch';

describe('message search helpers', () => {
  test('a query needs one word the index can look up', () => {
    expect(isSearchableQuery('ab')).toBe(false);
    expect(isSearchableQuery('ab cd')).toBe(false);
    expect(isSearchableQuery('ab світ')).toBe(true);
    expect(isSearchableQuery('   ')).toBe(false);
  });

  test('splits a snippet into plain runs and matches', () => {
    expect(splitSnippet(`…see ${MATCH_START}portless${MATCH_END} and ${MATCH_START}git${MATCH_END}hub`)).toEqual([
      { text: '…see ', match: false },
      { text: 'portless', match: true },
      { text: ' and ', match: false },
      { text: 'git', match: true },
      { text: 'hub', match: false },
    ]);
  });

  test('keeps markup-looking text as text', () => {
    expect(splitSnippet('<b>not bold</b>')).toEqual([{ text: '<b>not bold</b>', match: false }]);
  });

  test('tolerates an unterminated match', () => {
    expect(splitSnippet(`a ${MATCH_START}b`)).toEqual([{ text: 'a ', match: false }, { text: 'b', match: true }]);
  });
});
