import { describe, expect, test } from 'bun:test';

import { diffCommentOriginFromSource, diffCommentOriginKey, fileWithDiffCommentOrigin } from './diffCommentOrigin';

describe('diff comment origin', () => {
    test('uncommitted changes need none: their lines are the files on disk', () => {
        expect(diffCommentOriginFromSource({ kind: 'working-tree', scope: 'all' })).toBeUndefined();
        expect(diffCommentOriginFromSource(null)).toBeUndefined();
        expect(diffCommentOriginKey(undefined)).toBe('');
    });

    test('a pull request keeps its host, repository and the head it was read at', () => {
        expect(diffCommentOriginFromSource(
            { kind: 'pr', number: 5543, sourceRepo: { owner: 'octo', repo: 'repo' } },
            { provider: 'github', revision: 'abc' },
        )).toEqual({ kind: 'change-request', provider: 'github', number: 5543, repository: 'octo/repo', revision: 'abc' });
    });

    test('a pull request and a commit with the same file are different diffs', () => {
        const pr = diffCommentOriginFromSource({ kind: 'pr', number: 7 }, { provider: 'github' });
        const commit = diffCommentOriginFromSource({ kind: 'commit', hash: 'e1d7e1022bb5a0' });
        expect(diffCommentOriginKey(pr)).not.toBe(diffCommentOriginKey(commit));
        expect(diffCommentOriginKey(pr)).not.toBe('');
    });

    test('chips name the diff beside the file', () => {
        expect(fileWithDiffCommentOrigin('app.ts', { kind: 'commit', hash: 'e1d7e1022bb5a0' })).toBe('app.ts (e1d7e1022b)');
        expect(fileWithDiffCommentOrigin('app.ts', { kind: 'change-request', number: 7 })).toBe('app.ts (#7)');
        expect(fileWithDiffCommentOrigin('app.ts', undefined)).toBe('app.ts');
    });
});
