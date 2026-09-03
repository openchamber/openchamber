import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { z } from 'zod';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { canonicalizePathIdentity, normalizePath } from '@/lib/pathNormalization';
import { readContextPart, type ContextPartMetadata } from '@/lib/messages/contextParts';

export type FollowUpBehavior = 'steer' | 'queue';

type PersistedFollowUpBehavior = FollowUpBehavior | 'immediate' | null | undefined;

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

type MainSessionSendIntent = 'composer' | 'queued';
type MainSessionSendDisposition = 'send' | 'queue' | 'preserve-queued';

type MessageQueueDispatchState = {
    head: QueuedMessage | null;
    sendingIds: string[];
};

export const resolveMainSessionSendDisposition = (input: {
    intent: MainSessionSendIntent;
    hasMainSession: boolean;
    isBtwActive: boolean;
    isBusy: boolean;
    canQueue: boolean;
    hasQueuedMessageInFlight?: boolean;
}): MainSessionSendDisposition => {
    if (!input.hasMainSession || input.isBtwActive) {
        return 'send';
    }

    // An unresolved queue send owns this target. Queue normal composer input
    // when possible; otherwise preserve it rather than allowing a different
    // input mode to merge later queue items into a direct request.
    if (input.hasQueuedMessageInFlight) {
        if (input.intent === 'queued' || !input.canQueue) return 'preserve-queued';
        return 'queue';
    }

    if (!input.isBusy || !input.canQueue) return 'send';

    return input.intent === 'queued' ? 'preserve-queued' : 'queue';
};

export const normalizeFollowUpBehavior = (
    value: PersistedFollowUpBehavior,
    legacyQueueModeEnabled?: boolean | null,
): FollowUpBehavior => {
    // Keep accepting the old values at the persistence boundary, but the
    // queue-only hotfix has no direct-send or steer behavior to select.
    void value;
    void legacyQueueModeEnabled;
    return DEFAULT_FOLLOW_UP_BEHAVIOR;
};

export interface QueuedMessage {
    id: string;
    content: string;
    attachments?: AttachedFile[];
    additionalParts?: QueuedMessagePart[];
    /** Context captured from the composer and owned by this queue item. */
    capturedContext?: QueuedMessagePart[];
    /** Context was captured when this item was queued and is stored on the item. Omitted on legacy entries. */
    contextClaimed?: boolean;
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string;
    };
}

export type QueuedMessagePart = {
    text: string;
    attachments?: AttachedFile[];
    synthetic?: boolean;
    metadata?: ContextPartMetadata;
};

export type RemovedQueueMessages = {
    target: MessageQueueTarget;
    messages: QueuedMessage[];
};

export type MessageQueueRestorationGuard = {
    target: MessageQueueTarget;
    deletionGeneration: number;
};

export type MessageQueueTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

const MAX_QUEUE_TARGETS = 50;
const MAX_MESSAGES_PER_QUEUE = 20;
const MESSAGE_QUEUE_PERSISTENCE_VERSION = 5;

export const createMessageQueueTarget = (
    sessionId: string,
    directory: string | null | undefined,
    runtimeKey: string = getRuntimeKey(),
): MessageQueueTarget | null => {
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
    return { runtimeKey, directory: normalizedDirectory, sessionId };
};

export const getMessageQueueDirectoryKey = (target: MessageQueueTarget): string =>
    `${target.runtimeKey}\n${canonicalizePathIdentity(target.directory) ?? target.directory}`;

export const getMessageQueueKey = (target: MessageQueueTarget): string =>
    `${getMessageQueueDirectoryKey(target)}\n${target.sessionId}`;

export const isQueueMessageDispatchable = (
    queue: QueuedMessage[],
    sendingIds: string[],
    messageId: string,
): boolean => sendingIds.length === 0 && queue[0]?.id === messageId;

export const isQueueMessageInFlight = (sendingIds: string[], messageId: string): boolean =>
    sendingIds.includes(messageId);

export const parseMessageQueueKey = (key: string): MessageQueueTarget | null => {
    const parts = key.split('\n');
    if (parts.length !== 3) return null;
    const [runtimeKey, directory, sessionId] = parts;
    return createMessageQueueTarget(sessionId, directory, runtimeKey);
};

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // runtime + directory + session → queue
    quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
    followUpBehavior: FollowUpBehavior;
    /**
     * Incremented when session deletion cleanup clears a target. It is
     * intentionally not persisted: it only invalidates in-flight restorations
     * in this page instance.
     */
    queueDeletionGenerations: Record<string, number>;
    /**
     * Queued messages whose send is currently awaiting the server, per target.
     *
     * A queued item is removed only after its send resolves, so between
     * dispatch and resolution it is still visible to every other reader — and
     * a composer submit merges the whole queue into its own send. Over a relay
     * that window is seconds, long enough for the same message to be delivered
     * twice. While any entry is listed here, no later entry is sendable.
     *
     * Never persisted: a restart has no in-flight sends, and a stale flag would
     * strand a queued message permanently.
     */
    sendingIds: Record<string, string[]>;
}

interface MessageQueueActions {
    addToQueue: (target: MessageQueueTarget, message: Omit<QueuedMessage, 'id' | 'createdAt'>) => void;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => void;
    popToInput: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    clearQueue: (target: MessageQueueTarget) => QueuedMessage[];
    clearAllQueues: () => RemovedQueueMessages[];
    restoreQueue: (target: MessageQueueTarget, messages: QueuedMessage[], guard: MessageQueueRestorationGuard) => void;
    getQueueRestorationGuard: (target: MessageQueueTarget) => MessageQueueRestorationGuard;
    isQueueRestorationGuardCurrent: (target: MessageQueueTarget, guard: MessageQueueRestorationGuard) => boolean;
    clearQueueForSessionDeletion: (target: MessageQueueTarget) => void;
    markSending: (target: MessageQueueTarget, messageId: string) => boolean;
    clearSending: (target: MessageQueueTarget, messageId: string) => void;
    completeSending: (target: MessageQueueTarget, messageId: string) => void;
    getSendableQueue: (target: MessageQueueTarget) => QueuedMessage[];
    getQueueDispatchState: (target: MessageQueueTarget) => MessageQueueDispatchState;
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

type PersistedMessageQueueState = {
    queuedMessages?: PersistedQueueMap;
    quarantinedLegacyMessages?: PersistedQueueMap;
    followUpBehavior?: PersistedFollowUpBehavior;
    queueModeEnabled?: boolean;
};

const persistedJsonValueSchema = z.json();
type PersistedJsonValue = z.infer<typeof persistedJsonValueSchema>;
type PersistedQueueMap = Record<string, PersistedJsonValue>;

// JSON turns File into an opaque object. Queue transport only reads the other
// attachment fields after hydration, so retain that serialized object shape.
const persistedFileSchema = z.custom<File>((value) => z.object({}).safeParse(value).success);
const persistedContextPartMetadataSchema = z.custom<ContextPartMetadata>((value) => {
    const metadata = z.record(z.string(), persistedJsonValueSchema).safeParse(value);
    return metadata.success
        && readContextPart({ type: 'text', metadata: metadata.data }) !== null;
});
const persistedSendConfigSchema = z.object({
    providerID: z.string(),
    modelID: z.string(),
    agent: z.string().optional(),
    variant: z.string().optional(),
}).strict();
const persistedAttachedFileSchema = z.object({
    id: z.string(),
    file: persistedFileSchema,
    dataUrl: z.string(),
    mimeType: z.string(),
    filename: z.string(),
    size: z.number().finite(),
    source: z.enum(['local', 'server', 'vscode']),
    serverPath: z.string().optional(),
    vscodePath: z.string().optional(),
    vscodeSource: z.enum(['file', 'selection']).optional(),
    sourceDocumentId: z.string().optional(),
}).strict();
const persistedQueuePartSchema: z.ZodType<QueuedMessagePart> = z.object({
    text: z.string(),
    attachments: persistedAttachedFileSchema.array().optional(),
    synthetic: z.boolean().optional(),
    metadata: persistedContextPartMetadataSchema.optional(),
}).strict();
const persistedQueuedMessageSchema: z.ZodType<QueuedMessage> = z.object({
    id: z.string().min(1),
    content: z.string(),
    attachments: persistedAttachedFileSchema.array().optional(),
    additionalParts: persistedQueuePartSchema.array().optional(),
    capturedContext: persistedQueuePartSchema.array().optional(),
    contextClaimed: z.boolean().optional(),
    createdAt: z.number().finite(),
    sendConfig: persistedSendConfigSchema.optional(),
}).strict();
const persistedQueueSchema = persistedJsonValueSchema.array();
const persistedJsonRecordSchema = z.record(z.string(), persistedJsonValueSchema);
const persistedQueueMapSchema = z.record(z.string(), persistedJsonValueSchema);
type PersistedJsonRecord = z.infer<typeof persistedJsonRecordSchema>;
const persistedFollowUpBehaviorSchema = z.enum(['steer', 'queue', 'immediate']).nullable();

const parsePersistedMessageQueueState = (value: PersistedJsonRecord): PersistedMessageQueueState => {
    const queuedMessages = persistedQueueMapSchema.safeParse(value.queuedMessages);
    const quarantinedLegacyMessages = persistedQueueMapSchema.safeParse(value.quarantinedLegacyMessages);
    const followUpBehavior = persistedFollowUpBehaviorSchema.safeParse(value.followUpBehavior);
    const queueModeEnabled = z.boolean().safeParse(value.queueModeEnabled);
    return {
        queuedMessages: queuedMessages.success ? queuedMessages.data : undefined,
        quarantinedLegacyMessages: quarantinedLegacyMessages.success ? quarantinedLegacyMessages.data : undefined,
        followUpBehavior: followUpBehavior.success ? followUpBehavior.data : undefined,
        queueModeEnabled: queueModeEnabled.success ? queueModeEnabled.data : undefined,
    };
};

const parsePersistedQueue = (value: PersistedJsonValue): QueuedMessage[] | null => {
    const parsedQueue = persistedQueueSchema.safeParse(value);
    if (!parsedQueue.success) return null;
    const queue = parsedQueue.data.flatMap((entry) => {
        const parsedMessage = persistedQueuedMessageSchema.safeParse(entry);
        return parsedMessage.success ? [parsedMessage.data] : [];
    });
    // An array containing only malformed records is not an empty queue. Drop it
    // so invalid data cannot create an active or quarantined placeholder.
    return parsedQueue.data.length === 0 || queue.length > 0 ? queue : null;
};

const appendPersistedQueue = (queues: Map<string, QueuedMessage[]>, key: string, queue: QueuedMessage[]): void => {
    const existing = queues.get(key);
    queues.set(key, existing ? [...existing, ...queue] : queue);
};

const canonicalizePersistedQueueMap = (
    queues: PersistedQueueMap | undefined,
): Record<string, QueuedMessage[]> => {
    const canonicalQueues = new Map<string, QueuedMessage[]>();
    for (const [key, value] of Object.entries(queues ?? {})) {
        const queue = parsePersistedQueue(value);
        if (!queue) continue;
        const target = parseMessageQueueKey(key);
        const canonicalKey = target ? getMessageQueueKey(target) : key;
        appendPersistedQueue(canonicalQueues, canonicalKey, queue);
    }
    return Object.fromEntries(canonicalQueues);
};

const splitPersistedQueueMap = (
    queues: PersistedQueueMap | undefined,
) => {
    const validQueues = new Map<string, QueuedMessage[]>();
    const malformedQueues = new Map<string, QueuedMessage[]>();
    for (const [key, value] of Object.entries(queues ?? {})) {
        const queue = parsePersistedQueue(value);
        if (!queue) continue;
        const target = parseMessageQueueKey(key);
        const destination = target ? validQueues : malformedQueues;
        const destinationKey = target ? getMessageQueueKey(target) : key;
        appendPersistedQueue(destination, destinationKey, queue);
    }
    return {
        valid: Object.fromEntries(validQueues),
        malformed: Object.fromEntries(malformedQueues),
    };
};

const retainNewestQueueMessages = (queue: QueuedMessage[]): QueuedMessage[] => {
    // sendingIds are intentionally not persisted, so hydration has no in-flight
    // entries to protect. Retain the same newest FIFO tail as addToQueue.
    return queue.length > MAX_MESSAGES_PER_QUEUE ? queue.slice(-MAX_MESSAGES_PER_QUEUE) : queue;
};

export const migrateMessageQueueState = (persistedState: PersistedJsonRecord, version: number): Partial<MessageQueueStore> => {
    const state = parsePersistedMessageQueueState(persistedState);
    // v2 introduced composite keys. Re-run this normalization for every
    // pre-v5 snapshot, including v4, so aliases cannot stay stranded when
    // Zustand would otherwise skip migration for the current version.
    const persistedQueues = version < 2 ? {} : state.queuedMessages;
    const { valid: activeQueues, malformed: malformedQueues } = splitPersistedQueueMap(persistedQueues);
    const persistedQuarantine = canonicalizePersistedQueueMap(state.quarantinedLegacyMessages);
    const legacyQueues = canonicalizePersistedQueueMap(version < 2 ? state.queuedMessages : {});
    const quarantinedLegacyMessages = new Map(Object.entries(persistedQuarantine));
    for (const queues of [malformedQueues, legacyQueues]) {
        for (const [key, queue] of Object.entries(queues)) {
            appendPersistedQueue(quarantinedLegacyMessages, key, queue);
        }
    }

    return {
        queuedMessages: Object.fromEntries(
            Object.entries(activeQueues).map(([key, queue]) => [key, retainNewestQueueMessages(queue)]),
        ),
        quarantinedLegacyMessages: Object.fromEntries(quarantinedLegacyMessages),
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
                queueDeletionGenerations: {},
                sendingIds: {},

                addToQueue: (target, message) => {
                    const key = getMessageQueueKey(target);
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        content: message.content,
                        attachments: message.attachments,
                        additionalParts: message.additionalParts,
                        capturedContext: message.capturedContext,
                        contextClaimed: message.contextClaimed,
                        createdAt: Date.now(),
                        sendConfig: message.sendConfig,
                    };

                    set((state) => {
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const nextQueue = [...currentQueue, queuedMessage];
                        const sendingIds = new Set(state.sendingIds[key] ?? []);
                        const overflow = Math.max(0, nextQueue.length - MAX_MESSAGES_PER_QUEUE);
                        const droppedIds = new Set(
                            nextQueue
                                .filter((item) => !sendingIds.has(item.id))
                                .slice(0, overflow)
                                .map((item) => item.id),
                        );
                        const queuedMessages = {
                            ...state.queuedMessages,
                            [key]: nextQueue.filter((item) => !droppedIds.has(item.id)),
                        };
                        const keys = Object.keys(queuedMessages);
                        if (keys.length > MAX_QUEUE_TARGETS) {
                            keys.sort((left, right) => (
                                (queuedMessages[left]?.[0]?.createdAt ?? 0) - (queuedMessages[right]?.[0]?.createdAt ?? 0)
                            ));
                            for (const staleKey of keys.slice(0, keys.length - MAX_QUEUE_TARGETS)) delete queuedMessages[staleKey];
                        }
                        return {
                            queuedMessages,
                        };
                    });
                },

                removeFromQueue: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    let removed: QueuedMessage | null = null;
                    set((state) => {
                        if (isQueueMessageInFlight(state.sendingIds[key] ?? [], messageId)) return state;
                        const currentQueue = state.queuedMessages[key] ?? [];
                        removed = currentQueue.find((message) => message.id === messageId) ?? null;
                        if (!removed) return state;
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
                    return removed;
                },

                reorderQueue: (target, fromId, toId) => {
                    if (fromId === toId) return;
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const currentQueue = state.queuedMessages[key];
                        if (!currentQueue) return state;
                        // Keep an in-flight head ahead of every later item. A
                        // reorder during its unresolved request must not let a
                        // later item overtake it if the request fails.
                        if ((state.sendingIds[key] ?? []).length > 0) return state;
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
                    let message: QueuedMessage | null = null;
                    set((prevState) => {
                        if (isQueueMessageInFlight(prevState.sendingIds[key] ?? [], messageId)) return prevState;
                        const queue = prevState.queuedMessages[key] ?? [];
                        message = queue.find((m) => m.id === messageId) ?? null;
                        if (!message) return prevState;
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
                },

                clearQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    let removed: QueuedMessage[] = [];
                    set((state) => {
                        // Clearing drops what is still queued, never a message
                        // already handed to the server: that send will resolve
                        // and must find its entry to remove or restore.
                        const sending = state.sendingIds[key] ?? [];
                        const currentQueue = state.queuedMessages[key] ?? [];
                        removed = currentQueue.filter((message) => !sending.includes(message.id));
                        const retained = currentQueue.filter((m) => sending.includes(m.id));
                        if (retained.length > 0) {
                            return { queuedMessages: { ...state.queuedMessages, [key]: retained } };
                        }
                        const { [key]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                    return removed;
                },

                clearAllQueues: () => {
                    const removed: RemovedQueueMessages[] = [];
                    set((state) => {
                        const queuedMessages: Record<string, QueuedMessage[]> = {};
                        for (const [key, currentQueue] of Object.entries(state.queuedMessages)) {
                            const sending = state.sendingIds[key] ?? [];
                            const dropped = currentQueue.filter((message) => !sending.includes(message.id));
                            const target = parseMessageQueueKey(key);
                            if (dropped.length > 0 && target) removed.push({ target, messages: dropped });
                            const retained = currentQueue.filter((message) => sending.includes(message.id));
                            if (retained.length > 0) queuedMessages[key] = retained;
                        }
                        return { queuedMessages };
                    });
                    return removed;
                },

                getQueueRestorationGuard: (target) => {
                    const key = getMessageQueueKey(target);
                    return {
                        target: { ...target },
                        deletionGeneration: get().queueDeletionGenerations[key] ?? 0,
                    };
                },

                isQueueRestorationGuardCurrent: (target, guard) => {
                    const key = getMessageQueueKey(target);
                    return target.runtimeKey === getRuntimeKey()
                        && guard.target.runtimeKey === target.runtimeKey
                        && guard.target.sessionId === target.sessionId
                        && getMessageQueueKey(guard.target) === key
                        && (get().queueDeletionGenerations[key] ?? 0) === guard.deletionGeneration;
                },

                clearQueueForSessionDeletion: (target) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const currentGeneration = state.queueDeletionGenerations[key] ?? 0;
                        const queueDeletionGenerations = {
                            ...state.queueDeletionGenerations,
                            [key]: currentGeneration + 1,
                        };
                        const sending = state.sendingIds[key] ?? [];
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const retained = currentQueue.filter((message) => sending.includes(message.id));
                        const queuedMessages = { ...state.queuedMessages };
                        if (retained.length > 0) queuedMessages[key] = retained;
                        else delete queuedMessages[key];
                        return { queuedMessages, queueDeletionGenerations };
                    });
                },

                restoreQueue: (target, messages, guard) => {
                    if (messages.length === 0) return;
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        if (
                            target.runtimeKey !== getRuntimeKey()
                            || guard.target.runtimeKey !== target.runtimeKey
                            || guard.target.sessionId !== target.sessionId
                            || getMessageQueueKey(guard.target) !== key
                            || (state.queueDeletionGenerations[key] ?? 0) !== guard.deletionGeneration
                        ) return state;
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const existingIds = new Set(currentQueue.map((message) => message.id));
                        const restored = messages.filter((message) => !existingIds.has(message.id));
                        if (restored.length === 0) return state;

                        // In-flight entries remain at the front. Build the same
                        // FIFO order addToQueue would have produced, then drop
                        // the oldest non-in-flight entries on overflow. This
                        // lets newer additions win over older restored items.
                        const sending = new Set(state.sendingIds[key] ?? []);
                        const inFlight = currentQueue.filter((message) => sending.has(message.id));
                        const later = currentQueue.filter((message) => !sending.has(message.id));
                        const combinedQueue = [...inFlight, ...restored, ...later];
                        const overflow = Math.max(0, combinedQueue.length - MAX_MESSAGES_PER_QUEUE);
                        const droppedIds = new Set(
                            combinedQueue
                                .filter((message) => !sending.has(message.id))
                                .slice(0, overflow)
                                .map((message) => message.id),
                        );
                        const boundedQueue = combinedQueue.filter((message) => !droppedIds.has(message.id));
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: boundedQueue,
                            },
                        };
                    });
                },

                markSending: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    let claimed = false;
                    set((state) => {
                        const current = state.sendingIds[key] ?? [];
                        const queue = state.queuedMessages[key] ?? [];
                        if (!isQueueMessageDispatchable(queue, current, messageId)) return state;
                        claimed = true;
                        return { sendingIds: { ...state.sendingIds, [key]: [...current, messageId] } };
                    });
                    return claimed;
                },

                clearSending: (target, messageId) => {
                    const key = getMessageQueueKey(target);
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
                },

                completeSending: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const currentSending = state.sendingIds[key] ?? [];
                        if (!isQueueMessageInFlight(currentSending, messageId)) return state;

                        const currentQueue = state.queuedMessages[key] ?? [];
                        const nextQueue = currentQueue.filter((message) => message.id !== messageId);
                        const nextSending = currentSending.filter((id) => id !== messageId);
                        const queuedMessages = { ...state.queuedMessages };
                        const sendingIds = { ...state.sendingIds };

                        if (nextQueue.length === 0) delete queuedMessages[key];
                        else queuedMessages[key] = nextQueue;
                        if (nextSending.length === 0) delete sendingIds[key];
                        else sendingIds[key] = nextSending;

                        return { queuedMessages, sendingIds };
                    });
                },

                getSendableQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    const queue = state.queuedMessages[key] ?? [];
                    const sending = state.sendingIds[key];
                    // The in-flight head stays visible until its request
                    // resolves, so no later item is sendable in the meantime.
                    if (sending && sending.length > 0) return [];
                    return queue;
                },

                getQueueDispatchState: (target) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    return {
                        head: (state.queuedMessages[key] ?? [])[0] ?? null,
                        sendingIds: state.sendingIds[key] ?? [],
                    };
                },

                 setFollowUpBehavior: (behavior) => {
                    const normalized = normalizeFollowUpBehavior(behavior);
                    set({ followUpBehavior: normalized });
                    void updateDesktopSettings({ followUpBehavior: normalized });
                },

                getQueueForTarget: (target) => {
                    return get().queuedMessages[getMessageQueueKey(target)] ?? [];
                },
            }),
            {
                name: 'message-queue-store',
                version: MESSAGE_QUEUE_PERSISTENCE_VERSION,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    queuedMessages: state.queuedMessages,
                    quarantinedLegacyMessages: state.quarantinedLegacyMessages,
                    followUpBehavior: state.followUpBehavior,
                }),
                migrate: (persistedState, version) => {
                    const parsedState = persistedJsonRecordSchema.safeParse(persistedState);
                    return migrateMessageQueueState(
                        parsedState.success ? parsedState.data : {},
                        version,
                    );
                },
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);
