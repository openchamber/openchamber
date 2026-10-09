import { describe, expect, test } from 'bun:test';

import {
  beginFilePathMove,
  isFilePathMoveInFlight,
  rebaseMovedPath,
  rebaseMovedPathKeys,
  subscribeToFilePathMoves,
} from './filePathMoves';

describe('rebaseMovedPath', () => {
  test('rebases the moved path itself and everything inside a moved folder', () => {
    expect(rebaseMovedPath('/repo/src/a.ts', '/repo/src/a.ts', '/repo/lib/a.ts')).toBe('/repo/lib/a.ts');
    expect(rebaseMovedPath('/repo/src/deep/b.ts', '/repo/src', '/repo/lib/src')).toBe('/repo/lib/src/deep/b.ts');
  });

  test('leaves a sibling that only shares a string prefix alone', () => {
    expect(rebaseMovedPath('/repo/src/ab.ts', '/repo/src/a', '/repo/lib/a')).toBeNull();
    expect(rebaseMovedPath('/repo/srcx/a.ts', '/repo/src', '/repo/lib/src')).toBeNull();
  });

  test('matches Windows drive paths regardless of letter case', () => {
    expect(rebaseMovedPath('c:/Repo/src/a.ts', 'C:/repo/src', 'C:/repo/lib/src')).toBe('C:/repo/lib/src/a.ts');
  });
});

describe('rebaseMovedPathKeys', () => {
  test('moves keys at or under the source and keeps the rest', () => {
    const modes = { '/repo/src/a.md': 'preview', '/repo/src/deep/b.md': 'edit', '/repo/srcx/c.md': 'edit' };

    expect(rebaseMovedPathKeys(modes, '/repo/src', '/repo/lib/src')).toEqual({
      '/repo/lib/src/a.md': 'preview',
      '/repo/lib/src/deep/b.md': 'edit',
      '/repo/srcx/c.md': 'edit',
    });
  });

  test('returns the same record when nothing moved', () => {
    const modes = { '/repo/a.md': 'preview' };

    expect(rebaseMovedPathKeys(modes, '/repo/b.md', '/repo/lib/b.md')).toBe(modes);
  });
});

describe('beginFilePathMove', () => {
  test('holds paths inside the source until the move commits, then notifies listeners', () => {
    const received: Array<{ from: string; to: string }> = [];
    const unsubscribe = subscribeToFilePathMoves(({ from, to }) => received.push({ from, to }));

    const move = beginFilePathMove('/repo/src');
    expect(isFilePathMoveInFlight('/repo/src/a.ts')).toBe(true);
    expect(isFilePathMoveInFlight('/repo/srcx/a.ts')).toBe(false);

    move.commit('/repo/lib/src');
    move.commit('/repo/elsewhere');
    unsubscribe();

    expect(isFilePathMoveInFlight('/repo/src/a.ts')).toBe(false);
    expect(received).toEqual([{ from: '/repo/src', to: '/repo/lib/src' }]);
  });

  test('releases the hold without notifying when the move fails', () => {
    let calls = 0;
    const unsubscribe = subscribeToFilePathMoves(() => { calls += 1; });

    const move = beginFilePathMove('/repo/src/a.ts');
    move.abort();
    move.commit('/repo/lib/a.ts');
    unsubscribe();

    expect(isFilePathMoveInFlight('/repo/src/a.ts')).toBe(false);
    expect(calls).toBe(0);
  });
});
