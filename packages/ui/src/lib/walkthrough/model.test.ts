import { describe, expect, test as it } from 'bun:test';
import { buildWalkthroughView, groupHunksByFile, mergeRunPatch, summarizeHunkFiles } from './model';
import type { WalkthroughHunk, WalkthroughResult } from './types';

const hunk = (id: string, path: string, overrides: Partial<WalkthroughHunk> = {}): WalkthroughHunk => ({
  id,
  path,
  oldPath: null,
  status: 'modified',
  scope: 'working',
  header: '@@ -1,2 +1,3 @@',
  newStart: 1,
  added: 1,
  deleted: 0,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n+line\n`,
  ...overrides,
});

const result = (overrides: Partial<WalkthroughResult> = {}): WalkthroughResult => ({
  source: { kind: 'working-tree', scope: 'all' },
  walkthrough: {
    title: 'Change',
    focus: 'why',
    chapters: [
      {
        id: 'chapter-1',
        title: 'Data',
        icon: 'doc',
        blurb: '',
        stops: [
          { id: 'stop-1-1', title: 'First', hunkIds: ['a', 'b'], importance: 'critical', prose: 'p1' },
          { id: 'stop-1-2', title: 'Second', hunkIds: ['c'], importance: 'normal', prose: 'p2' },
        ],
      },
    ],
  },
  hunks: [hunk('a', 'src/a.ts'), hunk('b', 'src/a.ts'), hunk('c', 'src/b.ts')],
  hunkCount: 3,
  ...overrides,
});

describe('buildWalkthroughView', () => {
  it('resolves stops and numbers them globally', () => {
    const view = buildWalkthroughView(result())!;

    expect(view.stops).toHaveLength(2);
    expect(view.stops.map((stop) => stop.position)).toEqual([1, 2]);
    expect(view.stops[0].hunks.map((h) => h.id)).toEqual(['a', 'b']);
    expect(view.isStale).toBe(false);
    expect(view.uncoveredHunks).toEqual([]);
  });

  it('marks only the stops whose code changed', () => {
    const view = buildWalkthroughView(result({
      hunks: [hunk('a', 'src/a.ts'), hunk('c', 'src/b.ts')],
    }))!;

    expect(view.stops[0].isStale).toBe(true);
    expect(view.stops[0].missingHunkIds).toEqual(['b']);
    expect(view.stops[0].hunks.map((h) => h.id)).toEqual(['a']);
    expect(view.stops[1].isStale).toBe(false);
    expect(view.staleStopCount).toBe(1);
    expect(view.isStale).toBe(true);
  });

  it('surfaces hunks no stop covers instead of dropping them', () => {
    const view = buildWalkthroughView(result({
      hunks: [hunk('a', 'src/a.ts'), hunk('b', 'src/a.ts'), hunk('c', 'src/b.ts'), hunk('d', 'src/c.ts')],
    }))!;

    expect(view.uncoveredHunks.map((h) => h.id)).toEqual(['d']);
  });

  it('returns null without a walkthrough', () => {
    expect(buildWalkthroughView(null)).toBeNull();
    expect(buildWalkthroughView(result({ walkthrough: null }))).toBeNull();
  });
});

describe('groupHunksByFile', () => {
  it('coalesces consecutive hunks from the same file only', () => {
    const runs = groupHunksByFile([
      hunk('a', 'src/a.ts'),
      hunk('b', 'src/a.ts'),
      hunk('c', 'src/b.ts'),
      hunk('d', 'src/a.ts'),
    ]);

    expect(runs.map((run) => [run.path, run.hunks.length])).toEqual([
      ['src/a.ts', 2],
      ['src/b.ts', 1],
      ['src/a.ts', 1],
    ]);
  });
});

describe('mergeRunPatch', () => {
  it('keeps a single patch untouched', () => {
    const single = hunk('a', 'src/a.ts');
    expect(mergeRunPatch([single])).toBe(single.patch);
  });

  it('joins hunks under one file header', () => {
    const first = hunk('a', 'src/a.ts');
    const second = hunk('b', 'src/a.ts', {
      patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,2 +11,3 @@\n+second\n',
    });

    const merged = mergeRunPatch([first, second]);

    expect(merged.match(/^diff --git/gm)).toHaveLength(1);
    expect(merged.match(/^@@/gm)).toHaveLength(2);
    expect(merged).toContain('+line');
    expect(merged).toContain('+second');
  });

  it('returns nothing for an empty run', () => {
    expect(mergeRunPatch([])).toBe('');
  });
});

describe('summarizeHunkFiles', () => {
  it('totals per file in first-appearance order', () => {
    const files = summarizeHunkFiles([
      hunk('a', 'src/b.ts', { added: 2, deleted: 1 }),
      hunk('b', 'src/a.ts', { added: 1, deleted: 0 }),
      hunk('c', 'src/b.ts', { added: 3, deleted: 4 }),
    ]);

    expect(files).toEqual([
      { path: 'src/b.ts', added: 5, deleted: 5 },
      { path: 'src/a.ts', added: 1, deleted: 0 },
    ]);
  });
});
