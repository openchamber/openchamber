import { describe, expect, test } from 'bun:test';

import {
  filterStaleRecentFiles,
  mentionListState,
  mentionSearchKey,
  mentionServerQuery,
  rankFileMentionResults,
  tokenizeMentionQuery,
} from './fileMentionResults';

const hit = (relativePath: string) => {
  const name = relativePath.split('/').filter(Boolean).pop() ?? relativePath;
  return {
    name,
    path: `/root/${relativePath}`,
    relativePath,
    extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
  };
};

describe('tokenizeMentionQuery', () => {
  test('normalizes leading ./ and slashes and splits on whitespace', () => {
    expect(tokenizeMentionQuery('./Solo Team')).toEqual(['solo', 'team']);
    expect(tokenizeMentionQuery('  ')).toEqual([]);
  });
});

describe('mentionServerQuery', () => {
  test('uses the longest token for the server search', () => {
    expect(mentionServerQuery('team solo-is-a')).toBe('solo-is-a');
    expect(mentionServerQuery('')).toBe('');
  });
});

describe('rankFileMentionResults', () => {
  test('ranks files and directories together by match quality, not by category', () => {
    const files = [hit('solo-is-a-team-size/index.md'), hit('software-developer/index.md')];
    const directories = [hit('machine-learning/tensorflow/'), hit('solo-is-a-team-size/')];

    const ranked = rankFileMentionResults(files, directories, 'solo');
    const paths = ranked.map((entry) => entry.relativePath);

    expect(paths.slice(0, 2)).toEqual(['solo-is-a-team-size/', 'solo-is-a-team-size/index.md']);
    expect(paths).not.toContain('machine-learning/tensorflow/');
  });

  test('multi-token queries match tokens in any order across the path', () => {
    const files = [hit('solo-is-a-team-size/index.md'), hit('software-developer/index.md')];

    const ranked = rankFileMentionResults(files, [], 'team solo');
    expect(ranked.map((entry) => entry.relativePath)).toEqual(['solo-is-a-team-size/index.md']);
  });

  test('tags each result with its kind', () => {
    const ranked = rankFileMentionResults([hit('a/readme.md')], [hit('a/')], 'a');
    expect(ranked.find((entry) => entry.relativePath === 'a/')?.kind).toBe('directory');
    expect(ranked.find((entry) => entry.relativePath === 'a/readme.md')?.kind).toBe('file');
  });
});

describe('filterStaleRecentFiles', () => {
  test('returns all files when stale set is empty', () => {
    const items = [hit('file1.ts'), hit('file2.ts')];
    expect(filterStaleRecentFiles(items, new Set())).toEqual(items);
  });

  test('filters out paths present in the stale set', () => {
    const file1 = hit('file1.ts');
    const file2 = hit('file2.ts');
    const stale = new Set([file1.path]);
    expect(filterStaleRecentFiles([file1, file2], stale)).toEqual([file2]);
  });
});

describe('mentionSearchKey', () => {
  const options = { includeHidden: false, respectGitignore: true };

  test('needs no search without a directory, a query, or for a session title', () => {
    expect(mentionSearchKey('', 'src', options)).toBeNull();
    expect(mentionSearchKey('/repo', '  ', options)).toBeNull();
    expect(mentionSearchKey('/repo', 'fix login', options)).toBeNull();
  });

  test('queries the server sends alike share a key; anything that changes the answer does not', () => {
    const key = mentionSearchKey('/repo', 'Src', options);
    expect(mentionSearchKey('/repo', './src', options)).toBe(key);
    expect(mentionSearchKey('/repo', 'srcs', options)).not.toBe(key);
    expect(mentionSearchKey('/other', 'src', options)).not.toBe(key);
    expect(mentionSearchKey('/repo', 'src', { ...options, includeHidden: true })).not.toBe(key);
    expect(mentionSearchKey('/repo', 'src', { ...options, respectGitignore: false })).not.toBe(key);
  });
});

describe('mentionListState', () => {
  test('rows stay while the next query searches', () => {
    expect(mentionListState(3, true)).toBe('rows');
    expect(mentionListState(3, false)).toBe('rows');
  });

  test('with nothing to show, loads until the search settles, then says nothing matched', () => {
    expect(mentionListState(0, true)).toBe('loading');
    expect(mentionListState(0, false)).toBe('empty');
  });
});
