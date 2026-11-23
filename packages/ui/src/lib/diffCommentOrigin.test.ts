import { describe, expect, test } from 'bun:test';

import { describeDiffCommentOrigin, diffCommentOriginFromSource, diffCommentOriginKey, fileWithDiffCommentOrigin } from './diffCommentOrigin';

describe('diff comment origin', () => {
    test('uncommitted and staged changes tell the agent the lines are not committed', () => {
        expect(diffCommentOriginFromSource({ kind: 'working-tree', scope: 'all' })).toEqual({ kind: 'working-tree' });
        expect(diffCommentOriginFromSource({ kind: 'working-tree', scope: 'staged' })).toEqual({ kind: 'working-tree', staged: true });
        expect(describeDiffCommentOrigin({ kind: 'working-tree' })).toBe('in the uncommitted changes in the working tree');
        expect(describeDiffCommentOrigin({ kind: 'working-tree', staged: true })).toBe('in the staged changes, not committed yet');
        expect(diffCommentOriginFromSource(null)).toBeUndefined();
    });

    test('staged, unstaged and turn comments are different diffs, and none shows a label on the chip', () => {
        const keys = [
            diffCommentOriginKey({ kind: 'working-tree' }),
            diffCommentOriginKey({ kind: 'working-tree', staged: true }),
            diffCommentOriginKey({ kind: 'turn', turnId: 'msg_1' }),
            diffCommentOriginKey({ kind: 'turn', turnId: 'msg_2' }),
            diffCommentOriginKey(undefined),
        ];
        expect(new Set(keys).size).toBe(keys.length);
        expect(fileWithDiffCommentOrigin('app.ts', { kind: 'working-tree', staged: true })).toBe('app.ts');
        expect(describeDiffCommentOrigin({ kind: 'turn' })).not.toContain('ended');
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
