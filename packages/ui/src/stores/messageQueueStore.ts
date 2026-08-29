import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import type { ContextPart } from '@/lib/messages/contextParts';

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
    /** Structured context captured when this item was queued. */
    contextParts?: ContextPart[];
    createdAt: number;
    /** Ownership of this item. Only local items may be sent by the client. */
    admissionState?: 'local' | 'pending-admission' | 'admitted' | 'admission-failed' | 'admission-unknown';
    /** Stable id supplied to the v2 admission endpoint. */
    clientMessageId?: string;
    /** Minimal server acknowledgement retained as server proof/metadata. */
    admissionAck?: {
        admittedSeq: number;
        timeCreated: number;
        promotedSeq?: number;
    };
    /** Latest durable ordering proof used to reject stale replay/live races. */
    durableSeq?: number;
    promptedSeq?: number;
    /** Names/count from server-owned attachments; never treated as resendable. */
    remoteAttachmentNames?: string[];
    remoteAttachmentCount?: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string;
    };
}

export type DurableQueueAdmission = {
    id: string;
    sessionID: string;
    admittedSeq?: number;
    timeCreated?: number;
    prompt?: { text?: string; files?: Array<{ uri: string; name?: string }>; parts?: ContextPart[] };
    durableSeq?: number;
};

export type MessageQueueTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

const MAX_QUEUE_TARGETS = 50;
const MAX_MESSAGES_PER_QUEUE = 20;
const MAX_ADMITTED_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ADMITTED_HISTORY = 20;
const MAX_PENDING_ADMISSIONS = 20;

const capQueueMessages = (messages: QueuedMessage[]): QueuedMessage[] => {
    const admittedCandidates = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.admissionState === 'admitted')
        .filter(({ message }) => Date.now() - message.createdAt < MAX_ADMITTED_AGE_MS);
    const pendingCandidates = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.admissionState === 'pending-admission');
    const recoverableCandidates = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.admissionState !== 'admitted' && message.admissionState !== 'pending-admission')
        .slice(-MAX_MESSAGES_PER_QUEUE);
    const retained = new Map<number, QueuedMessage>();
    for (const { message, index } of admittedCandidates.slice(-MAX_ADMITTED_HISTORY)) {
        retained.set(index, {
            ...message,
            // Admission is authoritative regardless of which ordering proof
            // the event carried. Never persist resendable payloads for it.
            attachments: undefined,
            sendConfig: undefined,
        });
    }
    for (const { message, index } of pendingCandidates.slice(-MAX_PENDING_ADMISSIONS)) retained.set(index, message);
    for (const { message, index } of recoverableCandidates) retained.set(index, message);
    return messages.flatMap((_, index) => {
        const message = retained.get(index);
        return message ? [message] : [];
    });
};

/** Hydrate persisted state conservatively: an interrupted admission is unknown. */
export const normalizePersistedQueueMessages = (
    queuedMessages: Record<string, QueuedMessage[]>,
): Record<string, QueuedMessage[]> => {
    const normalized: Record<string, QueuedMessage[]> = {};
    for (const [key, messages] of Object.entries(queuedMessages)) {
        const hydrated = messages.map((message): QueuedMessage => {
                const interrupted = message.admissionState === 'pending-admission';
                return {
                    ...message,
                    // An interrupted admission is intentionally copy/dismiss
                    // only, but its attachments are still the user's only
                    // recoverable copy. Keep them until the user chooses what
                    // to do; capQueueMessages strips them for admitted history.
                    admissionState: interrupted ? 'admission-unknown' : (message.admissionState ?? 'local'),
                };
            });
        normalized[key] = capQueueMessages(hydrated);
    }
    return normalized;
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
    durableTombstones: Record<string, Record<string, number>>;
}

interface MessageQueueActions {
    addToQueue: (target: MessageQueueTarget, message: Omit<QueuedMessage, 'id' | 'createdAt'>) => string;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => void;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => void;
    popToInput: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    clearQueue: (target: MessageQueueTarget) => void;
    clearAllQueues: () => void;
    markSending: (target: MessageQueueTarget, messageId: string) => void;
    clearSending: (target: MessageQueueTarget, messageId: string) => void;
    getSendableQueue: (target: MessageQueueTarget) => QueuedMessage[];
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
    markAdmissionPending: (target: MessageQueueTarget, messageId: string, clientMessageId: string) => void;
    markAdmissionLocal: (target: MessageQueueTarget, messageId: string) => void;
    markAdmissionAdmitted: (target: MessageQueueTarget, messageId: string, ack: QueuedMessage['admissionAck']) => void;
    markAdmissionFailed: (target: MessageQueueTarget, messageId: string) => void;
    markAdmissionUnknown: (target: MessageQueueTarget, messageId: string) => void;
    hardDeleteQueue: (target: MessageQueueTarget) => void;
    recoverAdmissionToInput: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    dismissAdmissionUnknown: (target: MessageQueueTarget, messageId: string) => void;
    upsertDurableAdmission: (target: MessageQueueTarget, admission: DurableQueueAdmission) => void;
    removeDurableAdmission: (target: MessageQueueTarget, clientMessageId: string, promptedSeq?: number) => void;
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, QueuedMessage[]>;
    quarantinedLegacyMessages?: Record<string, QueuedMessage[]>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
    durableTombstones?: Record<string, Record<string, number>>;
};

export const migrateMessageQueueState = (persistedState: unknown, version: number): Partial<MessageQueueStore> => {
    const state = (persistedState ?? {}) as PersistedMessageQueueState;
    const legacyQueues = version < 2 ? (state.queuedMessages ?? {}) : {};
    return {
        queuedMessages: version < 2 ? {} : Object.fromEntries(Object.entries(state.queuedMessages ?? {}).map(([key, messages]) => [
            key,
            normalizePersistedQueueMessages({ [key]: messages })[key] ?? [],
        ])),
        quarantinedLegacyMessages: {
            ...(state.quarantinedLegacyMessages ?? {}),
            ...legacyQueues,
        },
        durableTombstones: state.durableTombstones ?? {},
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
                durableTombstones: {},

                addToQueue: (target, message) => {
                    const key = getMessageQueueKey(target);
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        content: message.content,
                        attachments: message.attachments,
                        createdAt: Date.now(),
                        admissionState: message.admissionState ?? 'local',
                        clientMessageId: message.clientMessageId,
                        admissionAck: message.admissionAck,
                        contextParts: message.contextParts,
                        durableSeq: message.durableSeq,
                        promptedSeq: message.promptedSeq,
                        remoteAttachmentNames: message.remoteAttachmentNames,
                        remoteAttachmentCount: message.remoteAttachmentCount,
                        sendConfig: message.sendConfig,
                    };

                    set((state) => {
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const candidateQueue = [...currentQueue, queuedMessage];
                        const admitted = candidateQueue.filter((item) => item.admissionState === 'admitted');
                        const pending = candidateQueue.filter((item) => item.admissionState === 'pending-admission');
                        const recoverable = candidateQueue.filter((item) => item.admissionState !== 'admitted' && item.admissionState !== 'pending-admission');
                        const retained = new Set([
                            ...recoverable.slice(-MAX_MESSAGES_PER_QUEUE),
                            ...pending.slice(-MAX_PENDING_ADMISSIONS),
                            ...admitted.slice(-MAX_ADMITTED_HISTORY),
                        ]);
                        const queuedMessages = {
                            ...state.queuedMessages,
                            // Server-owned history has its own bound. It must not
                            // consume slots needed by recoverable local content.
                            // Keep the surviving entries in their existing queue
                            // order. Partitioning by ownership changes execution
                            // order when local and server-owned entries are mixed.
                            [key]: candidateQueue.filter((item) => retained.has(item)),
                        };
                        const keys = Object.keys(queuedMessages);
                        if (keys.length > MAX_QUEUE_TARGETS) {
                            const evictionCandidates = keys.filter((candidate) => candidate !== key);
                            evictionCandidates.sort((left, right) => {
                                const leftHasLocal = queuedMessages[left]?.some((item) => (item.admissionState ?? 'local') === 'local') ?? false;
                                const rightHasLocal = queuedMessages[right]?.some((item) => (item.admissionState ?? 'local') === 'local') ?? false;
                                if (leftHasLocal !== rightHasLocal) return leftHasLocal ? 1 : -1;
                                return (queuedMessages[left]?.[0]?.createdAt ?? 0) - (queuedMessages[right]?.[0]?.createdAt ?? 0);
                            });
                            for (const staleKey of evictionCandidates.slice(0, keys.length - MAX_QUEUE_TARGETS)) delete queuedMessages[staleKey];
                        }
                        return {
                            queuedMessages,
                        };
                    });
                    return id;
                },

                removeFromQueue: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const currentQueue = state.queuedMessages[key] ?? [];
                        // Server-owned items are irreversible from the client.
                        if (currentQueue.some((message) => message.id === messageId && (message.admissionState ?? 'local') !== 'local')) return state;
                        const newQueue = currentQueue.filter((m) => m.id !== messageId || (m.admissionState ?? 'local') !== 'local');
                        
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
                },

                reorderQueue: (target, fromId, toId) => {
                    if (fromId === toId) return;
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const currentQueue = state.queuedMessages[key];
                        if (!currentQueue) return state;
                        const fromIndex = currentQueue.findIndex((m) => m.id === fromId);
                        const toIndex = currentQueue.findIndex((m) => m.id === toId);
                        if (fromIndex === -1 || toIndex === -1) return state;
                        if ((currentQueue[fromIndex].admissionState ?? 'local') !== 'local'
                            || (currentQueue[toIndex].admissionState ?? 'local') !== 'local') return state;

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
                    
                    if (!message || (message.admissionState ?? 'local') !== 'local') {
                        return null;
                    }

                    // Remove from queue
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
                },

                clearQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        // Clearing drops what is still queued, never a message
                        // already handed to the server: that send will resolve
                        // and must find its entry to remove or restore.
                        const sending = state.sendingIds[key] ?? [];
                        const retained = (state.queuedMessages[key] ?? []).filter((m) =>
                            sending.includes(m.id) || (m.admissionState ?? 'local') !== 'local'
                        );
                        if (retained.length > 0) {
                            return { queuedMessages: { ...state.queuedMessages, [key]: retained } };
                        }
                        const { [key]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                },

                clearAllQueues: () => {
                    set({ queuedMessages: {}, sendingIds: {}, durableTombstones: {} });
                },

                markSending: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.sendingIds[key] ?? [];
                        if (current.includes(messageId)) return state;
                        return { sendingIds: { ...state.sendingIds, [key]: [...current, messageId] } };
                    });
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

                getSendableQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    const queue = state.queuedMessages[key] ?? [];
                    const sending = state.sendingIds[key];
                    return queue.filter((message) => !(sending ?? []).includes(message.id)
                        && (message.admissionState ?? 'local') === 'local');
                },

                setFollowUpBehavior: (behavior) => {
                    set({ followUpBehavior: behavior });
                    void updateDesktopSettings({ followUpBehavior: behavior });
                },

                getQueueForTarget: (target) => {
                    return get().queuedMessages[getMessageQueueKey(target)] ?? [];
                },
                markAdmissionPending: (target, messageId, clientMessageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.queuedMessages[key];
                        if (!current) return state;
                        return { queuedMessages: { ...state.queuedMessages, [key]: capQueueMessages(current.map((message) => message.id === messageId && message.admissionState !== 'admitted' ? { ...message, admissionState: 'pending-admission' as const, clientMessageId } : message)) } };
                    });
                },
                markAdmissionLocal: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.queuedMessages[key];
                        if (!current) return state;
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: capQueueMessages(current.map((message) => message.id === messageId && message.admissionState !== 'admitted'
                                    ? { ...message, admissionState: 'local' as const }
                                    : message)),
                            },
                        };
                    });
                },
                markAdmissionAdmitted: (target, messageId, admissionAck) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.queuedMessages[key];
                        if (!current) return state;
                        const updated = current.map((message) => message.id === messageId
                            && message.durableSeq === undefined
                            && (message.admissionAck?.admittedSeq ?? -1) <= (admissionAck?.admittedSeq ?? -1)
                            ? { ...message, admissionState: 'admitted' as const, admissionAck, durableSeq: admissionAck?.admittedSeq, attachments: undefined, sendConfig: undefined }
                            : message);
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: capQueueMessages(updated),
                            },
                        };
                    });
                },
                markAdmissionFailed: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.queuedMessages[key];
                        if (!current) return state;
                        return { queuedMessages: { ...state.queuedMessages, [key]: capQueueMessages(current.map((message) => message.id === messageId && message.admissionState !== 'admitted' ? { ...message, admissionState: 'admission-failed' as const } : message)) } };
                    });
                },
                markAdmissionUnknown: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.queuedMessages[key];
                        if (!current) return state;
                        return { queuedMessages: { ...state.queuedMessages, [key]: capQueueMessages(current.map((message) => message.id === messageId && message.admissionState !== 'admitted' ? { ...message, admissionState: 'admission-unknown' as const, sendConfig: undefined } : message)) } };
                    });
                },
                recoverAdmissionToInput: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    const message = get().queuedMessages[key]?.find((item) => item.id === messageId);
                    if (!message || (message.admissionState !== 'admission-failed' && message.admissionState !== 'admission-unknown')) return null;
                    set((state) => {
                        const remaining = (state.queuedMessages[key] ?? []).filter((item) => item.id !== messageId);
                        if (remaining.length === 0) {
                            const { [key]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        return { queuedMessages: { ...state.queuedMessages, [key]: remaining } };
                    });
                    return message;
                },
                dismissAdmissionUnknown: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const remaining = (state.queuedMessages[key] ?? []).filter((item) =>
                            item.id !== messageId || item.admissionState !== 'admission-unknown');
                        if (remaining.length === 0) {
                            const { [key]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        return { queuedMessages: { ...state.queuedMessages, [key]: remaining } };
                    });
                },
                upsertDurableAdmission: (target, admission) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.queuedMessages[key] ?? [];
                        const tombstone = state.durableTombstones[key]?.[admission.id];
                        if (tombstone !== undefined && (admission.durableSeq ?? 0) <= tombstone) return state;
                        const existing = current.find((message) => message.clientMessageId === admission.id);
                        if (existing?.durableSeq !== undefined && (admission.durableSeq ?? 0) < existing.durableSeq) return state;
                        const content = admission.prompt?.text ?? existing?.content ?? '';
                        const next: QueuedMessage = {
                            ...(existing ?? { id: `queued-server-${admission.id}`, createdAt: admission.timeCreated ?? Date.now(), content }),
                            content,
                            clientMessageId: admission.id,
                            admissionState: 'admitted',
                            admissionAck: {
                                ...(existing?.admissionAck ?? {}),
                                admittedSeq: admission.admittedSeq ?? existing?.admissionAck?.admittedSeq ?? 0,
                                timeCreated: admission.timeCreated ?? existing?.admissionAck?.timeCreated ?? Date.now(),
                            },
                             // Keep local payload fields that raced the authoritative
                             // event until normal queue capping removes them.
                            attachments: existing?.attachments,
                            sendConfig: existing?.sendConfig,
                            durableSeq: admission.durableSeq,
                            remoteAttachmentNames: admission.prompt ? admission.prompt.files?.map((file) => file.name).filter((name): name is string => Boolean(name)) : existing?.remoteAttachmentNames,
                            remoteAttachmentCount: admission.prompt ? admission.prompt.files?.length : existing?.remoteAttachmentCount,
                            contextParts: admission.prompt?.parts ?? existing?.contextParts,
                        };
                        const existingIndex = current.findIndex((message) => message.clientMessageId === admission.id);
                        const updated = existingIndex < 0
                            ? [...current, next]
                            : current.map((message, index) => index === existingIndex ? next : message);
                        return { queuedMessages: { ...state.queuedMessages, [key]: capQueueMessages(updated) } };
                    });
                },
                removeDurableAdmission: (target, clientMessageId, promptedSeq) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const next = (state.queuedMessages[key] ?? []).flatMap((message) => {
                            if (message.clientMessageId !== clientMessageId) return [message];
                            const admissionSeq = message.durableSeq ?? message.admissionAck?.admittedSeq ?? 0;
                            if (promptedSeq !== undefined && promptedSeq < admissionSeq) return [message];
                            return [];
                        });
                        const previousTombstones = state.durableTombstones[key] ?? {};
                        const { [clientMessageId]: _refreshed, ...olderTombstones } = previousTombstones;
                        void _refreshed;
                        const tombstoneEntries = Object.entries({
                            ...olderTombstones,
                            [clientMessageId]: Math.max(
                                promptedSeq ?? Number.MAX_SAFE_INTEGER,
                                previousTombstones[clientMessageId] ?? 0,
                            ),
                        });
                        const tombstones = Object.fromEntries(tombstoneEntries.slice(-MAX_ADMITTED_HISTORY));
                        const durableTombstones = { ...state.durableTombstones, [key]: tombstones };
                        const tombstoneKeys = Object.keys(durableTombstones);
                        if (tombstoneKeys.length > MAX_QUEUE_TARGETS) {
                            const evictionCandidates = tombstoneKeys.filter((candidate) => candidate !== key);
                            for (const staleKey of evictionCandidates.slice(0, tombstoneKeys.length - MAX_QUEUE_TARGETS)) {
                                delete durableTombstones[staleKey];
                            }
                        }
                        const cappedNext = capQueueMessages(next);
                        if (!cappedNext.length) {
                            const { [key]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest, durableTombstones };
                        }
                        return { queuedMessages: { ...state.queuedMessages, [key]: cappedNext }, durableTombstones };
                    });
                },
                hardDeleteQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const { [key]: _removed, ...queuedMessages } = state.queuedMessages;
                        const { [key]: _sendingRemoved, ...sendingIds } = state.sendingIds;
                        void _removed;
                        void _sendingRemoved;
                        const { [key]: _tombstonesRemoved, ...durableTombstones } = state.durableTombstones;
                        void _tombstonesRemoved;
                        return { queuedMessages, sendingIds, durableTombstones };
                    });
                },
            }),
            {
                name: 'message-queue-store',
                version: 3,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    queuedMessages: state.queuedMessages,
                    quarantinedLegacyMessages: state.quarantinedLegacyMessages,
                    followUpBehavior: state.followUpBehavior,
                    durableTombstones: state.durableTombstones,
                }),
                migrate: migrateMessageQueueState,
                onRehydrateStorage: () => (state) => {
                    if (!state) return;
                    const queuedMessages = normalizePersistedQueueMessages(state.queuedMessages);
                    useMessageQueueStore.setState({ queuedMessages, durableTombstones: state.durableTombstones ?? {} });
                },
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);
