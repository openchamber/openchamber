import { describe, expect, test } from 'bun:test';
import { fusionModeFor, shouldInlineDiffs } from './fusion';

describe('fusionModeFor', () => {
  const changed = { files: 3, insertions: 10, deletions: 2 };
  const clean = { files: 0, insertions: 0, deletions: 0 };

  test('code when every source has a worktree and at least one changed files', () => {
    expect(fusionModeFor([
      { hasWorktree: true, diff: changed },
      { hasWorktree: true, diff: clean },
    ])).toBe('code');
  });

  test('answers when any source shares a directory', () => {
    expect(fusionModeFor([
      { hasWorktree: true, diff: changed },
      { hasWorktree: false, diff: null },
    ])).toBe('answers');
  });

  test('answers when no source changed anything or the changes are unknown', () => {
    expect(fusionModeFor([
      { hasWorktree: true, diff: clean },
      { hasWorktree: true, diff: null },
    ])).toBe('answers');
    expect(fusionModeFor([])).toBe('answers');
  });
});

describe('shouldInlineDiffs', () => {
  test('inlines only while the diffs fit a tenth of the context window', () => {
    // 12 tokens per changed line: 1,000 lines ≈ 12,000 tokens.
    expect(shouldInlineDiffs(1_000, 200_000)).toBe(true);
    expect(shouldInlineDiffs(2_000, 200_000)).toBe(false);
  });

  test('never inlines without a known context window', () => {
    expect(shouldInlineDiffs(1, undefined)).toBe(false);
    expect(shouldInlineDiffs(1, 0)).toBe(false);
  });
});
