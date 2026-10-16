import { afterEach, beforeEach, expect, test } from 'bun:test';
import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { findMatchesInFileDiff } from '@/lib/diff/diffFind';
import { resolveFindDiff, useDiffFind, type DiffFindAnchor, type DiffFindSource, type UseDiffFindResult } from './useDiffFind';

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
  return { filePath, lineNumber: match.lineNumber, spanStart: match.spanStart };
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
  await act(async () => {
    api.open();
    api.setQuery('needle');
  });
  expect(api.matches.map((match) => match.filePath)).toEqual(['a.ts', 'b.ts']);
});

test('results appear progressively and isSearching clears only when all files land', async () => {
  const slow = deferred<FileDiffMetadata | null>();
  const sources = [
    source('a.ts', async () => fileDiffWithNeedle('a.ts')),
    source('b.ts', () => slow.promise),
  ];
  await render(sources);
  await act(async () => {
    api.open();
    api.setQuery('needle');
  });

  expect(api.matches).toHaveLength(1);
  expect(api.isSearching).toBe(true);

  await act(async () => slow.resolve(fileDiffWithNeedle('b.ts')));
  expect(api.matches).toHaveLength(2);
  expect(api.isSearching).toBe(false);
});

test('next and previous wrap the active index', async () => {
  const sources = ['a.ts', 'b.ts', 'c.ts'].map((path) => source(path, async () => fileDiffWithNeedle(path)));
  await render(sources);
  await act(async () => {
    api.open();
    api.setQuery('needle');
  });

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
  await act(async () => {
    api.open();
    api.setQuery('needle');
  });
  // Inline renders the context row once.
  expect(api.matches).toHaveLength(1);

  await render([source('a.ts', load, 'side-by-side')]);
  // Side-by-side renders it once per side.
  expect(api.matches).toHaveLength(2);
});

test('changing the query resets the active index to the first match', async () => {
  const sources = ['a.ts', 'b.ts'].map((path) => source(path, async () => fileDiffWithNeedle(path)));
  await render(sources);
  await act(async () => {
    api.open();
    api.setQuery('needle');
  });
  await act(async () => api.next());
  expect(api.currentIndex).toBe(1);

  await act(async () => api.setQuery('old'));
  expect(api.currentIndex).toBe(0);
});

test('a failing load drops that file without breaking the rest', async () => {
  const sources = [
    source('a.ts', async () => {
      throw new Error('boom');
    }),
    source('b.ts', async () => fileDiffWithNeedle('b.ts')),
  ];
  await render(sources);
  await act(async () => {
    api.open();
    api.setQuery('needle');
  });
  expect(api.matches.map((match) => match.filePath)).toEqual(['b.ts']);
  expect(api.isSearching).toBe(false);
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
  await act(async () => {
    api.open();
    api.setQuery('needle');
  });
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
  await act(async () => {
    api.open();
    api.setQuery('  needle  ');
  });
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
  await act(async () => {
    api.open();
    api.setQuery('needle');
  });

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
  await act(async () => api.openWithQuery('needle', { filePath: 'a.ts', lineNumber: 9999, spanStart: 0 }));
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
