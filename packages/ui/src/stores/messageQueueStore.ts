import { create } from 'zustand';
import { createJSONStorage, devtools, persist } from 'zustand/middleware';
import { z } from 'zod';
import { getSafeStorage } from './utils/safeStorage';
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
    /** Durable identity for a send whose outcome may survive this page. */
    sendAttempt?: {
        messageID: string;
        dispatched: boolean;
    };
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string;
    };
    additionalParts?: Array<{
        text: string;
        synthetic?: boolean;
    }>;
}

export type MessageQueueTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

const MAX_QUEUE_TARGETS = 50;
const MAX_MESSAGES_PER_QUEUE = 20;
const DELETED_TARGET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGE_QUEUE_STORE_VERSION = 6;
export const MESSAGE_QUEUE_STORAGE_KEY = 'message-queue-store';
const persistedSendAttemptSchema = z.object({
    messageID: z.string().trim().min(1),
    dispatched: z.boolean(),
});
const durableQueueEnvelopeSchema = z.object({
    state: z.object({
        queuedMessages: z.record(z.string(), z.array(z.object({
            id: z.string(),
            sendAttempt: persistedSendAttemptSchema.optional(),
        }).passthrough())).optional(),
    }),
});
const queueLockTicketSchema = z.object({
    ticket: z.number().finite(),
    expiresAt: z.number().finite(),
});

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

export const selectQueuedMessagesForSubmit = (
    queue: QueuedMessage[],
    sendingIds: string[],
    hasComposerContent: boolean,
    explicitMessageId?: string,
): QueuedMessage[] => {
    if (explicitMessageId) {
        const selectedIndex = queue.findIndex((message) => message.id === explicitMessageId);
        const selected = queue[selectedIndex];
        if (!selected || sendingIds.includes(selected.id)) return [];
        const hasProtectedPredecessor = queue.slice(0, selectedIndex).some((message) => (
            message.sendAttempt !== undefined || sendingIds.includes(message.id)
        ));
        return hasProtectedPredecessor ? [] : [selected];
    }
    if (hasComposerContent) return [];
    const head = queue[0];
    if (!head || head.sendAttempt !== undefined || sendingIds.includes(head.id)) return [];
    return [head];
};

export const shouldQueueComposerSubmission = (
    queue: QueuedMessage[],
    hasComposerContent: boolean,
    queuedOnly: boolean,
    runsLocally: boolean,
    queueRequested: boolean,
): boolean => !queuedOnly && !runsLocally && hasComposerContent && (queueRequested || queue.length > 0);

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // runtime + directory + session → queue
    quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
    deletedTargets: Record<string, number>;
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
     * Never persisted: durable outcome-unknown sends live on the queued item as
     * `sendAttempt`; a stale transient flag would strand an ordinary item.
     */
    sendingIds: Record<string, string[]>;
}

interface MessageQueueActions {
    addToQueue: (target: MessageQueueTarget, message: Omit<QueuedMessage, 'id' | 'createdAt' | 'sendAttempt'>) => Promise<boolean>;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => Promise<void>;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => Promise<void>;
    popToInput: (target: MessageQueueTarget, messageId: string) => Promise<QueuedMessage | null>;
    clearQueue: (target: MessageQueueTarget) => Promise<void>;
    purgeQueue: (target: MessageQueueTarget) => Promise<void>;
    clearAllQueues: () => Promise<void>;
    markSending: (target: MessageQueueTarget, messageId: string) => Promise<boolean>;
    clearSending: (target: MessageQueueTarget, messageId: string) => Promise<void>;
    recordSendAttempt: (target: MessageQueueTarget, messageId: string, sendMessageID: string) => Promise<boolean>;
    markSendAttemptDispatched: (target: MessageQueueTarget, messageId: string, sendMessageID: string) => Promise<boolean>;
    clearSendAttempt: (target: MessageQueueTarget, messageId: string) => Promise<void>;
    getSendableQueue: (target: MessageQueueTarget) => QueuedMessage[];
    setFollowUpBehavior: (behavior: FollowUpBehavior) => Promise<void>;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, QueuedMessage[]>;
    quarantinedLegacyMessages?: Record<string, QueuedMessage[]>;
    deletedTargets?: Record<string, number>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
};

const sanitizeSendAttempts = (
    queues: Record<string, QueuedMessage[]> | undefined,
    legacyAttemptsWereDispatched: boolean,
): Record<string, QueuedMessage[]> => Object.fromEntries(
    Object.entries(queues ?? {}).map(([key, messages]) => [
        key,
        messages.map((message) => {
            if (message.sendAttempt === undefined) return message;
            const attempt = legacyAttemptsWereDispatched
                ? { ...message.sendAttempt, dispatched: true }
                : message.sendAttempt;
            const parsed = persistedSendAttemptSchema.safeParse(attempt);
            if (parsed.success) return { ...message, sendAttempt: parsed.data };
            const { sendAttempt: _removed, ...queuedMessage } = message;
            void _removed;
            return queuedMessage;
        }),
    ]),
);

const sanitizeDeletedTargets = (targets: Record<string, number> | undefined): Record<string, number> => {
    const cutoff = Date.now() - DELETED_TARGET_RETENTION_MS;
    return Object.fromEntries(
        Object.entries(targets ?? {})
            .filter(([, deletedAt]) => Number.isFinite(deletedAt) && deletedAt >= cutoff)
    );
};

const readDurableQueue = (target: MessageQueueTarget) => {
    try {
        const raw = globalThis.localStorage.getItem(MESSAGE_QUEUE_STORAGE_KEY);
        if (!raw) return null;
        const persisted = durableQueueEnvelopeSchema.safeParse(JSON.parse(raw));
        if (!persisted.success) return null;
        return persisted.data.state.queuedMessages?.[getMessageQueueKey(target)] ?? [];
    } catch {
        return null;
    }
};

const isQueuedMessageDurable = (target: MessageQueueTarget, messageId: string): boolean => (
    !globalThis.window || readDurableQueue(target)?.some((message) => message.id === messageId) === true
);

const isSendAttemptDurable = (
    target: MessageQueueTarget,
    messageId: string,
    sendMessageID: string,
): boolean => {
    if (!globalThis.window) return true;
    return readDurableQueue(target)?.some((message) => (
        message.id === messageId && message.sendAttempt?.messageID === sendMessageID
    )) === true;
};

const isDispatchedSendAttemptDurable = (
    target: MessageQueueTarget,
    messageId: string,
    sendMessageID: string,
): boolean => {
    if (!globalThis.window) return true;
    return readDurableQueue(target)?.some((message) => (
        message.id === messageId
        && message.sendAttempt?.messageID === sendMessageID
        && message.sendAttempt.dispatched
    )) === true;
};

export const migrateMessageQueueState = (persistedState: unknown, version: number): Partial<MessageQueueStore> => {
    const state = (persistedState ?? {}) as PersistedMessageQueueState;
    const legacyQueues = version < 2 ? (state.queuedMessages ?? {}) : {};
    return {
        queuedMessages: version < 2 ? {} : sanitizeSendAttempts(state.queuedMessages, version < 6),
        quarantinedLegacyMessages: sanitizeSendAttempts({
            ...(state.quarantinedLegacyMessages ?? {}),
            ...legacyQueues,
        }, version < 6),
        deletedTargets: sanitizeDeletedTargets(state.deletedTargets),
        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
    };
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => ({
                queuedMessages: {},
                quarantinedLegacyMessages: {},
                deletedTargets: {},
                followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
                sendingIds: {},

                addToQueue: async (target, message) => {
                    const key = getMessageQueueKey(target);
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        content: message.content,
                        attachments: message.attachments,
                        createdAt: Date.now(),
                        sendConfig: message.sendConfig,
                        additionalParts: message.additionalParts,
                    };

                    return withMessageQueueStateLock(() => {
                        let added = false;
                        set((state) => {
                            if (state.deletedTargets[key] !== undefined) return state;

                            const currentQueue = state.queuedMessages[key] ?? [];
                            if (currentQueue.length >= MAX_MESSAGES_PER_QUEUE) return state;
                            if (!state.queuedMessages[key] && Object.keys(state.queuedMessages).length >= MAX_QUEUE_TARGETS) return state;
                            const queuedMessages = {
                                ...state.queuedMessages,
                                [key]: [...currentQueue, queuedMessage],
                            };
                            added = true;
                            return {
                                queuedMessages,
                            };
                        });
                        if (!added || isQueuedMessageDurable(target, id)) return added;
                        set((state) => {
                            const currentQueue = state.queuedMessages[key] ?? [];
                            const nextQueue = currentQueue.filter((queued) => queued.id !== id);
                            if (nextQueue.length > 0) {
                                return { queuedMessages: { ...state.queuedMessages, [key]: nextQueue } };
                            }
                            const { [key]: _removed, ...queuedMessages } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages };
                        });
                        return false;
                    });
                },

                removeFromQueue: async (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    await withMessageQueueStateLock(() => {
                        set((state) => {
                            const currentQueue = state.queuedMessages[key] ?? [];
                            const newQueue = currentQueue.filter((m) => m.id !== messageId);

                            if (newQueue.length === 0) {
                                const { [key]: _removed, ...rest } = state.queuedMessages;
                                void _removed;
                                return { queuedMessages: rest };
                            }

                            return {
                                queuedMessages: {
                                    ...state.queuedMessages,
                                    [key]: newQueue,
                                },
                            };
                        });
                    });
                },

                reorderQueue: async (target, fromId, toId) => {
                    if (fromId === toId) return;
                    const key = getMessageQueueKey(target);
                    await withMessageQueueStateLock(() => {
                        set((state) => {
                            const currentQueue = state.queuedMessages[key];
                            if (!currentQueue) return state;
                            const fromIndex = currentQueue.findIndex((m) => m.id === fromId);
                            const toIndex = currentQueue.findIndex((m) => m.id === toId);
                            if (fromIndex === -1 || toIndex === -1) return state;
                            const sending = new Set(state.sendingIds[key] ?? []);
                            const start = Math.min(fromIndex, toIndex);
                            const end = Math.max(fromIndex, toIndex);
                            if (currentQueue.slice(start, end + 1).some((message) => (
                                message.sendAttempt !== undefined || sending.has(message.id)
                            ))) return state;

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
                    });
                },

                popToInput: async (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    return withMessageQueueStateLock(() => {
                        const state = get();
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const message = currentQueue.find((m) => m.id === messageId);
                        
                        if (
                            !message
                            || message.sendAttempt !== undefined
                            || (state.sendingIds[key] ?? []).includes(messageId)
                        ) {
                            return null;
                        }

                        set((prevState) => {
                            const queue = prevState.queuedMessages[key] ?? [];
                            const newQueue = queue.filter((m) => m.id !== messageId);

                            if (newQueue.length === 0) {
                                const { [key]: _removed, ...rest } = prevState.queuedMessages;
                                void _removed;
                                return { queuedMessages: rest };
                            }

                            return {
                                queuedMessages: {
                                    ...prevState.queuedMessages,
                                    [key]: newQueue,
                                },
                            };
                        });

                        return message;
                    });
                },

                clearQueue: async (target) => {
                    const key = getMessageQueueKey(target);
                    await withMessageQueueStateLock(() => {
                        set((state) => {
                            // Clearing drops what is still queued, never a message
                            // already handed to the server: that send will resolve
                            // and must find its entry to remove or restore.
                            const sending = state.sendingIds[key] ?? [];
                            const retained = (state.queuedMessages[key] ?? []).filter((m) => (
                                sending.includes(m.id) || m.sendAttempt !== undefined
                            ));
                            if (retained.length > 0) {
                                return { queuedMessages: { ...state.queuedMessages, [key]: retained } };
                            }
                            const { [key]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        });
                    });
                },

                purgeQueue: async (target) => {
                    const key = getMessageQueueKey(target);
                    await withMessageQueueStateLock(() => {
                        set((state) => {
                            const { [key]: _queued, ...queuedMessages } = state.queuedMessages;
                            const { [key]: _sending, ...sendingIds } = state.sendingIds;
                            void _queued;
                            void _sending;
                            return {
                                queuedMessages,
                                sendingIds,
                                deletedTargets: sanitizeDeletedTargets({
                                    ...state.deletedTargets,
                                    [key]: Date.now(),
                                }),
                            };
                        });
                    });
                },

                clearAllQueues: async () => {
                    await withMessageQueueStateLock(() => {
                        set({ queuedMessages: {}, sendingIds: {} });
                    });
                },

                markSending: async (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    return withMessageQueueStateLock(() => {
                        let marked = false;
                        set((state) => {
                            if (state.deletedTargets[key] !== undefined) return state;
                            if (!(state.queuedMessages[key] ?? []).some((message) => message.id === messageId)) return state;
                            const current = state.sendingIds[key] ?? [];
                            if (current.includes(messageId)) return state;
                            marked = true;
                            return { sendingIds: { ...state.sendingIds, [key]: [...current, messageId] } };
                        });
                        return marked;
                    });
                },

                clearSending: async (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    await withMessageQueueStateLock(() => {
                        set((state) => {
                            const current = state.sendingIds[key];
                            if (!current || !current.includes(messageId)) return state;
                            const next = current.filter((id) => id !== messageId);
                            if (next.length === 0) {
                                const { [key]: _removed, ...rest } = state.sendingIds;
                                void _removed;
                                return { sendingIds: rest };
                            }
                            return { sendingIds: { ...state.sendingIds, [key]: next } };
                        });
                    });
                },

                recordSendAttempt: async (target, messageId, sendMessageID) => {
                    const key = getMessageQueueKey(target);
                    return withMessageQueueStateLock(() => {
                        let recorded = false;
                        set((state) => {
                            if (state.deletedTargets[key] !== undefined) return state;
                            const currentQueue = state.queuedMessages[key];
                            if (!currentQueue) return state;
                            const messageIndex = currentQueue.findIndex((message) => message.id === messageId);
                            if (messageIndex === -1) return state;
                            const existingMessageID = currentQueue[messageIndex]?.sendAttempt?.messageID;
                            if (existingMessageID && existingMessageID !== sendMessageID) return state;
                            recorded = true;
                            if (existingMessageID === sendMessageID) return state;
                            const nextQueue = currentQueue.slice();
                            nextQueue[messageIndex] = {
                                ...nextQueue[messageIndex],
                                sendAttempt: { messageID: sendMessageID, dispatched: false },
                            };
                            return {
                                queuedMessages: {
                                    ...state.queuedMessages,
                                    [key]: nextQueue,
                                },
                            };
                        });
                        return recorded && isSendAttemptDurable(target, messageId, sendMessageID);
                    });
                },

                markSendAttemptDispatched: async (target, messageId, sendMessageID) => {
                    const key = getMessageQueueKey(target);
                    return withMessageQueueStateLock(() => {
                        let marked = false;
                        set((state) => {
                            if (state.deletedTargets[key] !== undefined) return state;
                            const currentQueue = state.queuedMessages[key];
                            if (!currentQueue) return state;
                            const messageIndex = currentQueue.findIndex((message) => message.id === messageId);
                            const attempt = currentQueue[messageIndex]?.sendAttempt;
                            if (!attempt || attempt.messageID !== sendMessageID) return state;
                            marked = true;
                            if (attempt.dispatched) return state;
                            const nextQueue = currentQueue.slice();
                            nextQueue[messageIndex] = {
                                ...nextQueue[messageIndex],
                                sendAttempt: { ...attempt, dispatched: true },
                            };
                            return {
                                queuedMessages: {
                                    ...state.queuedMessages,
                                    [key]: nextQueue,
                                },
                            };
                        });
                        return marked && isDispatchedSendAttemptDurable(target, messageId, sendMessageID);
                    });
                },

                clearSendAttempt: async (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    await withMessageQueueStateLock(() => {
                        set((state) => {
                            const currentQueue = state.queuedMessages[key];
                            if (!currentQueue) return state;
                            const messageIndex = currentQueue.findIndex((message) => message.id === messageId);
                            const message = currentQueue[messageIndex];
                            if (!message?.sendAttempt) return state;
                            const { sendAttempt: _removed, ...queuedMessage } = message;
                            void _removed;
                            const nextQueue = currentQueue.slice();
                            nextQueue[messageIndex] = queuedMessage;
                            return {
                                queuedMessages: {
                                    ...state.queuedMessages,
                                    [key]: nextQueue,
                                },
                            };
                        });
                    });
                },

                getSendableQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    const queue = state.queuedMessages[key] ?? [];
                    const sending = state.sendingIds[key];
                    if (!sending || sending.length === 0) return queue;
                    return queue.filter((message) => !sending.includes(message.id));
                },

                setFollowUpBehavior: async (behavior) => {
                    await withMessageQueueStateLock(() => {
                        set({ followUpBehavior: behavior });
                    });
                    void updateDesktopSettings({ followUpBehavior: behavior });
                },

                getQueueForTarget: (target) => {
                    return get().queuedMessages[getMessageQueueKey(target)] ?? [];
                },
            }),
            {
                name: MESSAGE_QUEUE_STORAGE_KEY,
                version: MESSAGE_QUEUE_STORE_VERSION,
                storage: createJSONStorage(() => getSafeStorage()),
                partialize: (state) => ({
                    queuedMessages: state.queuedMessages,
                    quarantinedLegacyMessages: state.quarantinedLegacyMessages,
                    deletedTargets: state.deletedTargets,
                    followUpBehavior: state.followUpBehavior,
                }),
                migrate: migrateMessageQueueState,
                merge: (persistedState, currentState) => ({
                    ...currentState,
                    ...migrateMessageQueueState(persistedState, MESSAGE_QUEUE_STORE_VERSION),
                }),
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);

let localQueueStateLock: Promise<void> = Promise.resolve();
const localQueueTargetLocks = new Map<string, Promise<void>>();
const queueLockOwner = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const QUEUE_LOCK_PREFIX = 'openchamber:message-queue-lock:';
const QUEUE_STATE_LOCK_EXPIRY_MS = 5000;

type QueueLockTicket = {
    ticket: number;
    expiresAt: number;
};

const getQueueLockStorage = (): Storage | null => {
    if (!globalThis.window) return null;
    try {
        return globalThis.localStorage;
    } catch {
        return null;
    }
};

const readQueueLockTickets = (
    storage: Storage,
    lockPrefix: string,
): Array<{ owner: string; value: QueueLockTicket }> => {
    const now = Date.now();
    const records: Array<{ owner: string; value: QueueLockTicket }> = [];
    for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(`${lockPrefix}ticket:`)) continue;
        const owner = key.slice(`${lockPrefix}ticket:`.length);
        try {
            const parsed = queueLockTicketSchema.safeParse(JSON.parse(storage.getItem(key) ?? ''));
            if (!parsed.success || parsed.data.expiresAt <= now) {
                storage.removeItem(key);
                continue;
            }
            records.push({ owner, value: parsed.data });
        } catch {
            storage.removeItem(key);
        }
    }
    return records;
};

const withFallbackQueueStateLock = async <Result>(
    storage: Storage,
    lockName: string,
    expiryMs: number,
    task: () => Promise<Result>,
): Promise<Result> => {
    const lockPrefix = `${QUEUE_LOCK_PREFIX}${encodeURIComponent(lockName)}:`;
    const choosingKey = `${lockPrefix}choosing:${queueLockOwner}`;
    const ticketKey = `${lockPrefix}ticket:${queueLockOwner}`;
    storage.setItem(choosingKey, String(Date.now() + expiryMs));
    const ticket = Math.max(0, ...readQueueLockTickets(storage, lockPrefix).map((record) => record.value.ticket)) + 1;
    const refreshTicket = () => {
        storage.setItem(ticketKey, JSON.stringify({ ticket, expiresAt: Date.now() + expiryMs }));
    };
    refreshTicket();
    storage.removeItem(choosingKey);
    const heartbeat = setInterval(() => {
        try {
            refreshTicket();
        } catch {
            // The current transaction still completes through safe storage.
        }
    }, Math.floor(expiryMs / 3));

    try {
        while (true) {
            const now = Date.now();
            let blocked = false;
            for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index);
                if (!key?.startsWith(`${lockPrefix}choosing:`) || key === choosingKey) continue;
                const expiresAt = Number(storage.getItem(key));
                if (Number.isFinite(expiresAt) && expiresAt > now) {
                    blocked = true;
                    break;
                }
                storage.removeItem(key);
            }
            if (!blocked) {
                blocked = readQueueLockTickets(storage, lockPrefix).some((record) => (
                    record.owner !== queueLockOwner
                    && (record.value.ticket < ticket
                        || (record.value.ticket === ticket && record.owner < queueLockOwner))
                ));
            }
            if (!blocked) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        return await task();
    } finally {
        clearInterval(heartbeat);
        try {
            storage.removeItem(choosingKey);
            storage.removeItem(ticketKey);
        } catch {
            // Expiry releases records when direct cleanup is unavailable.
        }
    }
};

const withLocalQueueStateLock = async <Result>(task: () => Promise<Result>): Promise<Result> => {
    const previous = localQueueStateLock;
    let release: () => void = () => undefined;
    localQueueStateLock = new Promise<void>((resolve) => {
        release = resolve;
    });
    await previous;
    try {
        return await task();
    } finally {
        release();
    }
};

export const withMessageQueueStateLock = async <Result>(task: () => Result | Promise<Result>): Promise<Result> => {
    const run = async () => {
        await useMessageQueueStore.persist.rehydrate();
        return task();
    };
    const lockManager = globalThis.navigator?.locks;
    if (lockManager) {
        return lockManager.request('openchamber:message-queue-state', { mode: 'exclusive' }, run);
    }

    const fallbackStorage = getQueueLockStorage();
    if (fallbackStorage) {
        return withLocalQueueStateLock(async () => {
            let taskStarted = false;
            try {
                return await withFallbackQueueStateLock(
                    fallbackStorage,
                    'state',
                    QUEUE_STATE_LOCK_EXPIRY_MS,
                    async () => {
                        taskStarted = true;
                        return run();
                    },
                );
            } catch (error) {
                if (taskStarted) throw error;
                throw new Error('Cross-document queue state lock is unavailable.', { cause: error });
            }
        });
    }
    if (globalThis.window) {
        throw new Error('Cross-document queue state lock is unavailable.');
    }
    return withLocalQueueStateLock(run);
};

export const withMessageQueueTargetLock = async (
    target: MessageQueueTarget,
    task: () => Promise<void>,
    options?: { ifAvailable?: boolean },
): Promise<boolean> => {
    const run = async () => {
        await withMessageQueueStateLock(() => undefined);
        await task();
    };
    const lockManager = globalThis.navigator?.locks;
    if (!lockManager) {
        // Timer-backed leases cannot safely guard network I/O because browser
        // suspension can stop their heartbeat. Decline queued dispatch rather
        // than allow a second document to acquire an expired live lease.
        if (globalThis.window) return false;

        const key = getMessageQueueKey(target);
        const previous = localQueueTargetLocks.get(key);
        if (previous && options?.ifAvailable) return false;

        let release: () => void = () => undefined;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        localQueueTargetLocks.set(key, current);
        await previous;
        try {
            await run();
            return true;
        } finally {
            release();
            if (localQueueTargetLocks.get(key) === current) localQueueTargetLocks.delete(key);
        }
    }

    let taskFailed = false;
    let taskError: unknown;
    let acquired: boolean;
    try {
        acquired = await lockManager.request(
            `openchamber:message-queue:${getMessageQueueKey(target)}`,
            { mode: 'exclusive', ifAvailable: options?.ifAvailable ?? false },
            async (lock) => {
                if (!lock) return false;
                try {
                    await run();
                    return true;
                } catch (error) {
                    taskFailed = true;
                    taskError = error;
                    return false;
                }
            },
        );
    } catch (error) {
        console.warn('[queue] failed to acquire message queue lock:', error);
        return false;
    }
    if (taskFailed) throw taskError;
    return acquired;
};
