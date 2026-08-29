import { describe, expect, test } from 'bun:test';

import { matchesRankQuery, rankByQuery } from './fuzzySearch';

const rank = (items: string[], query: string) => rankByQuery(items, query, (item) => [item]);

describe('rankByQuery', () => {
  test('orders word-boundary matches above mid-word matches, earlier positions first', () => {
    const items = ['prefixed-thing', 'workspace-fix', 'feat/fix-scroll'];
    expect(rank(items, 'fix')).toEqual(['feat/fix-scroll', 'workspace-fix', 'prefixed-thing']);
  });

  test('exact prefix comes first, ties keep original order', () => {
    const items = ['main', 'feat/main-menu', 'maintenance', 'release/main'];
    const ranked = rank(items, 'main');
    expect(ranked[0]).toBe('main');
    expect(ranked[1]).toBe('maintenance');
    expect(ranked.slice(2)).toEqual(['feat/main-menu', 'release/main']);
  });

  test('multi-token queries match in any order and all tokens are required', () => {
    const items = ['feat/scroll-anchored-chat', 'fix/chat-header', 'feat/scroll-perf'];
    expect(rank(items, 'chat scroll')).toEqual(['feat/scroll-anchored-chat']);
  });

  test('punctuation-insensitive compact matching finds joined words', () => {
    const items = ['gpt-4o-mini', 'claude-sonnet-5'];
    expect(rank(items, 'gpt4o')).toEqual(['gpt-4o-mini']);
    expect(rank(items, 'sonnet5')).toEqual(['claude-sonnet-5']);
  });

  test('single-token queries tolerate typos via fuzzy fallback', () => {
    const items = ['workspace-rail-layout', 'unrelated'];
    expect(rank(items, 'worskpace')).toEqual(['workspace-rail-layout']);
  });

  test('fuzzy fallback can be disabled', () => {
    const items = ['workspace-rail-layout'];
    expect(rankByQuery(items, 'worskpace', (item) => [item], { fuzzy: false })).toEqual([]);
  });

  test('earlier fields outrank later fields', () => {
    const items = [
      { name: 'docs', path: '/repo/build-agent' },
      { name: 'build-agent', path: '/repo/build-agent' },
    ];
    const ranked = rankByQuery(items, 'build', (item) => [item.name, item.path]);
    expect(ranked[0].name).toBe('build-agent');
    expect(ranked).toHaveLength(2);
  });

  test('empty query returns items unchanged within the limit', () => {
    expect(rank(['b', 'a'], '  ')).toEqual(['b', 'a']);
    expect(rankByQuery(['a', 'b', 'c'], '', (item) => [item], { limit: 2 })).toEqual(['a', 'b']);
  });
});

describe('matchesRankQuery', () => {
  test('requires every token across the fields', () => {
    expect(matchesRankQuery(['GLM-5.3', 'Zhipu'], 'zhipu glm')).toBe(true);
    expect(matchesRankQuery(['GLM-5.3', 'Zhipu'], 'zhipu gpt')).toBe(false);
  });

  test('is punctuation-insensitive and skips empty fields', () => {
    expect(matchesRankQuery([null, 'claude-sonnet-5', undefined], 'sonnet5')).toBe(true);
    expect(matchesRankQuery([''], 'a')).toBe(false);
  });
});
