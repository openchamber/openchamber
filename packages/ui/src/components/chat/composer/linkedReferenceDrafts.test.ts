import { beforeEach, describe, expect, test } from 'bun:test';

import { clearChatDraft, createChatDraftIdentity } from '@/lib/chatDraftPersistence';

import type { ComposerReference } from './composerReferences';
import { readLinkedReferences, useLinkedReferenceDrafts } from './linkedReferenceDrafts';

const identity = (sessionId: string, directory = '/repo') => createChatDraftIdentity('runtime', directory, sessionId);

const issue = (number: number): ComposerReference => ({
    kind: 'repository-issue',
    provider: 'github',
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/app/issues/${number}`,
    contextText: `Source control issue context: ${number}`,
});

const numbers = (references: readonly ComposerReference[]) => references.map((reference) => (
    reference.kind === 'repository-issue' ? reference.number : -1
));

describe('composer reference chips', () => {
    beforeEach(() => {
        useLinkedReferenceDrafts.setState({ drafts: new Map() });
    });

    test('a chip attached in one session stays out of every other session', () => {
        const a = identity('session-a')!;
        const b = identity('session-b')!;

        useLinkedReferenceDrafts.getState().set([issue(221)], a);

        expect(numbers(readLinkedReferences(a))).toEqual([221]);
        expect(readLinkedReferences(b)).toEqual([]);

        useLinkedReferenceDrafts.getState().set([issue(222)], b);
        expect(numbers(readLinkedReferences(a))).toEqual([221]);
        expect(numbers(readLinkedReferences(b))).toEqual([222]);
    });

    test('clearing the draft that sent leaves another draft untouched', () => {
        const a = identity('session-a')!;
        const b = identity('session-b')!;
        useLinkedReferenceDrafts.getState().set([issue(221)], a);
        useLinkedReferenceDrafts.getState().set([issue(222)], b);

        useLinkedReferenceDrafts.getState().set([], a);

        expect(readLinkedReferences(a)).toEqual([]);
        expect(numbers(readLinkedReferences(b))).toEqual([222]);
    });

    test('the same session in another directory is another composer', () => {
        const repo = identity('session-a', '/repo')!;
        const worktree = identity('session-a', '/repo/.worktrees/one')!;
        useLinkedReferenceDrafts.getState().set([issue(221)], repo);

        expect(readLinkedReferences(worktree)).toEqual([]);
    });

    test('deleting a draft drops its chips and keeps its neighbour', () => {
        const a = identity('session-a')!;
        const b = identity('session-b')!;
        useLinkedReferenceDrafts.getState().set([issue(221)], a);
        useLinkedReferenceDrafts.getState().set([issue(222)], b);

        clearChatDraft(a, true);

        expect(readLinkedReferences(a)).toEqual([]);
        expect(numbers(readLinkedReferences(b))).toEqual([222]);
    });

    test('a composer without a draft identity holds no chips', () => {
        useLinkedReferenceDrafts.getState().set([issue(221)], null);
        expect(readLinkedReferences(null)).toEqual([]);
    });

    test('moving chips merges additions at both identities and keeps the destination snapshot', () => {
        const from = identity('draft:work-a')!;
        const to = identity('session-a')!;
        useLinkedReferenceDrafts.getState().set([issue(221), issue(222)], from);
        useLinkedReferenceDrafts.getState().set([{ ...issue(221), contextText: 'Updated' }, issue(223)], to);

        useLinkedReferenceDrafts.getState().move(from, to);

        expect(readLinkedReferences(from)).toEqual([]);
        expect(numbers(readLinkedReferences(to))).toEqual([221, 222, 223]);
        expect(readLinkedReferences(to)[0].contextText).toBe('Updated');
        useLinkedReferenceDrafts.getState().move(from, to);
        useLinkedReferenceDrafts.getState().move(to, to);
        expect(numbers(readLinkedReferences(to))).toEqual([221, 222, 223]);
    });
});
