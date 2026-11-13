import { describe, expect, test } from 'bun:test';

import type { RepositoryDiscussionReference, RepositoryItemRef, RepositoryReferenceDetail, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';

import { resolveComposerReferences } from './resolveComposerReferences';

const context: SourceControlReadContext = {
    directory: '/repo', provider: 'github', instance: 'github.com', repositoryId: 'repo-one', accountId: 'acc', bindingRevision: 1, primaryRemote: 'origin',
};

const discussion: RepositoryDiscussionReference = {
    kind: 'discussion',
    provider: 'github',
    number: 5,
    title: 'How do I move sessions?',
    url: 'https://github.com/acme/app/discussions/5',
    body: 'Steps',
    bodyTruncated: false,
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-02T10:00:00Z',
    author: { login: 'asker' },
    labels: [{ name: 'question' }],
    commentCount: 1,
    sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    state: 'open',
    answered: true,
    upvotes: 2,
    locked: false,
    category: { name: 'Q&A', emoji: '🙏', answerable: true },
};

const comment = (body: string) => ({ author: { login: 'helper' }, body, createdAt: '2026-10-01T11:00:00Z', url: `u-${body}`, path: null, line: null, review: null });

const detail: RepositoryReferenceDetail = {
    number: 5,
    comments: [{
        ...comment('Use export'),
        thread: { id: 'DC_1', resolved: false, canResolve: false, canReply: true, replies: [comment('Thanks')] },
        answer: { chosen: true, canChange: false },
    }],
    commentTotal: 1,
    pull: null,
    discussion: { canComment: true, canClose: false, canReopen: false },
};

describe('resolveComposerReferences', () => {
    test('attaches a discussion with its comments, their replies and which one is the answer', async () => {
        const asked: Array<RepositoryItemRef & { kind?: 'discussion' }> = [];
        const unexpected = () => Promise.reject(new Error('not read for a discussion'));
        const sourceControl: Pick<SourceControlAPI, 'issueGet' | 'issueComments' | 'changeRequestContext' | 'referenceDetail'> = {
            issueGet: unexpected,
            issueComments: unexpected,
            changeRequestContext: unexpected,
            referenceDetail: async (_context, ref) => {
                asked.push(ref);
                return { connected: true, detail };
            },
        };
        const result = await resolveComposerReferences([{ source: 'repository', reference: discussion, includeDiff: false }], {
            sourceControl,
            context,
            readTrackerDetail: unexpected,
            trackerName: () => '',
        });

        expect(result.failures).toEqual([]);
        expect(asked).toEqual([{ owner: 'acme', repo: 'app', number: 5, kind: 'discussion' }]);
        const [reference] = result.references;
        expect(reference).toMatchObject({ kind: 'repository-discussion', provider: 'github', number: 5, url: discussion.url, author: { login: 'asker' } });
        if (reference?.kind !== 'repository-discussion') throw new Error('expected a discussion');
        const [header, ...json] = reference.contextText.split('\n');
        expect(header).toBe('Source control discussion context (JSON)');
        expect(JSON.parse(json.join('\n'))).toMatchObject({
            project: { owner: 'acme', name: 'app' },
            discussion: { number: 5, state: 'open', category: 'Q&A', answered: true, labels: ['question'], body: 'Steps', bodyTruncated: false },
            commentTotal: 1,
            comments: [{ author: 'helper', body: 'Use export', isAnswer: true, replies: [{ author: 'helper', body: 'Thanks' }] }],
        });
    });

    test('reports a discussion its host cannot read and attaches nothing for it', async () => {
        const unexpected = () => Promise.reject(new Error('not read for a discussion'));
        const result = await resolveComposerReferences([{ source: 'repository', reference: discussion, includeDiff: false }], {
            sourceControl: { issueGet: unexpected, issueComments: unexpected, changeRequestContext: unexpected, referenceDetail: async () => ({ connected: true, detail: null }) },
            context,
            readTrackerDetail: unexpected,
            trackerName: () => '',
        });
        expect(result.references).toEqual([]);
        expect(result.failures).toEqual([{ key: 'github:acme/app~5', label: '#5', error: 'Discussion not found' }]);
    });
});
