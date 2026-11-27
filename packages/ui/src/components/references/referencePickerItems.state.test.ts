import { describe, expect, test } from 'bun:test';
import type { RepositoryChangeRequestReference, RepositoryDiscussionReference, RepositoryIssueReference, RepositoryReferenceDetail } from '@/lib/api/types';
import { canChangeReferenceState } from './referencePickerItems';

const base: Omit<RepositoryIssueReference, 'kind' | 'state'> = {
    number: 5,
    title: 'Fix the footer',
    url: 'https://github.com/acme/app/issues/5',
    body: '',
    bodyTruncated: false,
    createdAt: null,
    updatedAt: null,
    author: null,
    labels: [],
    commentCount: 0,
    sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    provider: 'github',
};

const issue = (state: RepositoryIssueReference['state'] = 'open'): RepositoryIssueReference => ({ ...base, kind: 'issue', state });

const discussion = (state: RepositoryDiscussionReference['state']): RepositoryDiscussionReference => ({
    ...base,
    kind: 'discussion',
    state,
    answered: null,
    upvotes: 0,
    locked: false,
    category: { name: 'General', emoji: null, answerable: true },
});

const read = (fields: Partial<RepositoryReferenceDetail>): RepositoryReferenceDetail => ({
    number: 5,
    comments: [],
    commentTotal: 0,
    pull: null,
    ...fields,
});

describe('who may change the state of an item', () => {
    test('answers nothing until the item read arrives', () => {
        for (const reference of [issue(), issue('completed')]) {
            expect(canChangeReferenceState(reference, null)).toBe(false);
        }
        for (const state of ['open', 'resolved', 'outdated', 'duplicate'] as const) {
            expect(canChangeReferenceState(discussion(state), null)).toBe(false);
        }
    });

    test('offers the change once the read reports write access, or the item itself as the viewer\'s to change', () => {
        expect(canChangeReferenceState(issue(), read({ writeAccess: true }))).toBe(true);
        expect(canChangeReferenceState(issue(), read({ writeAccess: false, viewerCanUpdate: true }))).toBe(true);
        expect(canChangeReferenceState(issue(), read({ writeAccess: false }))).toBe(true);
    });

    test('refuses a viewer the read grades read-only', () => {
        expect(canChangeReferenceState(issue(), read({ writeAccess: false, viewerCanUpdate: false }))).toBe(false);
        expect(canChangeReferenceState(issue(), read({ writeAccess: true, viewerCanUpdate: false }))).toBe(true);
    });

    test('refuses a host that grades the viewer read-only through the item alone', () => {
        expect(canChangeReferenceState(issue(), read({ viewerCanUpdate: false }))).toBe(true);
    });

    test('follows the discussion\'s own close and reopen answers', () => {
        const closable = { canComment: true, canClose: true, canReopen: true };
        expect(canChangeReferenceState(discussion('open'), read({ discussion: closable }))).toBe(true);
        expect(canChangeReferenceState(discussion('resolved'), read({ discussion: closable }))).toBe(true);
        expect(canChangeReferenceState(discussion('open'), read({ discussion: { ...closable, canClose: false } }))).toBe(false);
        expect(canChangeReferenceState(discussion('resolved'), read({ discussion: { ...closable, canReopen: false } }))).toBe(false);
    });

    test('answers nothing for a discussion whose read carries no permissions', () => {
        expect(canChangeReferenceState(discussion('open'), read({}))).toBe(false);
    });

    test('keeps a merged change request out of reach even when the read allows writes', () => {
        const merged: RepositoryChangeRequestReference = {
            ...base, kind: 'pull', state: 'merged', draft: false, head: 'feature', base: 'main', headSha: 'abc', headRepo: null,
        };
        expect(canChangeReferenceState(merged, read({ writeAccess: true }))).toBe(false);
    });
});
