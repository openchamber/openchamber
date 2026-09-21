import { describe, expect, test } from 'bun:test';

import { mentionServerQuery, rankFileMentionResults, tokenizeMentionQuery } from './fileMentionResults';

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
