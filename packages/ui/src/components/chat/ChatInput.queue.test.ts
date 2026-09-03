import { beforeEach, describe, expect, test } from 'bun:test';

import { buildQueuedAutoSendPayload } from '@/hooks/useQueuedMessageAutoSend';
import {
    createMessageQueueTarget,
    resolveMainSessionSendDisposition,
    useMessageQueueStore,
    type QueuedMessage,
} from '@/stores/messageQueueStore';
import { isAutoReviewRunActiveForTarget } from '@/stores/useAutoReviewStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

const target = createMessageQueueTarget('session-3195', '/repo', 'runtime-3195');
if (!target) {
    throw new Error('test queue target derivation failed');
}

const queueBusyComposerSubmission = (
    content: string,
    sendConfig: NonNullable<QueuedMessage['sendConfig']>,
) => {
    const disposition = resolveMainSessionSendDisposition({
        intent: 'composer',
        hasMainSession: true,
        isBtwActive: false,
        isBusy: true,
        canQueue: true,
    });

    expect(disposition).toBe('queue');
    useMessageQueueStore.getState().addToQueue(target, { content, sendConfig });

    const queued = useMessageQueueStore.getState().getQueueForTarget(target);
    expect(queued).toHaveLength(1);

    const payload = buildQueuedAutoSendPayload(queued);
    expect(payload?.primaryText).toBe(content);
    expect(payload?.sendConfig).toEqual(sendConfig);
};

describe('ChatInput busy-path queueing', () => {
    beforeEach(() => {
        useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
    });

    test('hands off preset text from a busy composer to the queued send payload', () => {
        queueBusyComposerSubmission('preset text', {
            providerID: 'provider-preset',
            modelID: 'model-preset',
            agent: 'agent-preset',
            variant: 'variant-preset',
        });
    });

    test('hands off normal text from a busy composer to the queued send payload', () => {
        queueBusyComposerSubmission('normal text', {
            providerID: 'provider-normal',
            modelID: 'model-normal',
            agent: 'agent-normal',
            variant: 'variant-normal',
        });
    });

    test('hands off dictation text from a busy composer to the queued send payload', () => {
        queueBusyComposerSubmission('dictated text', {
            providerID: 'provider-dictation',
            modelID: 'model-dictation',
            agent: 'agent-dictation',
            variant: 'variant-dictation',
        });
    });

    test('keeps a rendered magic prompt and its synthetic instructions in the queue payload', () => {
        const sendConfig = {
            providerID: 'provider-magic',
            modelID: 'model-magic',
            agent: 'agent-magic',
            variant: 'variant-magic',
        };
        useMessageQueueStore.getState().addToQueue(target, {
            content: 'rendered magic prompt',
            additionalParts: [{ text: 'rendered magic instructions', synthetic: true }],
            sendConfig,
        });

        const queued = useMessageQueueStore.getState().getQueueForTarget(target);
        const payload = buildQueuedAutoSendPayload(queued);

        expect(payload?.primaryText).toBe('rendered magic prompt');
        expect(payload?.additionalParts).toEqual([{ text: 'rendered magic instructions', synthetic: true }]);
        expect(payload?.sendConfig).toEqual(sendConfig);
    });

    test('restores a failed magic-prompt merge with its queued captured context', async () => {
        const restorationTarget = createMessageQueueTarget('session-3195', '/repo', getRuntimeKey());
        if (!restorationTarget) throw new Error('test queue target derivation failed');
        const sendConfig = {
            providerID: 'provider-magic-failure',
            modelID: 'model-magic-failure',
            agent: 'agent-magic-failure',
            variant: 'variant-magic-failure',
        };
        const capturedContext = [{ text: 'queued review context', synthetic: true }];
        useMessageQueueStore.getState().addToQueue(restorationTarget, {
            content: 'queued follow-up',
            additionalParts: [
                { text: 'rendered magic instructions', synthetic: true },
                ...capturedContext,
            ],
            capturedContext,
            contextClaimed: true,
            sendConfig,
        });

        const beforeSend = useMessageQueueStore.getState().getQueueForTarget(restorationTarget);
        const payload = buildQueuedAutoSendPayload(beforeSend);
        expect(payload?.additionalParts).toEqual([
            { text: 'rendered magic instructions', synthetic: true },
            ...capturedContext,
        ]);

        const guard = useMessageQueueStore.getState().getQueueRestorationGuard(restorationTarget);
        const removed = useMessageQueueStore.getState().clearQueue(restorationTarget);
        await expect(Promise.reject(new Error('magic send failed'))).rejects.toThrow('magic send failed');
        useMessageQueueStore.getState().restoreQueue(restorationTarget, removed, guard);

        const restored = useMessageQueueStore.getState().getQueueForTarget(restorationTarget);
        expect(restored).toEqual(beforeSend);
        expect(restored[0]?.capturedContext).toEqual(capturedContext);
    });

    test('only treats auto-review activity for the exact target as busy', () => {
        const matchingTarget = target;
        const matchingRun = {
            originalSessionID: matchingTarget.sessionId,
            directory: matchingTarget.directory,
            runtimeKey: matchingTarget.runtimeKey,
            status: 'running' as const,
        };
        const otherDirectoryRun = { ...matchingRun, directory: '/other-repo' };

        expect(isAutoReviewRunActiveForTarget(matchingRun, matchingTarget)).toBe(true);
        expect(isAutoReviewRunActiveForTarget(otherDirectoryRun, matchingTarget)).toBe(false);
        expect(resolveMainSessionSendDisposition({
            intent: 'composer',
            hasMainSession: true,
            isBtwActive: false,
            isBusy: isAutoReviewRunActiveForTarget(otherDirectoryRun, matchingTarget),
            canQueue: true,
        })).toBe('send');
        expect(resolveMainSessionSendDisposition({
            intent: 'composer',
            hasMainSession: true,
            isBtwActive: false,
            isBusy: isAutoReviewRunActiveForTarget(matchingRun, matchingTarget),
            canQueue: true,
        })).toBe('queue');
    });

    test('matches Windows directory aliases but keeps POSIX paths case-sensitive', () => {
        const run = (directory: string, sessionId = target.sessionId) => ({
            originalSessionID: sessionId,
            directory,
            runtimeKey: target.runtimeKey,
            status: 'running' as const,
        });

        expect(isAutoReviewRunActiveForTarget(
            run('C:/Repo'),
            { ...target, directory: 'c:\\repo' },
        )).toBe(true);
        expect(isAutoReviewRunActiveForTarget(
            run('//Server/Share/Repo'),
            { ...target, directory: '\\\\server\\share\\repo' },
        )).toBe(true);
        expect(isAutoReviewRunActiveForTarget(
            run('/Repo'),
            { ...target, directory: '/repo' },
        )).toBe(false);
        expect(isAutoReviewRunActiveForTarget(
            run('C:/Repo', 'other-session'),
            { ...target, directory: 'c:/repo' },
        )).toBe(false);
    });
});
