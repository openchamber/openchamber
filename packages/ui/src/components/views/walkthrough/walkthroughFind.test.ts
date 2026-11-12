import { describe, expect, test as it } from 'bun:test';

import { findMatchesInFileDiff } from '@/lib/diff/diffFind';
import { buildWalkthroughView } from '@/lib/walkthrough/model';
import type { WalkthroughHunk, WalkthroughResult } from '@/lib/walkthrough/types';

import { buildFindSources, enumerateFindRuns, findRunKey, UNCOVERED_STOP_ID } from './walkthroughFind';

const patchFor = (path: string, body: string): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

const hunk = (id: string, path: string, body: string): WalkthroughHunk => ({
  id,
  path,
  oldPath: null,
  status: 'modified',
  scope: 'working',
  header: body.slice(0, body.indexOf('\n')),
  newStart: 1,
  added: 1,
  deleted: 1,
  patch: patchFor(path, body),
});

// A context line carrying the needle plus one changed line, so the inline and
// side-by-side row counts differ by the context row alone.
const needleBody = (start: number): string =>
  `@@ -${start},2 +${start},2 @@\n needle\n-old\n+new\n`;

const result = (): WalkthroughResult => ({
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
          { id: 'stop-1', title: 'First', hunkIds: ['a', 'b'], importance: 'critical', prose: 'p1' },
          { id: 'stop-2', title: 'Second', hunkIds: ['d', 'c'], importance: 'normal', prose: 'p2' },
        ],
      },
    ],
  },
  hunks: [
    hunk('a', 'src/a.ts', needleBody(1)),
    hunk('b', 'src/a.ts', needleBody(10)),
    hunk('d', 'src/a.ts', needleBody(20)),
    hunk('c', 'src/b.ts', needleBody(1)),
  ],
  hunkCount: 4,
});

const view = buildWalkthroughView(result())!;

// Same stops, plus one hunk no stop covers. It shares `src/a.ts` with stop-1
// on purpose, so the tail-versus-stop key collision is exercised.
const resultWithUncovered = (): WalkthroughResult => {
  const base = result();
  return { ...base, hunks: [...base.hunks, hunk('e', 'src/a.ts', needleBody(30))], hunkCount: 5 };
};

const uncoveredView = buildWalkthroughView(resultWithUncovered())!;

describe('enumerateFindRuns', () => {
  it('orders runs by stop, then by run within the stop', () => {
    const runs = enumerateFindRuns(view);

    expect(runs.map((run) => run.key)).toEqual([
      'stop-1::0::a,b',
      'stop-2::0::d',
      'stop-2::1::c',
    ]);
    expect(runs.map((run) => run.stopId)).toEqual(['stop-1', 'stop-2', 'stop-2']);
    expect(runs.map((run) => run.path)).toEqual(['src/a.ts', 'src/a.ts', 'src/b.ts']);
    expect(runs.map((run) => run.hunks.map((h) => h.id))).toEqual([['a', 'b'], ['d'], ['c']]);
  });

  it('gives one file touched by two stops two distinct runs', () => {
    const runs = enumerateFindRuns(view);
    const aRuns = runs.filter((run) => run.path === 'src/a.ts');

    expect(aRuns).toHaveLength(2);
    expect(new Set(aRuns.map((run) => run.key)).size).toBe(2);
  });
});

describe('findRunKey', () => {
  it('changes when the run\u2019s hunks change, so a regenerated stop re-reads', () => {
    const before = findRunKey('stop-1', 0, [hunk('a', 'src/a.ts', needleBody(1))]);
    const after = findRunKey('stop-1', 0, [hunk('a2', 'src/a.ts', needleBody(1))]);

    expect(before).not.toBe(after);
  });
});

describe('buildFindSources', () => {
  it('keys each source by its run and carries the layout through', () => {
    const runs = enumerateFindRuns(view);
    const sources = buildFindSources(runs, 'inline');

    expect(sources.map((source) => source.filePath)).toEqual(runs.map((run) => run.key));
    expect(sources.every((source) => source.layout === 'inline')).toBe(true);
  });

  it('loads the run\u2019s merged patch into a searchable diff', async () => {
    const runs = enumerateFindRuns(view);
    const [first] = buildFindSources(runs, 'inline');
    const fileDiff = await first.load();

    expect(fileDiff).not.toBeNull();
    expect(findMatchesInFileDiff(fileDiff!, first.filePath, 'needle', { layout: 'inline' })).toHaveLength(2);
  });
});

describe('match order across stops and runs', () => {
  it('concatenates in stop \u2192 run \u2192 reading order, so the index advances across stops', async () => {
    const runs = enumerateFindRuns(view);
    const sources = buildFindSources(runs, 'inline');
    const matches = (
      await Promise.all(
        sources.map(async (source) => {
          const fileDiff = await source.load();
          return fileDiff ? findMatchesInFileDiff(fileDiff, source.filePath, 'needle', { layout: source.layout }) : [];
        }),
      )
    ).flat();

    expect(matches.map((match) => match.filePath)).toEqual([
      'stop-1::0::a,b',
      'stop-1::0::a,b',
      'stop-2::0::d',
      'stop-2::1::c',
    ]);
    // Real file line numbers, in order within each run.
    expect(matches.map((match) => match.lineNumber)).toEqual([1, 10, 20, 1]);
    // Index 2 lands in the second stop; index 3 in its second run.
    expect(matches[2].filePath).toBe('stop-2::0::d');
    expect(matches[3].filePath).toBe('stop-2::1::c');
  });

  it('re-runs matching when the layout changes', async () => {
    const runs = enumerateFindRuns(view);
    const count = async (layout: 'inline' | 'side-by-side') => {
      const sources = buildFindSources(runs, layout);
      const perRun = await Promise.all(
        sources.map(async (source) => {
          const fileDiff = await source.load();
          return fileDiff ? findMatchesInFileDiff(fileDiff, source.filePath, 'needle', { layout: source.layout }).length : 0;
        }),
      );
      return perRun;
    };

    // The context row is emitted once inline, twice side-by-side.
    expect(await count('inline')).toEqual([2, 1, 1]);
    expect(await count('side-by-side')).toEqual([4, 2, 2]);
  });
});

describe('enumerateFindRuns with the uncovered tail', () => {
  it('appends the tail after every stop, as its own addressable run', () => {
    const runs = enumerateFindRuns(uncoveredView);

    expect(runs.map((run) => run.key)).toEqual([
      'stop-1::0::a,b',
      'stop-2::0::d',
      'stop-2::1::c',
      '__uncovered__::0::e',
    ]);
    expect(runs.at(-1)!.stopId).toBe(UNCOVERED_STOP_ID);
    expect(runs.at(-1)!.path).toBe('src/a.ts');
  });

  it('keeps a file shared by a stop and the tail on distinct keys', () => {
    const runs = enumerateFindRuns(uncoveredView);
    const aRuns = runs.filter((run) => run.path === 'src/a.ts');

    expect(aRuns.map((run) => run.key)).toEqual(['stop-1::0::a,b', 'stop-2::0::d', '__uncovered__::0::e']);
    expect(new Set(aRuns.map((run) => run.key)).size).toBe(aRuns.length);
  });
});

describe('match order with the uncovered tail', () => {
  it('searches the tail last, after every stop', async () => {
    const sources = buildFindSources(enumerateFindRuns(uncoveredView), 'inline');
    const matches = (
      await Promise.all(
        sources.map(async (source) => {
          const fileDiff = await source.load();
          return fileDiff ? findMatchesInFileDiff(fileDiff, source.filePath, 'needle', { layout: source.layout }) : [];
        }),
      )
    ).flat();

    expect(matches.map((match) => match.filePath)).toEqual([
      'stop-1::0::a,b',
      'stop-1::0::a,b',
      'stop-2::0::d',
      'stop-2::1::c',
      '__uncovered__::0::e',
    ]);
    expect(matches.map((match) => match.lineNumber)).toEqual([1, 10, 20, 1, 30]);
  });
});

describe('anchor identity for a word click', () => {
  it('resolves only with the run key, never with the file path', async () => {
    const [run] = enumerateFindRuns(uncoveredView);
    const [source] = buildFindSources([run], 'inline');
    const fileDiff = await source.load();
    const matches = findMatchesInFileDiff(fileDiff!, source.filePath, 'needle', { layout: 'inline' });
    const target = matches[0];

    // Mirrors the hook's anchor lookup: filePath + lineNumber + spanStart.
    const resolves = (filePath: string) =>
      matches.some(
        (match) =>
          match.filePath === filePath && match.lineNumber === target.lineNumber && match.spanStart === target.spanStart,
      );

    expect(run.key).not.toBe(run.path);
    expect(resolves(run.key)).toBe(true);
    // A bare file path is not a source identity here, so it must miss.
    expect(resolves(run.path)).toBe(false);
  });
});
