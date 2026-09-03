import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';

export type FollowUpBehavior = 'steer' | 'queue';

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

export const isFollowUpBehavior = (value: unknown): value is FollowUpBehavior => (
    value === 'steer' || value === 'queue'
);

export const normalizeFollowUpBehavior = (
    value: unknown,
    legacyQueueModeEnabled?: boolean | null,
): FollowUpBehavior => {
    // "immediate" was removed: on a busy session it was wire-identical to
    // "steer" (OpenCode only supports delivery "steer" | "queue", defaulting
    // to "steer"), so collapse any persisted/legacy "immediate" onto "steer".
    if (value === 'immediate') {
        return 'steer';
    }

    if (isFollowUpBehavior(value)) {
        return value;
    }

    if (legacyQueueModeEnabled === false) {
        return 'steer';
    }

    if (legacyQueueModeEnabled === true) {
        return 'queue';
    }

    return DEFAULT_FOLLOW_UP_BEHAVIOR;
};

export interface QueuedMessage {
    id: string;
    content: string;
    attachments?: AttachedFile[];
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string;
    };
}

export type MessageQueueTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

interface MessageQueueClaim {
    messages: QueuedMessage[];
    acknowledge: () => void;
    release: () => void;
}

const MAX_QUEUE_TARGETS = 50;
const MAX_MESSAGES_PER_QUEUE = 20;

const withNonEmptyEntry = <T>(
    record: Record<string, T[]>,
    key: string,
    values: T[],
) => {
    const next = { ...record };
    if (values.length > 0) next[key] = values;
    else delete next[key];
    return next;
};

export const createMessageQueueTarget = (
    sessionId: string,
    directory: string | null | undefined,
    runtimeKey: string = getRuntimeKey(),
): MessageQueueTarget | null => {
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
    return { runtimeKey, directory: normalizedDirectory, sessionId };
};

export const getMessageQueueKey = (target: MessageQueueTarget): string =>
    `${target.runtimeKey}\n${target.directory}\n${target.sessionId}`;

export const parseMessageQueueKey = (key: string): MessageQueueTarget | null => {
    const [runtimeKey, directory, ...sessionParts] = key.split('\n');
    return createMessageQueueTarget(sessionParts.join('\n'), directory, runtimeKey);
};

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // runtime + directory + session → queue
    quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
    followUpBehavior: FollowUpBehavior;
    /**
     * Queued messages whose send is currently awaiting the server, per target.
     *
     * A queued item is removed only after its send resolves, so between
     * dispatch and resolution it is still visible to every other reader — and
     * a composer submit merges the whole queue into its own send. Over a relay
     * that window is seconds, long enough for the same message to be delivered
     * twice. Dispatchers must skip entries listed here.
     *
     * Never persisted: a restart has no in-flight sends, and a stale flag would
     * strand a queued message permanently.
     */
    sendingIds: Record<string, string[]>;
}

interface MessageQueueActions {
    addToQueue: (target: MessageQueueTarget, message: Omit<QueuedMessage, 'id' | 'createdAt'>) => void;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => void;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => void;
    popToInput: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    clearQueue: (target: MessageQueueTarget) => void;
    clearAllQueues: () => void;
    claimForSend: (target: MessageQueueTarget, messageIds?: readonly string[]) => MessageQueueClaim | null;
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, QueuedMessage[]>;
    quarantinedLegacyMessages?: Record<string, QueuedMessage[]>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
};

export const migrateMessageQueueState = (persistedState: unknown, version: number): Partial<MessageQueueStore> => {
    const state = (persistedState ?? {}) as PersistedMessageQueueState;
    const legacyQueues = version < 2 ? (state.queuedMessages ?? {}) : {};
    return {
        queuedMessages: version < 2 ? {} : (state.queuedMessages ?? {}),
        quarantinedLegacyMessages: {
            ...(state.quarantinedLegacyMessages ?? {}),
            ...legacyQueues,
        },
        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
    };
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => ({
                queuedMessages: {},
                quarantinedLegacyMessages: {},
                followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
                sendingIds: {},

                addToQueue: (target, message) => {
                    const key = getMessageQueueKey(target);
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        content: message.content,
                        attachments: message.attachments,
                        createdAt: Date.now(),
                        sendConfig: message.sendConfig,
                    };

                    set((state) => {
                        const currentQueue = state.queuedMessages[key] ?? [];
                        let excessMessages = Math.max(0, currentQueue.length + 1 - MAX_MESSAGES_PER_QUEUE);
                        const sending = new Set(state.sendingIds[key] ?? []);
                        const retainedQueue = currentQueue.filter((item) => {
                            if (excessMessages === 0 || sending.has(item.id)) return true;
                            excessMessages -= 1;
                            return false;
                        });
                        const queuedMessages = {
                            ...state.queuedMessages,
                            [key]: [...retainedQueue, queuedMessage],
                        };
                        const keys = Object.keys(queuedMessages);
                        if (keys.length > MAX_QUEUE_TARGETS) {
                            const removableKeys = keys
                                .filter((candidate) => candidate !== key && !state.sendingIds[candidate]?.length)
                                .sort((left, right) => (
                                    (queuedMessages[left]?.[0]?.createdAt ?? 0) - (queuedMessages[right]?.[0]?.createdAt ?? 0)
                                ));
                            for (const staleKey of removableKeys.slice(0, keys.length - MAX_QUEUE_TARGETS)) {
                                delete queuedMessages[staleKey];
                            }
                        }
                        return {
                            queuedMessages,
                        };
                    });
                },

                removeFromQueue: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        if (state.sendingIds[key]?.includes(messageId)) return state;
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const newQueue = currentQueue.filter((m) => m.id !== messageId);
                        return { queuedMessages: withNonEmptyEntry(state.queuedMessages, key, newQueue) };
                    });
                },

                reorderQueue: (target, fromId, toId) => {
                    if (fromId === toId) return;
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const currentQueue = state.queuedMessages[key];
                        if (!currentQueue) return state;
                        const sending = state.sendingIds[key];
                        if (sending?.includes(fromId) || sending?.includes(toId)) return state;
                        const fromIndex = currentQueue.findIndex((m) => m.id === fromId);
                        const toIndex = currentQueue.findIndex((m) => m.id === toId);
                        if (fromIndex === -1 || toIndex === -1) return state;

                        const newQueue = currentQueue.slice();
                        const [moved] = newQueue.splice(fromIndex, 1);
                        newQueue.splice(toIndex, 0, moved);

                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: newQueue,
                            },
                        };
                    });
                },

                popToInput: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    const currentQueue = state.queuedMessages[key] ?? [];
                    const message = currentQueue.find((m) => m.id === messageId);
                    if (!message || state.sendingIds[key]?.includes(messageId)) {
                        return null;
                    }

                    // Remove from queue
                    set((prevState) => {
                        const queue = prevState.queuedMessages[key] ?? [];
                        const newQueue = queue.filter((m) => m.id !== messageId);
                        return { queuedMessages: withNonEmptyEntry(prevState.queuedMessages, key, newQueue) };
                    });

                    return message;
                },

                clearQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        // Clearing drops what is still queued, never a message
                        // already handed to the server: that send will resolve
                        // and must find its entry to remove or restore.
                        const sending = state.sendingIds[key] ?? [];
                        const retained = (state.queuedMessages[key] ?? []).filter((m) => sending.includes(m.id));
                        return { queuedMessages: withNonEmptyEntry(state.queuedMessages, key, retained) };
                    });
                },

                clearAllQueues: () => {
                    set((state) => {
                        const queuedMessages = Object.fromEntries(
                            Object.entries(state.queuedMessages).flatMap(([key, queue]) => {
                                const sending = state.sendingIds[key] ?? [];
                                const retained = queue.filter((message) => sending.includes(message.id));
                                return retained.length > 0 ? [[key, retained]] : [];
                            }),
                        );
                        return { queuedMessages };
                    });
                },

                claimForSend: (target, messageIds) => {
                    const key = getMessageQueueKey(target);
                    const requested = messageIds ? new Set(messageIds) : null;
                    let messages: QueuedMessage[] = [];
                    set((state) => {
                        const sending = new Set(state.sendingIds[key] ?? []);
                        messages = (state.queuedMessages[key] ?? []).filter((message) => (
                            !sending.has(message.id) && (!requested || requested.has(message.id))
                        ));
                        if (messages.length === 0) return state;
                        return {
                            sendingIds: {
                                ...state.sendingIds,
                                [key]: [...sending, ...messages.map((message) => message.id)],
                            },
                        };
                    });
                    if (messages.length === 0) return null;

                    const claimedIds = new Set(messages.map((message) => message.id));
                    let settled = false;
                    const settle = (acknowledged: boolean) => {
                        if (settled) return;
                        settled = true;
                        set((state) => {
                            const sending = (state.sendingIds[key] ?? []).filter((id) => !claimedIds.has(id));
                            const queue = acknowledged
                                ? (state.queuedMessages[key] ?? []).filter((message) => !claimedIds.has(message.id))
                                : state.queuedMessages[key] ?? [];
                            return {
                                sendingIds: withNonEmptyEntry(state.sendingIds, key, sending),
                                queuedMessages: withNonEmptyEntry(state.queuedMessages, key, queue),
                            };
                        });
                    };
                    return {
                        messages,
                        acknowledge: () => settle(true),
                        release: () => settle(false),
                    };
                },

                setFollowUpBehavior: (behavior) => {
                    set({ followUpBehavior: behavior });
                    void updateDesktopSettings({ followUpBehavior: behavior });
                },

                getQueueForTarget: (target) => {
                    return get().queuedMessages[getMessageQueueKey(target)] ?? [];
                },
            }),
            {
                name: 'message-queue-store',
                version: 2,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    queuedMessages: state.queuedMessages,
                    quarantinedLegacyMessages: state.quarantinedLegacyMessages,
                    followUpBehavior: state.followUpBehavior,
                }),
                migrate: migrateMessageQueueState,
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);
