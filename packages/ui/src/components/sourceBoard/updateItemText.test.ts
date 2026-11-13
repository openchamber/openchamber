import { describe, expect, test } from 'bun:test';

import type { RepositoryChangeRequestReference, RepositoryIssueReference, RepositoryDiscussionReference, SourceControlEmptyMutationResult, SourceControlMutationReceipt, SourceControlReadContext } from '@/lib/api/types';
import { updateRepositoryItemText, type ItemTextWriteAPI } from './updateItemText';

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

const recorder = () => {
    const sent: Array<{ method: 'issueUpdate' | 'changeRequestUpdate' | 'discussionUpdate'; payload: { title: string; body?: string; idempotencyKey: string; target: { number: number; head?: string; base?: string; headSha?: string } } }> = [];
    const record = (method: (typeof sent)[number]['method']) => async (payload: (typeof sent)[number]['payload']) => {
        sent.push({ method, payload });
        return receipt;
    };
    const sourceControl: ItemTextWriteAPI = {
        issueUpdate: record('issueUpdate'),
        changeRequestUpdate: record('changeRequestUpdate'),
        discussionUpdate: record('discussionUpdate'),
    };
    return { sent, sourceControl };
};

describe('editing a repository item in place', () => {
    test('an issue is written through the issue edit, naming its project and number', async () => {
        const { sent, sourceControl } = recorder();
        await updateRepositoryItemText(sourceControl, context, issue, { title: 'Tidied', body: 'New body' });

        expect(sent).toHaveLength(1);
        expect(sent[0].method).toBe('issueUpdate');
        expect(sent[0].payload).toMatchObject({
            ...context,
            target: { project: { owner: 'acme', name: 'app' }, number: 7 },
            title: 'Tidied',
            body: 'New body',
        });
        expect(sent[0].payload.idempotencyKey).not.toBe('');
    });

    test('a change request is written through the change edit, on the head the preview shows', async () => {
        const { sent, sourceControl } = recorder();
        await updateRepositoryItemText(sourceControl, context, pull, { title: 'Login flow', body: '' });

        expect(sent).toHaveLength(1);
        expect(sent[0].method).toBe('changeRequestUpdate');
        expect(sent[0].payload).toMatchObject({
            target: { project: { owner: 'acme', name: 'app' }, number: 12, head: 'feature', base: 'main', headSha: 'abc123' },
            title: 'Login flow',
            body: '',
        });
    });

    test('a discussion is written through the discussion edit', async () => {
        const { sent, sourceControl } = recorder();
        await updateRepositoryItemText(sourceControl, context, discussion, { title: 'Caching answers', body: 'Body' });

        expect(sent).toHaveLength(1);
        expect(sent[0].method).toBe('discussionUpdate');
        expect(sent[0].payload.target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 3 });
    });
});
