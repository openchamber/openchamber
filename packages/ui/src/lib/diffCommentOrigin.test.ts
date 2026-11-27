import { describe, expect, test } from 'bun:test';

import { pullRequestSourceOf } from './commentLocation';
import {
    changeRequestMoved, describeDiffCommentOrigin, diffCommentOriginFromSource, diffCommentOriginKey, fileWithDiffCommentOrigin, sameCommentOrigin,
} from './diffCommentOrigin';

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

    test('a change request without a host still names the comparison the surface shows', () => {
        const known = diffCommentOriginFromSource({ kind: 'pr', number: 42, sourceRepo: { owner: 'team', repo: 'project' } }, { provider: 'github' });
        const olderMessage = { kind: 'change-request' as const, number: 42, repository: 'team/project' };
        expect(sameCommentOrigin(known, olderMessage)).toBe(true);
        expect(sameCommentOrigin(olderMessage, known)).toBe(true);
        // Another host or another pull request is another comparison.
        expect(sameCommentOrigin(known, { ...olderMessage, provider: 'gitlab' })).toBe(false);
        expect(sameCommentOrigin(known, { ...olderMessage, number: 43 })).toBe(false);
        expect(sameCommentOrigin(known, { ...olderMessage, repository: 'team/other' })).toBe(false);
        // Two revisions of one change request are two comparisons.
        expect(sameCommentOrigin({ ...olderMessage, revision: 'aaa' }, { ...olderMessage, revision: 'bbb' })).toBe(false);
        expect(sameCommentOrigin({ ...olderMessage, revision: 'aaa' }, { ...olderMessage, revision: 'aaa' })).toBe(true);
    });

    test('commits and branches match on the refs they were read at', () => {
        expect(sameCommentOrigin({ kind: 'commit', hash: 'abc' }, { kind: 'commit', hash: 'abc' })).toBe(true);
        expect(sameCommentOrigin({ kind: 'commit', hash: 'abc' }, { kind: 'commit', hash: 'def' })).toBe(false);
        expect(sameCommentOrigin(
            { kind: 'branch', baseRef: 'main', headRef: 'feature' },
            { kind: 'branch', baseRef: 'main', headRef: 'feature' },
        )).toBe(true);
        expect(sameCommentOrigin(
            { kind: 'branch', baseRef: 'main', headRef: 'feature' },
            { kind: 'branch', baseRef: 'main', headRef: 'other' },
        )).toBe(false);
        // Git reports the comparison base as refs/heads/main on one path and as main after an override;
        // both name the same comparison, so the pending jump must not be dropped on the prefix.
        expect(sameCommentOrigin(
            { kind: 'branch', baseRef: 'main', headRef: 'feature' },
            { kind: 'branch', baseRef: 'refs/heads/main', headRef: 'refs/heads/feature' },
        )).toBe(true);
        expect(diffCommentOriginKey({ kind: 'branch', baseRef: 'refs/heads/main', headRef: 'feature' }))
            .toBe(diffCommentOriginKey({ kind: 'branch', baseRef: 'main', headRef: 'feature' }));
        // A remote-tracking base is another comparison than the local branch of the same name.
        expect(sameCommentOrigin(
            { kind: 'branch', baseRef: 'origin/main', headRef: 'feature' },
            { kind: 'branch', baseRef: 'refs/heads/main', headRef: 'feature' },
        )).toBe(false);
        expect(sameCommentOrigin(
            { kind: 'branch', baseRef: 'refs/remotes/origin/main', headRef: 'feature' },
            { kind: 'branch', baseRef: 'origin/main', headRef: 'feature' },
        )).toBe(true);
        expect(sameCommentOrigin(undefined, { kind: 'commit', hash: 'abc' })).toBe(false);
        expect(sameCommentOrigin(undefined, undefined)).toBe(true);
    });

    test('a change request repository round-trips nested and top-level project paths', () => {
        for (const sourceRepo of [{ owner: 'group/subgroup', repo: 'project' }, { owner: '', repo: 'project' }, { owner: 'team', repo: 'project' }]) {
            const origin = diffCommentOriginFromSource({ kind: 'pr', number: 7, sourceRepo });
            if (origin?.kind !== 'change-request') throw new Error('expected a change request origin');
            expect(pullRequestSourceOf(origin).sourceRepo).toEqual(sourceRepo);
        }
        expect(diffCommentOriginFromSource({ kind: 'pr', number: 7, sourceRepo: { owner: '', repo: 'project' } }))
            .toMatchObject({ repository: 'project' });
    });

    test('a comparison origin names the repository it was read in', () => {
        expect(diffCommentOriginFromSource({ kind: 'commit', hash: 'abc' }, undefined, '/repo/nested'))
            .toEqual({ kind: 'commit', hash: 'abc', directory: '/repo/nested' });
        expect(diffCommentOriginFromSource({ kind: 'commit', hash: 'abc' })).toEqual({ kind: 'commit', hash: 'abc' });
    });

    test('a change request read at another head has moved; one without a known head has not', () => {
        const recorded = { kind: 'change-request' as const, provider: 'github' as const, number: 7, repository: 'team/project', revision: 'aaa' };
        expect(changeRequestMoved({ ...recorded, revision: 'bbb' }, recorded)).toBe(true);
        expect(changeRequestMoved(recorded, recorded)).toBe(false);
        expect(changeRequestMoved({ ...recorded, revision: undefined }, recorded)).toBe(false);
        expect(changeRequestMoved({ ...recorded, number: 8, revision: 'bbb' }, recorded)).toBe(false);
    });
});
