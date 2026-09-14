import { beforeEach, describe, expect, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { getMessageQueueKey, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useInputStore } from '@/sync/input-store';
import {
    captureComposerContextForQueue,
    consumeComposerContext,
    removeQueuedMessageWithContextRestore,
    withComposerContextRestore,
} from './contextHandoff';

const target = (sessionId: string) => ({
    runtimeKey: getRuntimeKey(),
    directory: '/repo',
    sessionId,
});

const draft = {
    source: 'diff' as const,
    fileLabel: 'src/example.ts',
    startLine: 1,
    endLine: 1,
    code: 'const answer = 41;',
    language: 'ts',
    text: 'please update this',
};

describe('composer context handoff', () => {
    beforeEach(() => {
        useInputStore.setState({
            pendingSyntheticParts: null,
            pendingSyntheticPartsByTarget: new Map(),
        });
        useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
        useMessageQueueStore.setState({
            queuedMessages: {},
            sendingIds: {},
            quarantinedLegacyMessages: {},
            queueDeletionGenerations: {},
        });
    });

    test('restores captured context to its target without taking another target context', () => {
        const owner = target('session-a');
        const other = target('session-b');
        const ownerParts = [{ text: 'owner context', synthetic: true }];
        const otherParts = [{ text: 'other context', synthetic: true }];

        useInputStore.getState().setPendingSyntheticParts(ownerParts, owner);
        const consumed = consumeComposerContext(owner, null);
        useInputStore.getState().setPendingSyntheticParts(otherParts, other);

        consumed.restore();

        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toEqual(ownerParts);
        expect(useInputStore.getState().consumePendingSyntheticParts(other)).toEqual(otherParts);
    });

    test('restores a same-target failure once without duplicates', () => {
        const owner = target('session-a');
        const ownerParts = [{ text: 'owner context', synthetic: true }];
        useInputStore.getState().setPendingSyntheticParts(ownerParts, owner);

        const consumed = consumeComposerContext(owner, null);
        consumed.restore();
        consumed.restore();

        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toEqual(ownerParts);
    });

    test('does not consume context with a stale supplied restoration guard', () => {
        const owner = target('session-a');
        const ownerParts = [{ text: 'owner context', synthetic: true }];
        useInputStore.getState().setPendingSyntheticParts(ownerParts, owner);
        const staleGuard = useMessageQueueStore.getState().getQueueRestorationGuard(owner);

        useMessageQueueStore.getState().clearQueueForSessionDeletion(owner);

        const consumed = consumeComposerContext(owner, null, staleGuard);
        expect(consumed.syntheticParts).toEqual([]);
        consumed.restore();
        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toEqual(ownerParts);
    });

    test('can leave synthetic context untouched while consuming inline drafts', () => {
        const owner = target('session-a');
        const ownerDraftTarget = { directory: owner.directory, sessionKey: owner.sessionId };
        const ownerParts = [{ text: 'parent context', synthetic: true }];
        useInputStore.getState().setPendingSyntheticParts(ownerParts);
        useInlineCommentDraftStore.getState().addDraft(ownerDraftTarget, draft);

        const consumed = consumeComposerContext(null, ownerDraftTarget, undefined, { consumeSynthetic: false });

        expect(consumed.syntheticParts).toEqual([]);
        expect(consumed.inlineComments).toHaveLength(1);
        expect(useInputStore.getState().consumePendingSyntheticParts()).toEqual(ownerParts);
        expect(useInlineCommentDraftStore.getState().getDrafts(ownerDraftTarget)).toEqual([]);

        consumed.restore();

        expect(useInlineCommentDraftStore.getState().getDrafts(ownerDraftTarget)).toHaveLength(1);
    });

    test('captures inline and synthetic context independently for same-target queue items', () => {
        const owner = target('session-a');
        const ownerDraftTarget = { directory: owner.directory, sessionKey: owner.sessionId };
        useInputStore.getState().setPendingSyntheticParts([{ text: 'synthetic A', synthetic: true }]);
        useInlineCommentDraftStore.getState().addDraft(ownerDraftTarget, { ...draft, text: 'inline A' });

        const queuedA = captureComposerContextForQueue(owner, ownerDraftTarget);

        useInputStore.getState().setPendingSyntheticParts([{ text: 'synthetic B', synthetic: true }]);
        useInlineCommentDraftStore.getState().addDraft(ownerDraftTarget, { ...draft, text: 'inline B' });

        const queuedB = captureComposerContextForQueue(owner, ownerDraftTarget);

        expect(queuedA.some((part) => part.text === 'synthetic A')).toBe(true);
        expect(queuedA[0]?.text).toContain('inline A');
        expect(queuedB.some((part) => part.text === 'synthetic B')).toBe(true);
        expect(queuedB[0]?.text).toContain('inline B');
        expect(queuedA.some((part) => part.text.includes('B'))).toBe(false);
        expect(queuedB.some((part) => part.text.includes('A'))).toBe(false);
        expect(useInlineCommentDraftStore.getState().getDrafts(ownerDraftTarget)).toEqual([]);
        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toBeNull();
    });

    test('captures target-scoped synthetic context for a queued item', () => {
        const owner = target('session-a');
        const other = target('session-b');
        const ownerParts = [{ text: 'owner synthetic', synthetic: true }];
        const otherParts = [{ text: 'other synthetic', synthetic: true }];

        useInputStore.getState().setPendingSyntheticParts(ownerParts, owner);
        useInputStore.getState().setPendingSyntheticParts(otherParts, other);

        expect(captureComposerContextForQueue(owner, null)).toEqual(ownerParts);
        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toBeNull();
        expect(useInputStore.getState().consumePendingSyntheticParts(other)).toEqual(otherParts);
    });

    test('keeps a queued same-target context separate from a failed direct-send restore', () => {
        const owner = target('session-a');
        const ownerDraftTarget = { directory: owner.directory, sessionKey: owner.sessionId };

        useInputStore.getState().setPendingSyntheticParts([{ text: 'synthetic A', synthetic: true }], owner);
        useInlineCommentDraftStore.getState().addDraft(ownerDraftTarget, { ...draft, text: 'inline A' });
        const directSend = consumeComposerContext(owner, ownerDraftTarget);

        useInputStore.getState().setPendingSyntheticParts([{ text: 'synthetic B', synthetic: true }], owner);
        useInlineCommentDraftStore.getState().addDraft(ownerDraftTarget, { ...draft, text: 'inline B' });
        const queuedB = captureComposerContextForQueue(owner, ownerDraftTarget);

        directSend.restore();
        const retryA = consumeComposerContext(owner, ownerDraftTarget);

        expect(retryA.inlineComments.map((item) => item.text)).toEqual(['inline A']);
        expect(retryA.syntheticParts).toEqual([{ text: 'synthetic A', synthetic: true }]);
        expect(queuedB[0]?.text).toContain('inline B');
        expect(queuedB[1]).toEqual({ text: 'synthetic B', synthetic: true });
        expect(useInlineCommentDraftStore.getState().getDrafts(ownerDraftTarget)).toEqual([]);
        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toBeNull();
    });

    test('direct magic prompt success sends once and leaves context consumed', async () => {
        const owner = target('session-a');
        useInputStore.getState().setPendingSyntheticParts([{ text: 'magic context', synthetic: true }], owner);
        useInlineCommentDraftStore.getState().addDraft({ directory: owner.directory, sessionKey: owner.sessionId }, draft);
        const consumed = consumeComposerContext(owner, { directory: owner.directory, sessionKey: owner.sessionId });
        let sendCount = 0;
        const sentSyntheticParts: string[] = [];

        await withComposerContextRestore(consumed, async () => {
            sendCount += 1;
            sentSyntheticParts.push(...consumed.syntheticParts.map((part) => part.text));
        });

        expect(sendCount).toBe(1);
        expect(sentSyntheticParts).toEqual(['magic context']);
        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toBeNull();
        expect(useInlineCommentDraftStore.getState().getDrafts({ directory: owner.directory, sessionKey: owner.sessionId })).toEqual([]);
    });

    test('direct magic prompt failure restores synthetic and inline context once', async () => {
        const owner = target('session-a');
        const ownerParts = [{ text: 'magic context', synthetic: true }];
        const ownerDraftTarget = { directory: owner.directory, sessionKey: owner.sessionId };
        useInputStore.getState().setPendingSyntheticParts(ownerParts, owner);
        useInlineCommentDraftStore.getState().addDraft(ownerDraftTarget, draft);
        const consumed = consumeComposerContext(owner, ownerDraftTarget);

        await expect(withComposerContextRestore(consumed, async () => {
            throw new Error('send failed');
        })).rejects.toThrow('send failed');
        consumed.restore();

        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toEqual(ownerParts);
        expect(useInlineCommentDraftStore.getState().getDrafts(ownerDraftTarget)).toHaveLength(1);
    });

    test('restores captured context when an explicit remove discards a queue item', () => {
        const owner = target('session-a');
        const ownerDraftTarget = { directory: owner.directory, sessionKey: owner.sessionId };
        useInputStore.getState().setPendingSyntheticParts([{ text: 'queued synthetic', synthetic: true }]);
        useInlineCommentDraftStore.getState().addDraft(ownerDraftTarget, draft);
        const capturedContext = captureComposerContextForQueue(owner, ownerDraftTarget);
        useMessageQueueStore.setState({
            queuedMessages: {
                [getMessageQueueKey(owner)]: [{
                    id: 'queued-context',
                    content: 'queued prompt',
                    text: 'queued prompt',
                    createdAt: 1,
                    additionalParts: capturedContext,
                    capturedContext,
                    contextClaimed: true,
                }],
            },
        });
        const [queued] = useMessageQueueStore.getState().getQueueForTarget(owner);
        if (!queued) throw new Error('queue item was not created');

        removeQueuedMessageWithContextRestore(owner, queued.id);

        expect(useMessageQueueStore.getState().getQueueForTarget(owner)).toEqual([]);
        expect(useInlineCommentDraftStore.getState().getDrafts(ownerDraftTarget)).toHaveLength(1);
        expect(useInlineCommentDraftStore.getState().getDrafts(ownerDraftTarget)[0]?.text).toBe(draft.text);
        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toEqual([
            { text: 'queued synthetic', synthetic: true },
        ]);
    });

    test('restores modern queue context for its target without restoring another target', () => {
        const owner = target('session-a');
        const other = target('session-b');
        const ownerDraftTarget = { directory: owner.directory, sessionKey: owner.sessionId };
        const otherParts = [{ text: 'other target context', synthetic: true }];
        const modernContext = [
            {
                kind: 'context' as const,
                text: 'inline owner context',
                metadata: {
                    openchamberContext: {
                        kind: 'code-comment' as const,
                        source: 'diff' as const,
                        fileLabel: 'src/owner.ts',
                        startLine: 1,
                        endLine: 1,
                        language: 'ts',
                        code: 'const owner = true;',
                        text: 'owner comment',
                    },
                },
            },
            { kind: 'synthetic' as const, text: 'modern owner context' },
            { kind: 'instruction' as const, text: 'derived instruction' },
        ];

        useInputStore.getState().setPendingSyntheticParts(otherParts, other);
        useMessageQueueStore.setState({
            queuedMessages: {
                [getMessageQueueKey(owner)]: [{
                    id: 'queued-modern-context',
                    content: 'queued prompt',
                    text: 'queued prompt',
                    createdAt: 1,
                    context: modernContext,
                }],
            },
        });

        removeQueuedMessageWithContextRestore(owner, 'queued-modern-context');

        expect(useInlineCommentDraftStore.getState().getDrafts(ownerDraftTarget)).toHaveLength(1);
        expect(useInlineCommentDraftStore.getState().getDrafts(ownerDraftTarget)[0]?.text).toBe('owner comment');
        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toEqual([
            { text: 'modern owner context', synthetic: true },
        ]);
        expect(useInputStore.getState().consumePendingSyntheticParts(other)).toEqual(otherParts);
    });

    test('does not restore command-generated queue instructions as composer context', () => {
        const owner = target('session-a');
        const instruction = { text: 'rendered slash instruction', synthetic: true };
        useMessageQueueStore.setState({
            queuedMessages: {
                [getMessageQueueKey(owner)]: [{
                    id: 'queued-instruction',
                    content: 'rendered slash prompt',
                    text: 'rendered slash prompt',
                    createdAt: 1,
                    additionalParts: [instruction],
                    contextClaimed: true,
                }],
            },
        });
        const [queued] = useMessageQueueStore.getState().getQueueForTarget(owner);
        if (!queued) throw new Error('queue item was not created');

        removeQueuedMessageWithContextRestore(owner, queued.id);

        expect(useInputStore.getState().consumePendingSyntheticParts(owner)).toBeNull();
    });

});
