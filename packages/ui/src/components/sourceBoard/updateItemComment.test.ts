import { describe, expect, test } from 'bun:test';

import type { RepositoryChangeRequestReference, RepositoryDiscussionReference, RepositoryIssueReference, SourceControlEmptyMutationResult, SourceControlMutationReceipt, SourceControlReadContext } from '@/lib/api/types';
import { deleteRepositoryComment, updateRepositoryComment, type ItemCommentWriteAPI } from './updateItemComment';

const context: SourceControlReadContext = {
    provider: 'github', instance: 'github.com', directory: '/work/app', repositoryId: 'repo-1',
    accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};

const issue: RepositoryIssueReference = {
    kind: 'issue', provider: 'github', number: 7, title: 'Tidy the header', url: 'https://github.com/acme/app/issues/7',
    body: 'List body', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
    sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' }, state: 'open',
};
const pull: RepositoryChangeRequestReference = {
    ...issue, kind: 'pull', number: 12, title: 'Login flow', url: 'https://github.com/acme/app/pull/12',
    state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'abc123', headRepo: null,
};
const discussion: RepositoryDiscussionReference = {
    ...issue, kind: 'discussion', number: 3, title: 'How do we cache', url: 'https://github.com/acme/app/discussions/3',
    state: 'open', answered: null, upvotes: 2, locked: false, category: { name: 'Ideas', emoji: null, answerable: true },
};

const receipt: SourceControlMutationReceipt<SourceControlEmptyMutationResult> = {
    status: 'succeeded',
    actor: { provider: 'github', instance: 'github.com', providerAccountId: '7' },
    target: { repositoryId: 'repo-1', bindingRevision: 1, primaryRemote: 'origin', project: { id: 'p', owner: 'acme', name: 'app' }, number: 7 },
    replayed: false,
    result: {},
};

type Method = 'issueCommentUpdate' | 'issueCommentDelete' | 'changeRequestCommentUpdate' | 'changeRequestCommentDelete' | 'discussionCommentUpdate' | 'discussionCommentDelete';
type Payload = { commentId: string; body?: string; idempotencyKey: string; target: { number: number; head?: string; base?: string; headSha?: string } };

const recorder = () => {
    const sent: Array<{ method: Method; payload: Payload }> = [];
    const record = (method: Method) => async (payload: Payload) => {
        sent.push({ method, payload });
        return receipt;
    };
    const sourceControl: ItemCommentWriteAPI = {
        issueCommentUpdate: record('issueCommentUpdate'),
        issueCommentDelete: record('issueCommentDelete'),
        changeRequestCommentUpdate: record('changeRequestCommentUpdate'),
        changeRequestCommentDelete: record('changeRequestCommentDelete'),
        discussionCommentUpdate: record('discussionCommentUpdate'),
        discussionCommentDelete: record('discussionCommentDelete'),
    };
    return { sent, sourceControl };
};

describe('editing and deleting a repository comment', () => {
    test('an issue comment is written through the issue comment edit, naming its project and number', async () => {
        const { sent, sourceControl } = recorder();
        await updateRepositoryComment(sourceControl, context, issue, { id: 'c1' }, 'A new note');

        expect(sent).toHaveLength(1);
        expect(sent[0].method).toBe('issueCommentUpdate');
        expect(sent[0].payload).toMatchObject({
            ...context,
            target: { project: { owner: 'acme', name: 'app' }, number: 7 },
            commentId: 'c1',
            body: 'A new note',
        });
        expect(sent[0].payload.idempotencyKey).not.toBe('');
    });

    test('a change request comment is written through the change comment edit, on the head the preview shows', async () => {
        const { sent, sourceControl } = recorder();
        await updateRepositoryComment(sourceControl, context, pull, { id: 'c2' }, 'A new note');

        expect(sent).toHaveLength(1);
        expect(sent[0].method).toBe('changeRequestCommentUpdate');
        expect(sent[0].payload).toMatchObject({
            target: { project: { owner: 'acme', name: 'app' }, number: 12, head: 'feature', base: 'main', headSha: 'abc123' },
            commentId: 'c2',
            body: 'A new note',
        });
    });

    test('a discussion comment is written through the discussion comment edit', async () => {
        const { sent, sourceControl } = recorder();
        await updateRepositoryComment(sourceControl, context, discussion, { id: 'c3' }, 'A new note');

        expect(sent).toHaveLength(1);
        expect(sent[0].method).toBe('discussionCommentUpdate');
        expect(sent[0].payload.target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 3 });
    });

    test('a delete names the comment on the host its kind belongs to, without a body', async () => {
        const { sent, sourceControl } = recorder();
        await deleteRepositoryComment(sourceControl, context, issue, { id: 'c1' });
        await deleteRepositoryComment(sourceControl, context, pull, { id: 'c2' });
        await deleteRepositoryComment(sourceControl, context, discussion, { id: 'c3' });

        expect(sent.map((entry) => entry.method)).toEqual(['issueCommentDelete', 'changeRequestCommentDelete', 'discussionCommentDelete']);
        expect(sent.map((entry) => entry.payload.commentId)).toEqual(['c1', 'c2', 'c3']);
        expect(sent.every((entry) => entry.payload.body === undefined)).toBe(true);
        expect(new Set(sent.map((entry) => entry.payload.idempotencyKey)).size).toBe(3);
    });
});
