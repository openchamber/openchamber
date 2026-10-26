import { describe, expect, test } from 'bun:test';

import { rankBySubsequence } from './subsequenceSearch';

const matchSubsequence = (text: string, query: string) => rankBySubsequence([text], query, (item) => item)[0] ?? null;

/** The marked letters of a match, run by run. */
const marked = (text: string, query: string): string[] | null => {
  const match = matchSubsequence(text, query);
  return match ? match.ranges.map(([start, end]) => text.slice(start, end)) : null;
};

const rank = (items: string[], query: string) => rankBySubsequence(items, query, (item) => item).map((entry) => entry.item);

describe('matchSubsequence', () => {
  test('finds letters in order and marks the ones it placed', () => {
    expect(marked('CommandPalette.tsx', 'cmdpal')).toEqual(['C', 'm', 'dPal']);
    expect(marked('Show context usage', 'ctxus')).toEqual(['c', 't', 'x', 'us']);
  });

  test('places letters on word starts and camel humps when it can', () => {
    expect(marked('FileMentionAutocomplete.tsx', 'fma')).toEqual(['F', 'M', 'A']);
    expect(marked('useUIStore.ts', 'store')).toEqual(['Store']);
  });

  test('a token must start on a word start unless it appears unbroken', () => {
    expect(matchSubsequence('machine-learning/tensorflow/', 'solo')).toBeNull();
    expect(marked('reconfigure', 'config')).toEqual(['config']);
  });

  test('matches each token on its own, in any order', () => {
    expect(marked('Refactor command palette', 'palette command')).toEqual(['command', 'palette']);
    expect(matchSubsequence('Refactor command palette', 'palette missing')).toBeNull();
  });

  test('swapped letters do not match', () => {
    expect(matchSubsequence('workspace rail layout', 'worskpace')).toBeNull();
  });

  test('offsets stay right in non-Latin text', () => {
    expect(marked('Рефакторинг палітри', 'палітр')).toEqual(['палітр']);
  });

  test('scores the query at the start of the text highest', () => {
    expect(matchSubsequence('Toggle Terminal', 'toggle')?.score).toBe(1);
    const start = matchSubsequence('palette', 'pal')?.score ?? 0;
    const later = matchSubsequence('the palette', 'pal')?.score ?? 0;
    const scattered = matchSubsequence('pin all', 'pal')?.score ?? 0;
    expect(start).toBeGreaterThanOrEqual(later);
    expect(later).toBeGreaterThan(scattered);
  });

  test('an empty query matches with nothing marked', () => {
    expect(matchSubsequence('alpha', '  ')).toEqual({ item: 'alpha', score: 1, ranges: [] });
  });
});

describe('rankBySubsequence', () => {
  test('ranks the file a person means first', () => {
    const files = [
      'packages/ui/src/components/chat/FileMentionAutocomplete.tsx',
      'packages/ui/src/components/ui/CommandPalette.tsx',
    ];
    expect(rank(files, 'compal')[0]).toBe(files[1]);
    expect(rank(files, 'fma')).toEqual([files[0]]);
  });

  test('ties go to the shorter text, then to the original order', () => {
    expect(rank(['maintenance', 'feat/main-menu', 'main', 'release/main'], 'main'))
      .toEqual(['main', 'maintenance', 'release/main', 'feat/main-menu']);
  });

  test('keeps the limit and returns ranges with each item', () => {
    const ranked = rankBySubsequence(['alpha one', 'alpha two', 'alpha three'], 'alpha', (item) => item, { limit: 2 });
    expect(ranked).toEqual([
      { item: 'alpha one', score: 1, ranges: [[0, 5]] },
      { item: 'alpha two', score: 1, ranges: [[0, 5]] },
    ]);
  });

  test('without a query returns items in order, unmarked', () => {
    expect(rankBySubsequence(['b', 'a'], '', (item) => item)).toEqual([
      { item: 'b', score: 1, ranges: [] },
      { item: 'a', score: 1, ranges: [] },
    ]);
  });
});

describe('rankBySubsequence over paths', () => {
  const rankPaths = (items: string[], query: string) => rankBySubsequence(items, query, (item) => item, { paths: true });

  test('a match in the file name wins over one spread across folders, and is marked there', () => {
    const [first] = rankPaths(['packages/ui/src/stores/useUIStore.ts'], 'uistore');
    expect(first.ranges.map(([start, end]) => first.item.slice(start, end))).toEqual(['UIStore']);
    expect(rankPaths(['ui/stores/index.ts', 'lib/useUIStore.ts'], 'uistore')[0].item).toBe('lib/useUIStore.ts');
  });

  test('falls back to the whole path when the name does not match', () => {
    const [hit] = rankPaths(['solo-is-a-team-size/index.md'], 'solo-is-a');
    expect(hit.ranges).toEqual([[0, 9]]);
  });

  test('a folder is matched by its own name', () => {
    expect(rankPaths(['solo-is-a-team-size/index.md', 'solo-is-a-team-size/'], 'solo').map((entry) => entry.item))
      .toEqual(['solo-is-a-team-size/', 'solo-is-a-team-size/index.md']);
  });

  test('a query with a slash matches across folders', () => {
    expect(rankPaths(['src/ui/Button.tsx', 'src/Button.tsx'], 'ui/but').map((entry) => entry.item)).toEqual(['src/ui/Button.tsx']);
  });
});
