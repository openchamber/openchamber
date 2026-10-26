import { afterEach, beforeEach, expect, test } from 'bun:test';
import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { findMatchesInFileDiff } from '@/lib/diff/diffFind';
import { DIFF_FIND_QUERY_DEBOUNCE_MS, resolveFindDiff, useDiffFind, type DiffFindAnchor, type DiffFindSource, type UseDiffFindResult } from './useDiffFind';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root;
let host: HTMLDivElement;
let api: UseDiffFindResult;

const Probe = ({ sources, caseSensitive }: { sources: DiffFindSource[]; caseSensitive?: boolean }) => {
  api = useDiffFind({ sources, caseSensitive });
  return null;
};

const render = (sources: DiffFindSource[], caseSensitive?: boolean) =>
  act(async () => root.render(<Probe sources={sources} caseSensitive={caseSensitive} />));

const waitForDebounce = () => new Promise((resolve) => setTimeout(resolve, DIFF_FIND_QUERY_DEBOUNCE_MS + 20));

/** Types a query and waits until matching has caught up with it. */
const typeQuery = async (query: string) => {
  await act(async () => api.setQuery(query));
  await act(async () => waitForDebounce());
};

/** A diff where a context line holds `needle` and one line changes. */
const fileDiffWithNeedle = (name: string): FileDiffMetadata =>
  parseDiffFromFile(
    { name, contents: 'needle\nold\n' },
    { name, contents: 'needle\nnew\n' },
  );

/** Two `needle` matches in one file: a context row and an added row after it. */
const fileDiffWithTwoNeedles = (name: string): FileDiffMetadata =>
  parseDiffFromFile(
    { name, contents: 'needle\nold\n' },
    { name, contents: 'needle\nnew\nneedle\n' },
  );

/** The anchor for a single-needle file's one match. */
const anchorFor = (filePath: string): DiffFindAnchor => {
  const [match] = findMatchesInFileDiff(fileDiffWithNeedle(filePath), filePath, 'needle', { layout: 'inline' });
  return { filePath, side: match.side, lineNumber: match.lineNumber, spanStart: match.spanStart };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const source = (
  filePath: string,
  load: () => Promise<FileDiffMetadata | null>,
  layout: 'inline' | 'side-by-side' = 'inline',
): DiffFindSource => ({ filePath, layout, load });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('a closed bar reads nothing; opening reads every file exactly once', async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;
    return fileDiffWithNeedle('a.ts');
  };
  await render([source('a.ts', load), source('b.ts', load)]);
  expect(calls).toBe(0);

  await act(async () => api.open());
  expect(calls).toBe(2);

  // Reopening does not re-read what is already resolved.
  await act(async () => api.close());
  await act(async () => api.open());
  expect(calls).toBe(2);
});

test('matches merge across files in changeset order', async () => {
  const sources = [
    source('a.ts', async () => fileDiffWithNeedle('a.ts')),
    source('b.ts', async () => fileDiffWithNeedle('b.ts')),
  ];
  await render(sources);
  await act(async () => api.open());
  await typeQuery('needle');
  expect(api.matches.map((match) => match.filePath)).toEqual(['a.ts', 'b.ts']);
});

test('results appear progressively and isSearching clears only when all files land', async () => {
  const slow = deferred<FileDiffMetadata | null>();
  const sources = [
    source('a.ts', async () => fileDiffWithNeedle('a.ts')),
    source('b.ts', () => slow.promise),
  ];
  await render(sources);
  await act(async () => api.open());
  await typeQuery('needle');

  expect(api.matches).toHaveLength(1);
  expect(api.isSearching).toBe(true);

  await act(async () => slow.resolve(fileDiffWithNeedle('b.ts')));
  expect(api.matches).toHaveLength(2);
  expect(api.isSearching).toBe(false);
});

test('next and previous wrap the active index', async () => {
  const sources = ['a.ts', 'b.ts', 'c.ts'].map((path) => source(path, async () => fileDiffWithNeedle(path)));
  await render(sources);
  await act(async () => api.open());
  await typeQuery('needle');

  expect(api.currentIndex).toBe(0);
  await act(async () => api.next());
  expect(api.currentIndex).toBe(1);
  await act(async () => api.next());
  await act(async () => api.next());
  expect(api.currentIndex).toBe(0);
  await act(async () => api.previous());
  expect(api.currentIndex).toBe(2);
});

test('a layout change re-runs matching for that file', async () => {
  const load = async () => fileDiffWithNeedle('a.ts');
  await render([source('a.ts', load, 'inline')]);
  await act(async () => api.open());
  await typeQuery('needle');
  // Inline renders the context row once.
  expect(api.matches).toHaveLength(1);

  await render([source('a.ts', load, 'side-by-side')]);
  // Side-by-side renders it once per side.
  expect(api.matches).toHaveLength(2);
});

test('changing the query resets the active index to the first match', async () => {
  const sources = ['a.ts', 'b.ts'].map((path) => source(path, async () => fileDiffWithNeedle(path)));
  await render(sources);
  await act(async () => api.open());
  await typeQuery('needle');
  await act(async () => api.next());
  expect(api.currentIndex).toBe(1);

  await typeQuery('old');
  expect(api.currentIndex).toBe(0);
});

test('a failing load is counted apart and retried when the bar opens again', async () => {
  let failing = true;
  let calls = 0;
  const sources = [
    source('a.ts', async () => {
      calls += 1;
      if (failing) throw new Error('boom');
      return fileDiffWithNeedle('a.ts');
    }),
    source('b.ts', async () => fileDiffWithNeedle('b.ts')),
  ];
  await render(sources);
  await act(async () => api.open());
  await typeQuery('needle');
  expect(api.matches.map((match) => match.filePath)).toEqual(['b.ts']);
  expect(api.isSearching).toBe(false);
  expect(api.failedCount).toBe(1);
  // Staying open does not retry in a loop.
  expect(calls).toBe(1);

  failing = false;
  await act(async () => api.close());
  expect(api.failedCount).toBe(0);
  await act(async () => api.open());
  expect(calls).toBe(2);
  expect(api.failedCount).toBe(0);
  expect(api.matches.map((match) => match.filePath)).toEqual(['a.ts', 'b.ts']);
});

test('a failed file is read again when its revision moves while the bar is open', async () => {
  let failing = true;
  const load = async () => {
    if (failing) throw new Error('boom');
    return fileDiffWithNeedle('a.ts');
  };
  await render([{ ...source('a.ts', load), revision: '1' }]);
  await act(async () => api.open());
  await typeQuery('needle');
  expect(api.failedCount).toBe(1);

  failing = false;
  await render([{ ...source('a.ts', load), revision: '2' }]);
  expect(api.failedCount).toBe(0);
  expect(api.matches).toHaveLength(1);
});

test('a source that resolves to nested sources is searched through them, in place', async () => {
  let nestedCalls = 0;
  const nested = (path: string): DiffFindSource => source(path, async () => {
    nestedCalls += 1;
    return fileDiffWithNeedle(path);
  });
  const sources: DiffFindSource[] = [
    source('a.ts', async () => fileDiffWithNeedle('a.ts')),
    { filePath: 'repo/', layout: 'inline', load: async () => ({ nestedSources: [nested('repo/x.ts'), nested('repo/y.ts')] }) },
    source('z.ts', async () => fileDiffWithNeedle('z.ts')),
  ];
  await render(sources);
  await act(async () => api.open());
  await typeQuery('needle');
  expect(api.matches.map((match) => match.filePath)).toEqual(['a.ts', 'repo/x.ts', 'repo/y.ts', 'z.ts']);
  expect(api.isSearching).toBe(false);
  expect(nestedCalls).toBe(2);
});

test('typing matches only once the query has settled', async () => {
  await render([source('a.ts', async () => fileDiffWithNeedle('a.ts'))]);
  await act(async () => api.open());
  await act(async () => api.setQuery('needle'));
  expect(api.query).toBe('needle');
  expect(api.matches).toHaveLength(0);

  await act(async () => waitForDebounce());
  expect(api.matches).toHaveLength(1);
});

test('a data revision re-reads the file, a layout change does not', async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;
    return fileDiffWithNeedle('a.ts');
  };
  const withRevision = (layout: 'inline' | 'side-by-side', revision: string): DiffFindSource => ({
    ...source('a.ts', load, layout),
    revision,
  });
  await render([withRevision('inline', 'show')]);
  await act(async () => api.open());
  await typeQuery('needle');
  expect(calls).toBe(1);

  // Layout only affects matching, so the parsed diff is not re-read.
  await render([withRevision('side-by-side', 'show')]);
  expect(calls).toBe(1);
  expect(api.matches).toHaveLength(2);

  // A moved data revision means the parsed diff changed: re-read.
  await render([withRevision('side-by-side', 'hide')]);
  expect(calls).toBe(2);
});

test('the query is trimmed before matching', async () => {
  await render([source('a.ts', async () => fileDiffWithNeedle('a.ts'))]);
  await act(async () => api.open());
  await typeQuery('  needle  ');
  expect(api.matches).toHaveLength(1);
});

test('reads files one at a time, never more than one host read in flight', async () => {
  const first = deferred<FileDiffMetadata | null>();
  const second = deferred<FileDiffMetadata | null>();
  const third = deferred<FileDiffMetadata | null>();
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const tracked = (pending: ReturnType<typeof deferred<FileDiffMetadata | null>>) => async () => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await pending.promise;
    } finally {
      inFlight -= 1;
    }
  };
  const sources = [
    source('a.ts', tracked(first)),
    source('b.ts', tracked(second)),
    source('c.ts', tracked(third)),
  ];
  await render(sources);
  await act(async () => api.open());
  await typeQuery('needle');

  // Only the first file was started; the rest wait their turn.
  expect(maxInFlight).toBe(1);
  expect(calls).toBe(1);
  expect(api.matches).toHaveLength(0);
  expect(api.isSearching).toBe(true);

  await act(async () => first.resolve(fileDiffWithNeedle('a.ts')));
  expect(maxInFlight).toBe(1);
  expect(calls).toBe(2);
  expect(api.matches.map((match) => match.filePath)).toEqual(['a.ts']);
  expect(api.isSearching).toBe(true);

  await act(async () => {
    second.resolve(fileDiffWithNeedle('b.ts'));
    third.resolve(fileDiffWithNeedle('c.ts'));
  });
  expect(maxInFlight).toBe(1);
  expect(api.matches.map((match) => match.filePath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  expect(api.isSearching).toBe(false);

  // Reopening does not re-read anything already resolved.
  await act(async () => api.close());
  await act(async () => api.open());
  expect(calls).toBe(3);
});

test('openWithQuery without an anchor opens on the first match', async () => {
  const sources = ['a.ts', 'b.ts'].map((path) => source(path, async () => fileDiffWithNeedle(path)));
  await render(sources);
  await act(async () => api.openWithQuery('needle'));
  expect(api.isOpen).toBe(true);
  expect(api.query).toBe('needle');
  expect(api.currentIndex).toBe(0);
  expect(api.currentMatch?.filePath).toBe('a.ts');
});

test('openWithQuery lands on the match after the anchor', async () => {
  const sources = ['a.ts', 'b.ts', 'c.ts'].map((path) => source(path, async () => fileDiffWithNeedle(path)));
  await render(sources);
  // Load everything first so the anchor's position is not a partial-list guess.
  await act(async () => api.open());
  await act(async () => api.openWithQuery('needle', anchorFor('a.ts')));
  expect(api.currentMatch?.filePath).toBe('b.ts');
  expect(api.currentIndex).toBe(1);
});

test('openWithQuery wraps when the anchor is the last match', async () => {
  const sources = ['a.ts', 'b.ts', 'c.ts'].map((path) => source(path, async () => fileDiffWithNeedle(path)));
  await render(sources);
  await act(async () => api.open());
  await act(async () => api.openWithQuery('needle', anchorFor('c.ts')));
  expect(api.currentMatch?.filePath).toBe('a.ts');
  expect(api.currentIndex).toBe(0);
});

test('openWithQuery holds an anchor jump until its file resolves', async () => {
  const slow = deferred<FileDiffMetadata | null>();
  const sources = [
    source('a.ts', async () => fileDiffWithNeedle('a.ts')),
    source('b.ts', () => slow.promise),
  ];
  await render(sources);
  const [firstNeedle] = findMatchesInFileDiff(fileDiffWithTwoNeedles('b.ts'), 'b.ts', 'needle', { layout: 'inline' });
  await act(async () => api.openWithQuery('needle', {
    filePath: 'b.ts',
    side: firstNeedle.side,
    lineNumber: firstNeedle.lineNumber,
    spanStart: firstNeedle.spanStart,
  }));

  // b.ts has not resolved, so its anchor match is not in the list yet.
  expect(api.isSearching).toBe(true);
  expect(api.currentMatch?.filePath).toBe('a.ts');

  await act(async () => slow.resolve(fileDiffWithTwoNeedles('b.ts')));
  // The anchor is now the middle match; the jump lands on the one after it.
  expect(api.currentIndex).toBe(2);
  expect(api.currentMatch?.filePath).toBe('b.ts');
});

test('openWithQuery falls back to the first match when the anchor never appears', async () => {
  const sources = ['a.ts', 'b.ts'].map((path) => source(path, async () => fileDiffWithNeedle(path)));
  await render(sources);
  await act(async () => api.open());
  await act(async () => api.openWithQuery('needle', { filePath: 'a.ts', side: 'additions', lineNumber: 9999, spanStart: 0 }));
  expect(api.isSearching).toBe(false);
  expect(api.currentIndex).toBe(0);
  expect(api.currentMatch?.filePath).toBe('a.ts');
});

test('closing drops a pending anchor jump', async () => {
  const slow = deferred<FileDiffMetadata | null>();
  const sources = [
    source('a.ts', async () => fileDiffWithNeedle('a.ts')),
    source('b.ts', () => slow.promise),
  ];
  await render(sources);
  const [firstNeedle] = findMatchesInFileDiff(fileDiffWithTwoNeedles('b.ts'), 'b.ts', 'needle', { layout: 'inline' });
  await act(async () => api.openWithQuery('needle', {
    filePath: 'b.ts',
    side: firstNeedle.side,
    lineNumber: firstNeedle.lineNumber,
    spanStart: firstNeedle.spanStart,
  }));
  await act(async () => api.close());
  await act(async () => slow.resolve(fileDiffWithTwoNeedles('b.ts')));
  await act(async () => api.open());
  // The held jump is gone: reopening starts on the first match.
  expect(api.currentIndex).toBe(0);
  expect(api.currentMatch?.filePath).toBe('a.ts');
});

test('a user query edit drops a pending anchor jump', async () => {
  const slow = deferred<FileDiffMetadata | null>();
  const sources = [
    source('a.ts', async () => fileDiffWithNeedle('a.ts')),
    source('b.ts', () => slow.promise),
  ];
  await render(sources);
  const [firstNeedle] = findMatchesInFileDiff(fileDiffWithTwoNeedles('b.ts'), 'b.ts', 'needle', { layout: 'inline' });
  await act(async () => api.openWithQuery('needle', {
    filePath: 'b.ts',
    side: firstNeedle.side,
    lineNumber: firstNeedle.lineNumber,
    spanStart: firstNeedle.spanStart,
  }));
  // Rewriting the query — even to the same text — supersedes the held jump.
  await act(async () => api.setQuery('needle'));
  await act(async () => slow.resolve(fileDiffWithTwoNeedles('b.ts')));
  expect(api.currentIndex).toBe(0);
  expect(api.currentMatch?.filePath).toBe('a.ts');
});

test('hiding whitespace searches the rendered diff, not the raw one', () => {
  // The only change re-indents a line that carries the needle: the viewer
  // hides the whole hunk, so the line is not rendered and must not match.
  const diff = parseDiffFromFile(
    { name: 'a.ts', contents: 'a\nb\nNEEDLE\n' },
    { name: 'a.ts', contents: 'a\nb\n  NEEDLE\n' },
  );
  expect(findMatchesInFileDiff(diff, 'a.ts', 'NEEDLE', { layout: 'inline' })).toHaveLength(2);

  const filtered = resolveFindDiff(diff, true);
  if (!filtered) throw new Error('expected a filtered diff');
  expect(filtered.hunks).toHaveLength(0);
  expect(findMatchesInFileDiff(filtered, 'a.ts', 'NEEDLE', { layout: 'inline' })).toHaveLength(0);

  // Without hiding, the raw diff is searched unchanged.
  expect(resolveFindDiff(diff, false)).toBe(diff);
});

test('openWithQuery tells a deletion row from an addition row with the same number', async () => {
  // Line 2 changes: `needle old` -> `needle new`, so both rows hold the needle
  // at line 2, offset 0.
  const diff = parseDiffFromFile(
    { name: 'a.ts', contents: 'a\nneedle old\n' },
    { name: 'a.ts', contents: 'a\nneedle new\n' },
  );
  await render([source('a.ts', async () => diff)]);
  await act(async () => api.open());
  await act(async () => api.openWithQuery('needle', { filePath: 'a.ts', side: 'additions', lineNumber: 2, spanStart: 0 }));
  // Clicked the addition: the next match wraps to the deletion, not to itself.
  expect(api.currentMatch?.side).toBe('deletions');
});

test('the active match stays put when an earlier file gains matches', async () => {
  let earlier: FileDiffMetadata | null = null;
  const sources = (revision: string): DiffFindSource[] => [
    { ...source('a.ts', async () => earlier), revision },
    source('b.ts', async () => fileDiffWithTwoNeedles('b.ts')),
  ];
  await render(sources('1'));
  await act(async () => api.open());
  await typeQuery('needle');
  await act(async () => api.next());
  expect(api.currentIndex).toBe(1);
  const active = api.currentMatch;

  // a.ts is re-read and now holds a match ahead of b.ts's.
  earlier = fileDiffWithNeedle('a.ts');
  await render(sources('2'));
  expect(api.matches).toHaveLength(3);
  expect(api.currentMatch).toEqual(active);
  expect(api.currentIndex).toBe(2);
});

test('a closed bar takes new sources on every render without re-rendering itself', async () => {
  // Sources rebuilt on each render, as a range cache does before its effect
  // runs. With the bar closed nothing is searched, so the render-phase index
  // sync must not see new matches and loop.
  let renders = 0;
  const Unstable = () => {
    renders += 1;
    api = useDiffFind({ sources: [{ filePath: 'a.ts', layout: 'inline', revision: 'r', load: async () => null }] });
    return null;
  };
  await act(async () => root.render(<Unstable />));
  await act(async () => root.render(<Unstable />));
  expect(api.isOpen).toBe(false);
  expect(renders).toBeLessThan(6);
});
