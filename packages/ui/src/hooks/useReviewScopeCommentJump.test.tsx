import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { createComparisonDiffFromPatch } from '@/components/views/diffView/diffData';
import type { ComparisonDiffResult, FileEntry } from '@/components/views/diffView/types';
import type { CommentLocationRequest } from '@/lib/commentLocation';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';

import { useAnswerCommentJump } from './useReviewScopeCommentJump';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Element: browser.Element,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const DIRECTORY = '/repo';
const ORIGIN: DiffCommentOrigin = { kind: 'commit', hash: 'abc123' };
const FILE: FileEntry = { path: 'src/app.ts', index: '', working_dir: 'M', insertions: 1, deletions: 1, isNew: false };
// One hunk showing new lines 10-14.
const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,5 +10,5 @@',
  ' line 10',
  ' line 11',
  '-old 12',
  '+new 12',
  ' line 13',
  ' line 14',
  '',
].join('\n');

const COMPARISON = { key: 'commit:abc123', files: [FILE], error: null };
const REFRESHED = { key: 'commit:abc123@2', files: [FILE], error: null };
const CHANGED_FILES = [FILE];
const NOOP = () => {};
const requests = new Map<number, CommentLocationRequest>();
const request = (line: number): CommentLocationRequest => {
  const existing = requests.get(line);
  if (existing) return existing;
  const created = makeRequest(line);
  requests.set(line, created);
  return created;
};
const makeRequest = (line: number): CommentLocationRequest => ({
  runtimeKey: 'local', directory: DIRECTORY, filePath: FILE.path, line, side: 'additions', origin: { kind: 'commit', hash: 'abc123' },
});

type Props = {
  jump: CommentLocationRequest | null;
  filesShown: boolean;
  entry: ComparisonDiffResult | undefined;
  statusLoaded?: boolean;
  hideWhitespace?: boolean;
  refreshed?: boolean;
};

let root: Root;
let host: HTMLDivElement;
let done: number;
let revealed: string[];
let scrolls: Array<{ filePath: string; lineNumber: number }>;
let showsWholeFile: (path: string) => boolean;
let opened: number;

const Probe = ({ jump, filesShown, entry, statusLoaded = true, hideWhitespace = false, refreshed = false }: Props) => {
  showsWholeFile = useAnswerCommentJump({
    commentJump: { jump, done: React.useCallback(() => { done += 1; }, []), leave: NOOP },
    scope: 'commit',
    directory: DIRECTORY,
    branch: 'main',
    branchBaseMissing: false,
    statusLoaded,
    hideWhitespace,
    commentOrigin: ORIGIN,
    comparison: refreshed ? REFRESHED : COMPARISON,
    withheldPullRequest: null,
    changedFiles: CHANGED_FILES,
    filesShown,
    comparisonEntry: () => entry,
    openComparison: React.useCallback(() => { opened += 1; }, []),
    revealFile: React.useCallback((path: string) => { revealed.push(path); }, []),
    scrollToLocation: React.useCallback((target: { filePath: string; lineNumber: number }) => {
      scrolls.push({ filePath: target.filePath, lineNumber: target.lineNumber });
    }, []),
  });
  return null;
};

const render = (props: Props) => act(async () => root.render(<Probe {...props} />));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  done = 0;
  revealed = [];
  scrolls = [];
  opened = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('a line jump waits for the drill to show its files before it is taken', async () => {
  const entry = createComparisonDiffFromPatch(FILE.path, PATCH, 'patch');
  await render({ jump: request(12), filesShown: false, entry });
  expect(done).toBe(0);
  expect(scrolls).toEqual([]);

  await render({ jump: request(12), filesShown: true, entry });
  expect(done).toBe(1);
  expect(revealed).toEqual([FILE.path]);
  expect(scrolls).toEqual([{ filePath: FILE.path, lineNumber: 12 }]);
});

test('a line the default patch shows is reached without reading the whole file', async () => {
  await render({ jump: request(13), filesShown: true, entry: createComparisonDiffFromPatch(FILE.path, PATCH, 'patch') });
  expect(scrolls).toEqual([{ filePath: FILE.path, lineNumber: 13 }]);
  expect(showsWholeFile(FILE.path)).toBe(false);
});

test('a line outside the default patch asks for the whole file', async () => {
  await render({ jump: request(40), filesShown: true, entry: createComparisonDiffFromPatch(FILE.path, PATCH, 'patch') });
  expect(scrolls).toEqual([{ filePath: FILE.path, lineNumber: 40 }]);
  expect(showsWholeFile(FILE.path)).toBe(true);
});

test('the line waits for the row\'s patch to load before deciding', async () => {
  await render({ jump: request(40), filesShown: true, entry: { status: 'loading' } });
  expect(revealed).toEqual([FILE.path]);
  expect(scrolls).toEqual([]);
  expect(showsWholeFile(FILE.path)).toBe(false);

  await render({ jump: null, filesShown: true, entry: createComparisonDiffFromPatch(FILE.path, PATCH, 'patch') });
  expect(scrolls).toEqual([{ filePath: FILE.path, lineNumber: 40 }]);
  expect(showsWholeFile(FILE.path)).toBe(true);
});

test('a commit jump opens its drill only once Git status names the branch the drill is keyed by', async () => {
  const entry = createComparisonDiffFromPatch(FILE.path, PATCH, 'patch');
  await render({ jump: request(12), filesShown: false, entry, statusLoaded: false });
  expect(opened).toBe(0);
  await render({ jump: request(12), filesShown: false, entry, statusLoaded: true });
  expect(opened).toBe(1);
  expect(done).toBe(0);
});

test('with whitespace hidden, the raw hunks do not prove the line is shown, so the whole file is read', async () => {
  await render({ jump: request(13), filesShown: true, entry: createComparisonDiffFromPatch(FILE.path, PATCH, 'patch'), hideWhitespace: true });
  expect(scrolls).toEqual([{ filePath: FILE.path, lineNumber: 13 }]);
  expect(showsWholeFile(FILE.path)).toBe(true);
});

test('a line still waiting is dropped when the comparison is replaced by a new snapshot', async () => {
  await render({ jump: request(12), filesShown: true, entry: { status: 'loading' } });
  expect(revealed).toEqual([FILE.path]);
  await render({ jump: null, filesShown: true, entry: { status: 'loading' }, refreshed: true });
  await render({ jump: null, filesShown: true, entry: createComparisonDiffFromPatch(FILE.path, PATCH, 'patch'), refreshed: true });
  expect(scrolls).toEqual([]);
});
