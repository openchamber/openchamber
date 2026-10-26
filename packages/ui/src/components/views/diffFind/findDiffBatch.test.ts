import { expect, test } from 'bun:test';

import type { GetGitDiffsOptions, GitPathDiffBatchEntry } from '@/lib/api/types';
import { createFindDiffBatchReader, type FindDiffBatchRead } from './findDiffBatch';

const okEntry = (path: string): GitPathDiffBatchEntry => ({ path, ok: true, diff: { diff: `diff of ${path}`, submodule: null } });

const recordingGitDiffs = (answer: (options: GetGitDiffsOptions) => Promise<GitPathDiffBatchEntry[]>) => {
  const calls: string[][] = [];
  const getGitDiffs = (_directory: string, options: GetGitDiffsOptions) => {
    calls.push(options.paths);
    return answer(options);
  };
  return { calls, getGitDiffs };
};

const readOf = (getGitDiffs: FindDiffBatchRead['getGitDiffs'], filePath: string, peers: FindDiffBatchRead['peers'], revision = 'r1'): FindDiffBatchRead => ({
  directory: '/repo', filePath, revision, staged: false, contextLines: 3, peers, getGitDiffs,
});

test('the first read asks for every peer once and the rest are answered from it', async () => {
  const { calls, getGitDiffs } = recordingGitDiffs(async (options) => options.paths.map(okEntry));
  const read = createFindDiffBatchReader();
  const peers = [{ filePath: 'a.ts', revision: 'r1' }, { filePath: 'b.ts', revision: 'r1' }, { filePath: 'c.ts', revision: 'r1' }];

  expect(await read(readOf(getGitDiffs, 'a.ts', peers))).toEqual(okEntry('a.ts'));
  expect(await read(readOf(getGitDiffs, 'b.ts', peers))).toEqual(okEntry('b.ts'));
  expect(await read(readOf(getGitDiffs, 'c.ts', peers))).toEqual(okEntry('c.ts'));
  expect(calls).toEqual([['a.ts', 'b.ts', 'c.ts']]);
});

test('a file at a new revision is read again with only the other stale files', async () => {
  const { calls, getGitDiffs } = recordingGitDiffs(async (options) => options.paths.map(okEntry));
  const read = createFindDiffBatchReader();
  await read(readOf(getGitDiffs, 'a.ts', [{ filePath: 'a.ts', revision: 'r1' }, { filePath: 'b.ts', revision: 'r1' }]));

  const peers = [{ filePath: 'a.ts', revision: 'r1' }, { filePath: 'b.ts', revision: 'r2' }];
  expect(await read(readOf(getGitDiffs, 'b.ts', peers, 'r2'))).toEqual(okEntry('b.ts'));
  expect(calls).toEqual([['a.ts', 'b.ts'], ['b.ts']]);
});

test('a failed request answers null, so the file reads on its own, and is asked again next time', async () => {
  let fail = true;
  const { calls, getGitDiffs } = recordingGitDiffs(async (options) => {
    if (fail) throw new Error('offline');
    return options.paths.map(okEntry);
  });
  const read = createFindDiffBatchReader();
  const peers = [{ filePath: 'a.ts', revision: 'r1' }, { filePath: 'b.ts', revision: 'r1' }];

  expect(await read(readOf(getGitDiffs, 'a.ts', peers))).toBeNull();
  fail = false;
  expect(await read(readOf(getGitDiffs, 'b.ts', peers))).toEqual(okEntry('b.ts'));
  expect(calls).toEqual([['a.ts', 'b.ts'], ['b.ts', 'a.ts']]);
});

test('a path the answer leaves out resolves to null and a path error is passed through', async () => {
  const { getGitDiffs } = recordingGitDiffs(async () => [
    { path: 'gone.ts', ok: false, error: 'Path not found', reason: 'path_not_found' },
  ]);
  const read = createFindDiffBatchReader();
  const peers = [{ filePath: 'gone.ts', revision: 'r1' }, { filePath: 'missing.ts', revision: 'r1' }];

  expect(await read(readOf(getGitDiffs, 'gone.ts', peers))).toEqual({ path: 'gone.ts', ok: false, error: 'Path not found', reason: 'path_not_found' });
  expect(await read(readOf(getGitDiffs, 'missing.ts', peers))).toBeNull();
});
