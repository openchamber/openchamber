import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { z } from 'zod';
import type { Event } from '@opencode-ai/sdk/v2';
import { createInputHistoryIdentity, createInputHistorySubmission, useInputHistoryStore } from './useInputHistoryStore';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { contextPartMetadataSchema, type ContextPartMetadata } from '@/lib/messages/contextParts';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { normalizePath } from '@/lib/pathNormalization';
import { getQueuedMessagePreview } from '@/lib/messages/queuedMessagePreview';

export type FollowUpBehavior = 'steer' | 'queue';

const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

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

/**
 * Who delivers the queue. Web, desktop, and mobile talk to an OpenChamber
 * server that owns the queue and sends it whether or not any UI is open. VS
 * Code has no server of its own, so the extension UI keeps the local queue
 * and the foreground auto-send hook.
 */
export const isServerOwnedMessageQueue = (): boolean => !isVSCodeRuntime();

export interface QueuedMessageSendConfig {
    providerID: string;
    modelID: string;
    agent?: string;
    variant?: string;
}

/**
 * Context captured with a queued message: whatever the composer had attached
 * when the message was queued. It leaves the composer with the message, so
 * delivery (by the server, or by the auto-send hook in VS Code) carries it and
 * editing the message brings it back.
 */
export type QueuedContextPart =
    | {
        /** An attached context item: a draft chip or a linked issue/PR. Restored on edit. */
        kind: 'context';
        text: string;
        metadata: ContextPartMetadata;
        /** Delivered as its own synthetic part right before this one (a linked PR's reading instructions). */
        instructions?: string;
    }
    | {
        /** Derived from the message text (the skill instruction); re-derived when the text is sent again, so never restored. */
        kind: 'instruction';
        text: string;
    }
    | {
        /** Handed to the composer by another surface (conflict resolution); restored as pending on edit. */
        kind: 'synthetic';
        text: string;
    };

export interface QueuedMessage {
    id: string;
    /** What the user typed, for display and editing. */
    content: string;
    /** What is delivered: `content` without its leading agent mention, file mentions already resolved. */
    text: string;
    /** Agent mentioned at the start of `content`, delivered as an agent part. */
    agentMention?: string;
    attachments?: AttachedFile[];
    /** Absent on a server projection item; a take brings it back. */
    context?: QueuedContextPart[];
    /** Bounded display-only context summary retained in server projections. */
    contextPreview?: string;
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: QueuedMessageSendConfig;
}

interface QueuedMessageInput {
    content: string;
    /** Defaults to `content`. */
    text?: string;
    agentMention?: string;
    attachments?: AttachedFile[];
    context?: QueuedContextPart[];
    sendConfig?: QueuedMessageSendConfig;
}

export type MessageQueueTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

const MAX_QUEUE_TARGETS = 50;
const MAX_MESSAGES_PER_QUEUE = 20;

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

// ---------------------------------------------------------------------------
// Server contract (packages/web/server/lib/message-queue)
// ---------------------------------------------------------------------------

const serverSendConfigSchema = z.object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
    agent: z.string().optional(),
    variant: z.string().optional(),
});

const serverAttachmentSchema = z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    source: z.enum(['local', 'server', 'vscode']),
    serverPath: z.string().optional(),
    /** Present only on a taken item; broadcasts and snapshots omit payloads. */
    dataUrl: z.string().optional(),
});

const serverContextPartSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('context'),
        text: z.string(),
        metadata: contextPartMetadataSchema,
        instructions: z.string().optional(),
    }),
    z.object({ kind: z.literal('instruction'), text: z.string() }),
    z.object({ kind: z.literal('synthetic'), text: z.string() }),
]);

const serverItemSchema = z.object({
    id: z.string().min(1),
    createdAt: z.number(),
    content: z.string(),
    text: z.string(),
    agentMention: z.string().optional(),
    attachments: z.array(serverAttachmentSchema),
    /** Present only on a taken item; broadcasts and snapshots omit it like attachment payloads. */
    context: z.array(serverContextPartSchema).optional(),
    contextPreview: z.string().optional(),
    sendConfig: serverSendConfigSchema,
});

const serverSessionSchema = z.object({
    sessionId: z.string().min(1),
    directory: z.string(),
    items: z.array(serverItemSchema),
    sendingId: z.string().nullable(),
});

const serverSnapshotSchema = z.object({
    revision: z.number(),
    sessions: z.array(serverSessionSchema),
});

const serverSessionResponseSchema = z.object({
    revision: z.number(),
    session: serverSessionSchema,
});

const serverTakeResponseSchema = serverSessionResponseSchema.extend({ item: serverItemSchema });
const serverTakeAllResponseSchema = serverSessionResponseSchema.extend({ items: z.array(serverItemSchema) });

type ServerQueueSession = z.infer<typeof serverSessionSchema>;
type ServerQueueItem = z.infer<typeof serverItemSchema>;
type ServerQueueAttachment = z.infer<typeof serverAttachmentSchema>;

const decodeDataUrl = (dataUrl: string): ArrayBuffer | null => {
    const commaIndex = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:') || commaIndex === -1) return null;
    const meta = dataUrl.slice(5, commaIndex);
    const payload = dataUrl.slice(commaIndex + 1);
    try {
        if (meta.endsWith(';base64')) {
            const binary = atob(payload);
            const buffer = new ArrayBuffer(binary.length);
            const bytes = new Uint8Array(buffer);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return buffer;
        }
        const encoded = new TextEncoder().encode(decodeURIComponent(payload));
        const buffer = new ArrayBuffer(encoded.byteLength);
        new Uint8Array(buffer).set(encoded);
        return buffer;
    } catch {
        return null;
    }
};

/** A taken item carries its payload; a projection item has an empty file. */
const toAttachedFile = (attachment: ServerQueueAttachment): AttachedFile => {
    const dataUrl = attachment.dataUrl ?? '';
    const bytes = dataUrl ? decodeDataUrl(dataUrl) : null;
    const file: AttachedFile = {
        id: attachment.id,
        file: new File(bytes ? [bytes] : [], attachment.filename, { type: attachment.mimeType }),
        dataUrl,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        size: attachment.size,
        source: attachment.source,
    };
    if (attachment.serverPath) file.serverPath = attachment.serverPath;
    return file;
};

const toQueuedMessage = (item: ServerQueueItem): QueuedMessage => {
    const message: QueuedMessage = {
        id: item.id,
        content: item.content,
        text: item.text,
        createdAt: item.createdAt,
        sendConfig: { ...item.sendConfig },
    };
    if (item.agentMention) message.agentMention = item.agentMention;
    if (item.attachments.length > 0) message.attachments = item.attachments.map(toAttachedFile);
    if (item.context) message.context = item.context;
    if (item.contextPreview) message.contextPreview = item.contextPreview;
    return message;
};

type ServerQueueAttachmentInput = Omit<ServerQueueAttachment, 'dataUrl'> & { dataUrl: string };

type ServerQueueItemInput = {
    content: string;
    text: string;
    agentMention?: string;
    attachments: ServerQueueAttachmentInput[];
    context: QueuedContextPart[];
    contextPreview?: string;
    sendConfig: QueuedMessageSendConfig;
};

type ServerQueueRequestBody =
    | { directory: string; item: ServerQueueItemInput }
    | { itemIds: string[] }
    | { held: boolean };

const toServerAttachment = (attachment: AttachedFile): ServerQueueAttachmentInput => {
    const input: ServerQueueAttachmentInput = {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        source: attachment.source,
        dataUrl: attachment.dataUrl,
    };
    if (attachment.serverPath) input.serverPath = attachment.serverPath;
    return input;
};

const toServerItemInput = (message: QueuedMessageInput, sendConfig: QueuedMessageSendConfig): ServerQueueItemInput => {
    const item: ServerQueueItemInput = {
        content: message.content,
        text: message.text ?? message.content,
        attachments: (message.attachments ?? []).filter((file) => Boolean(file.dataUrl)).map(toServerAttachment),
        context: message.context ?? [],
        sendConfig,
    };
    if (message.agentMention) item.agentMention = message.agentMention;
    const contextPreview = getQueuedMessagePreview({ content: '', context: message.context });
    if (contextPreview) item.contextPreview = contextPreview;
    return item;
};

const requestJson = async <T,>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> => {
    const response = await runtimeFetch(path, init);
    if (!response.ok) {
        const error: Error & { status?: number } = new Error(`Message queue request failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid message queue response');
    return parsed.data;
};

const jsonInit = (method: string, body?: ServerQueueRequestBody): RequestInit => {
    if (body === undefined) return { method };
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
};

const sessionPath = (sessionId: string) => `/api/message-queue/sessions/${encodeURIComponent(sessionId)}`;

/**
 * Runtime keys whose queue the server owns, established by a successful
 * hydration. Their entries are a projection and must not be persisted: a
 * stale local copy would resurrect messages the server already delivered.
 */
const serverOwnedRuntimeKeys = new Set<string>();
type LegacyQueueMigration = {
    items: Array<{ target: MessageQueueTarget; message: QueuedMessage }>;
    pending: Promise<void> | null;
};
const legacyMigrations = new Map<string, LegacyQueueMigration>();

/** Server revision last applied per queue key; older snapshots are ignored. */
const appliedRevisions = new Map<string, number>();
/** A full snapshot also owns sessions it omits, including previously unseen keys. */
const snapshotRevisions = new Map<string, number>();
let hydrationGeneration = 0;

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
     * strand a queued message permanently. With a server-owned queue this
     * mirrors the server's in-flight item.
     */
    sendingIds: Record<string, string[]>;
}

interface MessageQueueActions {
    addToQueue: (target: MessageQueueTarget, message: QueuedMessageInput) => Promise<void>;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => void;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => void;
    /** Removes the message and returns it in full, attachments included. */
    popToInput: (target: MessageQueueTarget, messageId: string) => Promise<QueuedMessage | null>;
    /**
     * Removes what the composer is about to send itself — one message or every
     * message not already being delivered — and returns it in full.
     */
    takeForSend: (target: MessageQueueTarget, messageId?: string) => Promise<QueuedMessage[]>;
    clearQueue: (target: MessageQueueTarget) => void;
    /** Drops the local projection only (the session is gone); never a server call. */
    forgetQueue: (target: MessageQueueTarget) => void;
    clearAllQueues: () => void;
    markSending: (target: MessageQueueTarget, messageId: string) => void;
    clearSending: (target: MessageQueueTarget, messageId: string) => void;
    getSendableQueue: (target: MessageQueueTarget) => QueuedMessage[];
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
    /** Server-owned queue: load the authoritative queue for the active runtime. */
    hydrate: () => Promise<void>;
    /** Server-owned queue: re-read after an event-stream gap. */
    resync: () => Promise<void>;
    /** Server-owned queue: apply one session's authoritative state (broadcast or response). */
    applyServerSession: (session: ServerQueueSession, revision: number, expectedRuntimeKey: string) => void;
    /** Server-owned queue: tell the server to hold or release a session's delivery. */
    setServerHold: (sessionId: string, held: boolean) => Promise<void>;
    resetForRuntimeSwitch: (previousRuntimeKey: string | null | undefined) => void;
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

/** Messages persisted before version 3 carried only `content`. */
type PersistedQueuedMessage = Omit<QueuedMessage, 'text'> & { text?: string };

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, PersistedQueuedMessage[]>;
    quarantinedLegacyMessages?: Record<string, PersistedQueuedMessage[]>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
};

const withDeliveryText = (queues: Record<string, PersistedQueuedMessage[]>): Record<string, QueuedMessage[]> => (
    Object.fromEntries(Object.entries(queues).map(([key, queue]) => [
        key,
        queue.map((message) => ({ ...message, text: message.text ?? message.content })),
    ]))
);

export const migrateMessageQueueState = (persistedState: unknown, version: number): Partial<MessageQueueStore> => {
    const state = (persistedState ?? {}) as PersistedMessageQueueState;
    const legacyQueues = version < 2 ? (state.queuedMessages ?? {}) : {};
    return {
        queuedMessages: version < 2 ? {} : withDeliveryText(state.queuedMessages ?? {}),
        quarantinedLegacyMessages: withDeliveryText({
            ...(state.quarantinedLegacyMessages ?? {}),
            ...legacyQueues,
        }),
        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
    };
};

const withoutKey = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
    const { [key]: _removed, ...rest } = record;
    void _removed;
    return rest;
};

const removeMessageLocally = (
    state: Pick<MessageQueueState, 'queuedMessages'>,
    key: string,
    messageId: string,
): Pick<MessageQueueState, 'queuedMessages'> => {
    const newQueue = (state.queuedMessages[key] ?? []).filter((m) => m.id !== messageId);
    if (newQueue.length === 0) return { queuedMessages: withoutKey(state.queuedMessages, key) };
    return { queuedMessages: { ...state.queuedMessages, [key]: newQueue } };
};

/** Every projection of one session in this runtime, whatever directory it was keyed under. */
const clearSessionProjection = (
    state: Pick<MessageQueueState, 'queuedMessages' | 'sendingIds'>,
    runtimeKey: string,
    sessionId: string,
    revision: number,
): Pick<MessageQueueState, 'queuedMessages' | 'sendingIds'> => {
    let queuedMessages = state.queuedMessages;
    let sendingIds = state.sendingIds;
    for (const key of new Set([...Object.keys(queuedMessages), ...Object.keys(sendingIds)])) {
        const parsed = parseMessageQueueKey(key);
        if (parsed?.runtimeKey !== runtimeKey || parsed.sessionId !== sessionId) continue;
        if ((appliedRevisions.get(key) ?? -1) > revision) continue;
        appliedRevisions.set(key, revision);
        queuedMessages = withoutKey(queuedMessages, key);
        sendingIds = withoutKey(sendingIds, key);
    }
    return { queuedMessages, sendingIds };
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => {
                let hydration: { runtimeKey: string; promise: Promise<void> } | null = null;
                let resyncRequested = false;
                const applyServerSession = (session: ServerQueueSession, revision: number, expectedRuntimeKey: string) => {
                    if (expectedRuntimeKey !== getRuntimeKey()) return;
                    if ((snapshotRevisions.get(expectedRuntimeKey) ?? -1) > revision) return;
                    const target = createMessageQueueTarget(session.sessionId, session.directory, expectedRuntimeKey);
                    if (!target) {
                        // Servers before 1.22.2 drop a session's directory once its
                        // queue is empty. A session id is unique across directories,
                        // so an empty session still says which projection is done.
                        if (session.items.length > 0) return;
                        set((state) => clearSessionProjection(state, expectedRuntimeKey, session.sessionId, revision));
                        return;
                    }
                    const key = getMessageQueueKey(target);
                    if ((appliedRevisions.get(key) ?? -1) > revision) return;
                    appliedRevisions.set(key, revision);
                    set((state) => {
                        const queue = session.items.map(toQueuedMessage);
                        const queuedMessages = queue.length > 0
                            ? { ...state.queuedMessages, [key]: queue }
                            : withoutKey(state.queuedMessages, key);
                        const sendingIds = session.sendingId
                            ? { ...state.sendingIds, [key]: [session.sendingId] }
                            : withoutKey(state.sendingIds, key);
                        return { queuedMessages, sendingIds };
                    });
                };

                /** Server state wins; a failed round-trip re-reads it instead of guessing. */
                const refreshSession = async (target: MessageQueueTarget) => {
                    try {
                        const snapshot = await requestJson(serverSnapshotSchema, '/api/message-queue');
                        const session = snapshot.sessions.find((entry) => entry.sessionId === target.sessionId)
                            ?? { sessionId: target.sessionId, directory: target.directory, items: [], sendingId: null };
                        applyServerSession(session, snapshot.revision, target.runtimeKey);
                    } catch {
                        // Offline: keep the optimistic projection; the next broadcast or hydration corrects it.
                    }
                };

                const serverMutation = async (
                    target: MessageQueueTarget,
                    path: string,
                    init: RequestInit,
                ) => {
                    try {
                        const result = await requestJson(serverSessionResponseSchema, path, init);
                        applyServerSession(result.session, result.revision, target.runtimeKey);
                    } catch (error) {
                        console.warn('[queue] server update failed:', error);
                        await refreshSession(target);
                    }
                };

                return {
                    queuedMessages: {},
                    quarantinedLegacyMessages: {},
                    followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
                    sendingIds: {},

                    addToQueue: async (target, message) => {
                        const key = getMessageQueueKey(target);
                        const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                        const queuedMessage: QueuedMessage = {
                            id,
                            content: message.content,
                            text: message.text ?? message.content,
                            createdAt: Date.now(),
                            sendConfig: message.sendConfig,
                        };
                        if (message.agentMention) queuedMessage.agentMention = message.agentMention;
                        if (message.attachments && message.attachments.length > 0) queuedMessage.attachments = message.attachments;
                        if (message.context && message.context.length > 0) queuedMessage.context = message.context;

                        set((state) => {
                            const currentQueue = state.queuedMessages[key] ?? [];
                            const queuedMessages = {
                                ...state.queuedMessages,
                                [key]: [...currentQueue, queuedMessage].slice(-MAX_MESSAGES_PER_QUEUE),
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

                        if (!isServerOwnedMessageQueue()) return;
                        if (!message.sendConfig) {
                            set((state) => removeMessageLocally(state, key, id));
                            throw new Error('A queued message needs a provider and model to be delivered later.');
                        }
                        const historyIdentity = createInputHistoryIdentity(target.runtimeKey, target.directory, target.sessionId);
                        const historySubmission = createInputHistorySubmission(message.content, message.attachments ?? []);
                        try {
                            const result = await requestJson(serverSessionResponseSchema, `${sessionPath(target.sessionId)}/items`, jsonInit('POST', {
                                directory: target.directory,
                                item: toServerItemInput(message, message.sendConfig),
                            }));
                            // The optimistic entry is replaced by the server's copy of the queue.
                            set((state) => removeMessageLocally(state, key, id));
                            applyServerSession(result.session, result.revision, target.runtimeKey);
                            if (historyIdentity) {
                                useInputHistoryStore.getState().appendSubmissions(historyIdentity, [historySubmission]);
                            }
                        } catch (error) {
                            set((state) => removeMessageLocally(state, key, id));
                            throw error;
                        }
                    },

                    removeFromQueue: (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        set((state) => removeMessageLocally(state, key, messageId));
                        if (isServerOwnedMessageQueue()) {
                            void serverMutation(target, `${sessionPath(target.sessionId)}/items/${encodeURIComponent(messageId)}`, jsonInit('DELETE'));
                        }
                    },

                    reorderQueue: (target, fromId, toId) => {
                        if (fromId === toId) return;
                        const key = getMessageQueueKey(target);
                        const currentQueue = get().queuedMessages[key];
                        if (!currentQueue) return;
                        const fromIndex = currentQueue.findIndex((m) => m.id === fromId);
                        const toIndex = currentQueue.findIndex((m) => m.id === toId);
                        if (fromIndex === -1 || toIndex === -1) return;

                        const newQueue = currentQueue.slice();
                        const [moved] = newQueue.splice(fromIndex, 1);
                        newQueue.splice(toIndex, 0, moved);

                        set((state) => ({
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: newQueue,
                            },
                        }));
                        if (isServerOwnedMessageQueue()) {
                            const itemIds = newQueue.map((message) => message.id);
                            void serverMutation(target, `${sessionPath(target.sessionId)}/order`, jsonInit('PUT', { itemIds }));
                        }
                    },

                    popToInput: async (target, messageId) => {
                        const [message] = await get().takeForSend(target, messageId);
                        return message ?? null;
                    },

                    takeForSend: async (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        if (isServerOwnedMessageQueue()) {
                            try {
                                if (messageId) {
                                    const result = await requestJson(
                                        serverTakeResponseSchema,
                                        `${sessionPath(target.sessionId)}/items/${encodeURIComponent(messageId)}/take`,
                                        jsonInit('POST'),
                                    );
                                    applyServerSession(result.session, result.revision, target.runtimeKey);
                                    return [toQueuedMessage(result.item)];
                                }
                                const result = await requestJson(serverTakeAllResponseSchema, `${sessionPath(target.sessionId)}/take`, jsonInit('POST'));
                                applyServerSession(result.session, result.revision, target.runtimeKey);
                                return result.items.map(toQueuedMessage);
                            } catch (error) {
                                await refreshSession(target);
                                throw error;
                            }
                        }

                        const state = get();
                        const sending = state.sendingIds[key] ?? [];
                        const taken = (state.queuedMessages[key] ?? []).filter((message) => (
                            (messageId ? message.id === messageId : true) && !sending.includes(message.id)
                        ));
                        if (taken.length === 0) return [];
                        const takenIds = new Set(taken.map((message) => message.id));
                        set((prevState) => {
                            const remaining = (prevState.queuedMessages[key] ?? []).filter((message) => !takenIds.has(message.id));
                            if (remaining.length === 0) return { queuedMessages: withoutKey(prevState.queuedMessages, key) };
                            return { queuedMessages: { ...prevState.queuedMessages, [key]: remaining } };
                        });
                        return taken;
                    },

                    clearQueue: (target) => {
                        const key = getMessageQueueKey(target);
                        set((state) => {
                            // Clearing drops what is still queued, never a message
                            // already handed to the server: that send will resolve
                            // and must find its entry to remove or restore.
                            const sending = state.sendingIds[key] ?? [];
                            const retained = (state.queuedMessages[key] ?? []).filter((m) => sending.includes(m.id));
                            if (retained.length > 0) {
                                return { queuedMessages: { ...state.queuedMessages, [key]: retained } };
                            }
                            return { queuedMessages: withoutKey(state.queuedMessages, key) };
                        });
                        if (isServerOwnedMessageQueue()) {
                            void serverMutation(target, sessionPath(target.sessionId), jsonInit('DELETE'));
                        }
                    },

                    forgetQueue: (target) => {
                        const key = getMessageQueueKey(target);
                        appliedRevisions.delete(key);
                        set((state) => ({
                            queuedMessages: withoutKey(state.queuedMessages, key),
                            sendingIds: withoutKey(state.sendingIds, key),
                        }));
                    },

                    clearAllQueues: () => {
                        set({ queuedMessages: {}, sendingIds: {} });
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
                            if (next.length === 0) return { sendingIds: withoutKey(state.sendingIds, key) };
                            return { sendingIds: { ...state.sendingIds, [key]: next } };
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

                    setFollowUpBehavior: (behavior) => {
                        set({ followUpBehavior: behavior });
                        void updateDesktopSettings({ followUpBehavior: behavior });
                    },

                    getQueueForTarget: (target) => {
                        return get().queuedMessages[getMessageQueueKey(target)] ?? [];
                    },

                    hydrate: () => {
                        if (!isServerOwnedMessageQueue()) return Promise.resolve();
                        const runtimeKey = getRuntimeKey();
                        if (hydration?.runtimeKey === runtimeKey) return hydration.promise;
                        const generation = ++hydrationGeneration;
                        const isCurrent = () => generation === hydrationGeneration && runtimeKey === getRuntimeKey();
                        const promise = (async () => {
                            // Migration and recovery share one request owner so
                            // reconnects cannot upload a legacy message twice.
                            let migration = legacyMigrations.get(runtimeKey);
                            if (!migration) {
                                const items = Object.entries(get().queuedMessages).flatMap(([key, queue]) => {
                                    const target = parseMessageQueueKey(key);
                                    if (!target || target.runtimeKey !== runtimeKey) return [];
                                    return queue.map((message) => ({ target, message }));
                                });
                                migration = { items, pending: null };
                                legacyMigrations.set(runtimeKey, migration);
                            }
                            while (migration.pending || migration.items.length > 0) {
                                if (!isCurrent()) return;
                                if (migration.pending) {
                                    await migration.pending;
                                    continue;
                                }
                                const next = migration.items.shift();
                                if (!next?.message.sendConfig) continue;
                                const { target, message } = next;
                                const upload = requestJson(serverSessionResponseSchema, `${sessionPath(target.sessionId)}/items`, jsonInit('POST', {
                                    directory: target.directory,
                                    item: toServerItemInput(message, next.message.sendConfig),
                                })).then(() => undefined).catch((error) => {
                                    console.warn('[queue] failed to migrate a locally queued message to the server:', error);
                                });
                                migration.pending = upload;
                                const owner = migration;
                                void upload.then(() => { if (owner.pending === upload) owner.pending = null; });
                                await upload;
                            }
                            if (!isCurrent()) return;

                            do {
                                resyncRequested = false;
                                let snapshot: z.infer<typeof serverSnapshotSchema>;
                                try {
                                    snapshot = await requestJson(serverSnapshotSchema, '/api/message-queue', { signal: AbortSignal.timeout(15_000) });
                                } catch (error) {
                                    if (!isCurrent()) return;
                                    if (resyncRequested) continue;
                                    throw error;
                                }
                                if (!isCurrent()) return;
                                serverOwnedRuntimeKeys.add(runtimeKey);
                                if ((snapshotRevisions.get(runtimeKey) ?? -1) > snapshot.revision) continue;
                                snapshotRevisions.set(runtimeKey, snapshot.revision);
                                set((state) => {
                                    // A broadcast newer than this snapshot wins, listed in it or not.
                                    const isNewerThanSnapshot = (key: string) => (appliedRevisions.get(key) ?? -1) > snapshot.revision;
                                    const keep = (key: string) => parseMessageQueueKey(key)?.runtimeKey !== runtimeKey || isNewerThanSnapshot(key);
                                    const queuedMessages: Record<string, QueuedMessage[]> = {};
                                    const sendingIds: Record<string, string[]> = {};
                                    for (const [key, queue] of Object.entries(state.queuedMessages)) {
                                        if (keep(key)) queuedMessages[key] = queue;
                                    }
                                    for (const [key, ids] of Object.entries(state.sendingIds)) {
                                        if (keep(key)) sendingIds[key] = ids;
                                    }
                                    for (const session of snapshot.sessions) {
                                        const target = createMessageQueueTarget(session.sessionId, session.directory, runtimeKey);
                                        if (!target) continue;
                                        const key = getMessageQueueKey(target);
                                        if (isNewerThanSnapshot(key)) continue;
                                        appliedRevisions.set(key, snapshot.revision);
                                        if (session.items.length > 0) queuedMessages[key] = session.items.map(toQueuedMessage);
                                        if (session.sendingId) sendingIds[key] = [session.sendingId];
                                    }
                                    return { queuedMessages, sendingIds };
                                });
                            } while (resyncRequested && isCurrent());
                        })();
                        const run = { runtimeKey, promise };
                        hydration = run;
                        const release = () => { if (hydration === run) hydration = null; };
                        void promise.then(release, release);
                        return promise;
                    },

                    resync: () => {
                        // Share legacy migration with bootstrap. A recovery edge
                        // during its snapshot read still earns one trailing read.
                        if (hydration?.runtimeKey === getRuntimeKey()) resyncRequested = true;
                        return get().hydrate();
                    },

                    applyServerSession,

                    setServerHold: async (sessionId, held) => {
                        if (!isServerOwnedMessageQueue()) return;
                        const response = await runtimeFetch(`${sessionPath(sessionId)}/hold`, jsonInit('PUT', { held }));
                        if (!response.ok) throw new Error(`Message queue hold request failed (${response.status})`);
                    },

                    resetForRuntimeSwitch: (previousRuntimeKey) => {
                        hydrationGeneration += 1;
                        hydration = null;
                        resyncRequested = false;
                        if (previousRuntimeKey) {
                            snapshotRevisions.delete(previousRuntimeKey);
                            for (const key of appliedRevisions.keys()) {
                                if (parseMessageQueueKey(key)?.runtimeKey === previousRuntimeKey) appliedRevisions.delete(key);
                            }
                        }
                        if (!previousRuntimeKey || !serverOwnedRuntimeKeys.has(previousRuntimeKey)) return;
                        // The previous runtime's projection belongs to its server;
                        // switching back re-hydrates it from there.
                        set((state) => {
                            const queuedMessages: Record<string, QueuedMessage[]> = {};
                            const sendingIds: Record<string, string[]> = {};
                            for (const [key, queue] of Object.entries(state.queuedMessages)) {
                                if (parseMessageQueueKey(key)?.runtimeKey === previousRuntimeKey) appliedRevisions.delete(key);
                                else queuedMessages[key] = queue;
                            }
                            for (const [key, ids] of Object.entries(state.sendingIds)) {
                                if (parseMessageQueueKey(key)?.runtimeKey !== previousRuntimeKey) sendingIds[key] = ids;
                            }
                            return { queuedMessages, sendingIds };
                        });
                    },
                };
            },
            {
                name: 'message-queue-store',
                version: 3,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    queuedMessages: Object.fromEntries(
                        Object.entries(state.queuedMessages).filter(([key]) => {
                            const runtimeKey = parseMessageQueueKey(key)?.runtimeKey;
                            return !runtimeKey || !serverOwnedRuntimeKeys.has(runtimeKey);
                        }),
                    ),
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

export const messageQueueUpdatedEventSchema = z.object({
    type: z.literal('openchamber:message-queue.updated'),
    properties: z.object({ revision: z.number(), session: serverSessionSchema }),
});

export type MessageQueueUpdatedEvent = z.infer<typeof messageQueueUpdatedEventSchema>;

/** `openchamber:message-queue.updated` broadcast → projection. */
export const applyMessageQueueUpdatedEvent = (payload: Event | MessageQueueUpdatedEvent, expectedRuntimeKey: string): void => {
    if (!isServerOwnedMessageQueue()) return;
    const parsed = messageQueueUpdatedEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const { session, revision } = parsed.data.properties;
    useMessageQueueStore.getState().applyServerSession(session, revision, expectedRuntimeKey);
};
