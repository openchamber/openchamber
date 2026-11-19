import type { useComposerSessionScope } from './useComposerSessionScope';
import React from 'react';
import { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';

const EMPTY_QUEUE: QueuedMessage[] = [];

type Dependencies = {
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionDirectoryForSync' | 'currentDirectory' | 'currentSessionId' | 'activeRuntimeKey' | 'isBtwActive'>;
};

type ComposerQueueState = Pick<ReturnType<typeof useMessageQueueStore.getState>,
    'addToQueue' | 'takeForSend' | 'followUpBehavior'> & {
    popQueuedToInput: ReturnType<typeof useMessageQueueStore.getState>['popToInput'];
    queuedMessages: QueuedMessage[];
    messageQueueTarget: ReturnType<typeof createMessageQueueTarget> | null;
    parentMessageQueueTarget: ReturnType<typeof createMessageQueueTarget> | null;
};

export function useComposerQueueState({
    sessionScope,
}: Dependencies): ComposerQueueState {
    const {
        currentSessionDirectoryForSync, currentDirectory, currentSessionId, activeRuntimeKey,
        isBtwActive,
    } = sessionScope;

    const messageQueueDirectory = currentSessionDirectoryForSync ?? currentDirectory;

    const parentMessageQueueTarget = React.useMemo(() => (currentSessionId
        ? createMessageQueueTarget(currentSessionId, messageQueueDirectory, activeRuntimeKey)
        : null), [activeRuntimeKey, currentSessionId, messageQueueDirectory]);

    const parentMessageQueueKey = parentMessageQueueTarget ? getMessageQueueKey(parentMessageQueueTarget) : null;

    const messageQueueTarget = !isBtwActive ? parentMessageQueueTarget : null;

    const messageQueueKey = !isBtwActive ? parentMessageQueueKey : null;

    const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);

    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!messageQueueKey) return EMPTY_QUEUE;
                return state.queuedMessages[messageQueueKey] ?? EMPTY_QUEUE;
            },
            [messageQueueKey]
        )
    );

    const addToQueue = useMessageQueueStore((state) => state.addToQueue);

    const takeForSend = useMessageQueueStore((state) => state.takeForSend);

    const popQueuedToInput = useMessageQueueStore((state) => state.popToInput);

    return {
        queuedMessages, messageQueueTarget, addToQueue, popQueuedToInput, takeForSend, followUpBehavior,
        parentMessageQueueTarget,
    };
}
