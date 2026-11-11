import { describe, expect, test } from 'bun:test';

import { isSearchableQuery, MATCH_END, MATCH_START, searchConversations, searchMessages, splitSnippet } from './messageSearch';

describe('message search helpers', () => {
  test('a query needs one word the index can look up', () => {
    expect(isSearchableQuery('ab')).toBe(false);
    expect(isSearchableQuery('ab cd')).toBe(false);
    expect(isSearchableQuery('ab світ')).toBe(true);
    expect(isSearchableQuery('   ')).toBe(false);
  });

  test('splits a snippet into plain runs and matches', () => {
    expect(splitSnippet(`…see ${MATCH_START}portless${MATCH_END} and ${MATCH_START}git${MATCH_END}hub`)).toEqual([
      { text: '…see ', matched: false },
      { text: 'portless', matched: true },
      { text: ' and ', matched: false },
      { text: 'git', matched: true },
      { text: 'hub', matched: false },
    ]);
  });

  test('keeps markup-looking text as text', () => {
    expect(splitSnippet('<b>not bold</b>')).toEqual([{ text: '<b>not bold</b>', matched: false }]);
  });

  test('tolerates an unterminated match', () => {
    expect(splitSnippet(`a ${MATCH_START}b`)).toEqual([{ text: 'a ', matched: false }, { text: 'b', matched: true }]);
  });

  test('serializes grouped exclusions without sending them to message search', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      urls.push(String(input));
      return Response.json({ status: 'query-too-short' });
    };
    globalThis.fetch = fetchStub;
    try {
      await searchMessages({ query: 'alpha', limit: 20 });
      await searchConversations({ query: 'alpha', lifecycle: 'all', exclude: ['ses_a', 'ses_b'], includeReasoning: false, limit: 20 });
      expect(new URL(urls[0], 'http://localhost').searchParams.getAll('exclude')).toEqual([]);
      const params = new URL(urls[1], 'http://localhost').searchParams;
      expect(params.getAll('exclude')).toEqual(['ses_a', 'ses_b']);
      expect(params.get('reasoning')).toBe('0');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
