import { beforeEach, describe, expect, test } from 'bun:test';

import type { ComposerReference } from './composerReferences';
import {
    resolveComposerReferenceHandoffTarget,
    usePendingComposerReferences,
} from './pendingComposerReferences';

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

const draft = (workDraftId = 'draft-a', runtimeKey = 'runtime-a') => ({ kind: 'draft' as const, workDraftId, runtimeKey });

describe('pending composer references', () => {
    beforeEach(() => {
        usePendingComposerReferences.setState({ pending: [] });
    });

    test('a session handoff waits for that session and is not taken by another', () => {
        usePendingComposerReferences.getState().push([issue(221)], { kind: 'session', sessionId: 'session-a' });

        expect(usePendingComposerReferences.getState().consume({ kind: 'session', sessionId: 'session-b' })).toEqual([]);
        expect(usePendingComposerReferences.getState().pending).toHaveLength(1);
        expect(numbers(usePendingComposerReferences.getState().consume({ kind: 'session', sessionId: 'session-a' }))).toEqual([221]);
        expect(usePendingComposerReferences.getState().consume({ kind: 'session', sessionId: 'session-a' })).toEqual([]);
    });

    test('a draft handoff is not taken by a session composer', () => {
        usePendingComposerReferences.getState().push([issue(221)], draft());

        expect(usePendingComposerReferences.getState().consume({ kind: 'session', sessionId: 'session-a' })).toEqual([]);
        expect(numbers(usePendingComposerReferences.getState().consume(draft()))).toEqual([221]);
    });

    test('a named draft keeps its handoff for that draft', () => {
        usePendingComposerReferences.getState().push([issue(221)], draft());

        expect(usePendingComposerReferences.getState().consume(draft('draft-b'))).toEqual([]);
        expect(usePendingComposerReferences.getState().consume(draft('draft-a', 'runtime-b'))).toEqual([]);
        expect(numbers(usePendingComposerReferences.getState().consume(draft()))).toEqual([221]);
    });

    test('two handoffs keep their own references', () => {
        usePendingComposerReferences.getState().push([issue(221)], { kind: 'session', sessionId: 'session-a' });
        usePendingComposerReferences.getState().push([issue(258)], { kind: 'session', sessionId: 'session-b' });

        expect(numbers(usePendingComposerReferences.getState().consume({ kind: 'session', sessionId: 'session-b' }))).toEqual([258]);
        expect(numbers(usePendingComposerReferences.getState().consume({ kind: 'session', sessionId: 'session-a' }))).toEqual([221]);
    });

    test('a session handoff cannot be taken by a draft composer', () => {
        usePendingComposerReferences.getState().push([issue(221)], { kind: 'session', sessionId: 'session-a' });
        expect(usePendingComposerReferences.getState().consume(draft())).toEqual([]);
        expect(numbers(usePendingComposerReferences.getState().consume({ kind: 'session', sessionId: 'session-a' }))).toEqual([221]);
    });
});

describe('composer handoff target', () => {
    const base = {
        columnPinned: false,
        btwActive: false,
        currentSessionId: 'session-a',
        draftOpen: false,
        workDraftId: null,
        runtimeKey: 'runtime-a',
    };

    test('a session composer takes the session target', () => {
        expect(resolveComposerReferenceHandoffTarget(base)).toEqual({ kind: 'session', sessionId: 'session-a' });
    });

    test('a draft composer takes the draft target', () => {
        expect(resolveComposerReferenceHandoffTarget({
            ...base,
            currentSessionId: null,
            draftOpen: true,
            workDraftId: 'draft-a',
        })).toEqual(draft());
    });

    test('a pinned composer takes nothing', () => {
        expect(resolveComposerReferenceHandoffTarget({ ...base, columnPinned: true })).toBeNull();
    });

    test('an expanded /btw panel takes nothing, even with a session', () => {
        expect(resolveComposerReferenceHandoffTarget({ ...base, btwActive: true })).toBeNull();
    });

    test('no session and no draft takes nothing', () => {
        expect(resolveComposerReferenceHandoffTarget({ ...base, currentSessionId: null })).toBeNull();
    });

    test('a draft without an identity takes nothing', () => {
        expect(resolveComposerReferenceHandoffTarget({ ...base, currentSessionId: null, draftOpen: true })).toBeNull();
    });
});
