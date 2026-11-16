import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { z } from 'zod';
import type { SyncEvent } from '@/lib/opencode/events';
import { createInputHistoryIdentity, createInputHistorySubmission, useInputHistoryStore } from './useInputHistoryStore';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import type { ContextPartMetadata } from '@/lib/messages/contextParts';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { normalizePath } from '@/lib/pathNormalization';
import { jsonInit, requestJson, scheduledTaskSchema, serverEnqueueResponseSchema, serverSessionResponseSchema, serverSessionSchema, serverSnapshotSchema, serverTakeAllResponseSchema, serverTakeResponseSchema, sessionPath, toQueuedMessage, toServerItemInput, type ServerQueueSession } from './messageQueueServerContract';

export type FollowUpBehavior = 'steer' | 'queue';

const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

const isFollowUpBehavior = (value: unknown): value is FollowUpBehavior => (
    value === 'steer' || value === 'queue'
);

const normalizeFollowUpBehavior = (
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
 * "Run as goal" captured with a queued message: the goal starts when this
 * message is delivered, never with whichever message happens to go out first.
 * `objective` is present only when the arming flow supplied one (the plan
 * flow); otherwise the delivered text is the objective.
 */
export interface QueuedMessageGoal {
    objective?: string;
    tokenBudget: number | null;
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
        /**
         * Delivered as its own synthetic part right before this one. Nothing writes it any
         * more (attached PRs no longer carry review instructions); messages queued before
         * that still do, and are delivered as they were captured.
         */
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
    goal?: QueuedMessageGoal;
    scheduledTask?: z.infer<typeof scheduledTaskSchema>;
}

export interface QueuedMessageInput {
    content: string;
    /** Defaults to `content`. */
    text?: string;
    agentMention?: string;
    attachments?: AttachedFile[];
    context?: QueuedContextPart[];
    sendConfig?: QueuedMessageSendConfig;
    goal?: QueuedMessageGoal;
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

/**
 * The server that owns a session's queue: the server inside a space for a directory of that
 * space, which sees its OpenCode go idle and delivers, and the host's ('') for any other. Each
 * numbers its own revisions, so revisions compare within one owner only.
 */
const queueOwnerOf = (directory: string): string => spaceIdOfDirectory(directory) ?? '';
const ownerRevisionKey = (runtimeKey: string, owner: string): string => `${runtimeKey}\n${owner}`;

/** A request about one session's queue, sent to the server that owns it. */
const toOwner = (target: MessageQueueTarget, init: RequestInit): RuntimeFetchOptions => ({ ...init, directory: target.directory });

/** The whole queue of one owner: the host's, or the space's own. */
const readOwnerSnapshot = (owner: string, signal?: AbortSignal) => requestJson(
    serverSnapshotSchema,
    '/api/message-queue',
    { directory: owner ? `/spaces/${owner}` : null, signal },
);

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
/** A full snapshot also owns sessions it omits, including previously unseen keys. Per runtime and owner. */
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
    /**
     * Local queue: a session moved to `destination`'s directory takes its queued messages and
     * their in-flight marks along, so the old key has nothing left to dispatch. The server-owned
     * queue is rekeyed by the server and arrives as a broadcast instead.
     */
    followSessionMove: (destination: MessageQueueTarget) => void;
    /**
     * The key that holds a message of the target's session now: a move can rekey the local queue
     * while that message's send is in flight. The target itself when no key holds it.
     */
    locateQueuedMessage: (target: MessageQueueTarget, messageId: string) => MessageQueueTarget;
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
    /** Server-owned queue: load the authoritative queue for the active runtime. */
    hydrate: () => Promise<void>;
    /** Server-owned queue: re-read after an event-stream gap. */
    resync: () => Promise<void>;
    /** Server-owned queue: re-read one isolated space's queue, which its own server owns. */
    refreshSpaceQueue: (spaceId: string) => Promise<void>;
    /**
     * Server-owned queue: apply one session's authoritative state (broadcast or response) from its
     * owner, the host ('') or a space; a session the owner may not speak for is ignored.
     */
    applyServerSession: (session: ServerQueueSession, revision: number, expectedRuntimeKey: string, owner?: string) => void;
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

/**
 * Every projection of one session in this runtime, whatever directory it was keyed under; with
 * `owner`, only the directories that owner serves. A cleared key keeps its revision as a
 * tombstone, so a response that started before the clear cannot bring it back.
 */
const clearSessionProjection = (
    state: Pick<MessageQueueState, 'queuedMessages' | 'sendingIds'>,
    runtimeKey: string,
    sessionId: string,
    revision: number,
    owner?: string,
): Pick<MessageQueueState, 'queuedMessages' | 'sendingIds'> => {
    let queuedMessages = state.queuedMessages;
    let sendingIds = state.sendingIds;
    for (const key of new Set([...Object.keys(queuedMessages), ...Object.keys(sendingIds)])) {
        const parsed = parseMessageQueueKey(key);
        if (parsed?.runtimeKey !== runtimeKey || parsed.sessionId !== sessionId) continue;
        if (owner !== undefined && queueOwnerOf(parsed.directory) !== owner) continue;
        if ((appliedRevisions.get(key) ?? -1) > revision) continue;
        appliedRevisions.set(key, revision);
        queuedMessages = withoutKey(queuedMessages, key);
        sendingIds = withoutKey(sendingIds, key);
    }
    return { queuedMessages, sendingIds };
};

/**
 * The newest revision one owner has applied to a session under any directory. A session that
 * moves keeps its owner's revision sequence, so freshness is per session, not per directory key:
 * an old-directory response must not overwrite a newer move it started before.
 */
const newestSessionRevision = (runtimeKey: string, owner: string, sessionId: string): number => {
    let newest = -1;
    for (const [key, revision] of appliedRevisions) {
        if (revision <= newest) continue;
        const parsed = parseMessageQueueKey(key);
        if (parsed?.runtimeKey === runtimeKey && parsed.sessionId === sessionId && queueOwnerOf(parsed.directory) === owner) {
            newest = revision;
        }
    }
    return newest;
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => {
                let hydration: { runtimeKey: string; promise: Promise<void> } | null = null;
                let resyncRequested = false;
                let queueGeneration = 0;
                const cancellations = new Set<() => void>();
                const pendingServerIds = new Map<string, Promise<string>>();
                const activeEnqueues = new Map<string, { target: MessageQueueTarget; requestId: string; accept: (value: z.infer<typeof serverEnqueueResponseSchema>) => void; deferred?: { session: ServerQueueSession; revision: number; owner: string } }>();
                const targetOperations = new Map<string, Promise<void>>();
                const sessionDirectories = new Map<string, { directory: string; revision: number }>();
                const operationKeyFor = (target: MessageQueueTarget) => `${target.runtimeKey}\n${queueOwnerOf(target.directory)}\n${target.sessionId}`;
                const rememberDirectory = (runtimeKey: string, owner: string, session: ServerQueueSession, revision: number) => {
                    const target = createMessageQueueTarget(session.sessionId, session.directory, runtimeKey);
                    if (!target || queueOwnerOf(target.directory) !== owner) return;
                    const key = operationKeyFor(target);
                    if (!targetOperations.has(key)) return;
                    if ((sessionDirectories.get(key)?.revision ?? -1) <= revision) sessionDirectories.set(key, { directory: target.directory, revision });
                };
                const serializeTarget = <T,>(key: string, operation: () => Promise<T>): Promise<T> => {
                    const target = parseMessageQueueKey(key);
                    const operationKey = target ? operationKeyFor(target) : key;
                    const generation = queueGeneration;
                    let cancel = () => {};
                    const run = () => {
                        cancellations.delete(cancel);
                        if (generation !== queueGeneration) throw new Error('The runtime changed while waiting for the queue.');
                        return operation();
                    };
                    const previous = targetOperations.get(operationKey);
                    let result: Promise<T>;
                    try {
                        if (previous) {
                            const cancelled = new Promise<never>((_, reject) => {
                                cancel = () => reject(new Error('The runtime changed while waiting for the queue.'));
                                cancellations.add(cancel);
                            });
                            result = Promise.race([previous.then(run, run), cancelled]).finally(() => cancellations.delete(cancel));
                        } else {
                            result = run();
                        }
                    } catch (error) {
                        result = Promise.reject(error);
                    }
                    const settled = result.then(() => {}, () => {});
                    targetOperations.set(operationKey, settled);
                    void settled.then(() => {
                        if (targetOperations.get(operationKey) === settled) {
                            targetOperations.delete(operationKey);
                            sessionDirectories.delete(operationKey);
                        }
                    });
                    return result;
                };
                const pendingRows = (queue: QueuedMessage[] | undefined) =>
                    (queue ?? []).filter((message) => pendingServerIds.has(message.id));
                const pendingForSession = (queues: Record<string, QueuedMessage[]>, target: MessageQueueTarget) =>
                    Object.entries(queues).flatMap(([key, messages]) => {
                        const entry = parseMessageQueueKey(key);
                        return entry && operationKeyFor(entry) === operationKeyFor(target) ? pendingRows(messages) : [];
                    });
                const removePending = (state: MessageQueueState, key: string, id: string) => {
                    const actual = Object.keys(state.queuedMessages).find((candidate) => state.queuedMessages[candidate]?.some((item) => item.id === id)) ?? key;
                    return removeMessageLocally(state, actual, id);
                };
                const applyServerSession = (session: ServerQueueSession, revision: number, expectedRuntimeKey: string, owner = '') => {
                    if (expectedRuntimeKey !== getRuntimeKey()) return;
                    if (queueOwnerOf(session.directory) !== owner) return;
                    rememberDirectory(expectedRuntimeKey, owner, session, revision);
                    const active = [...activeEnqueues.values()].find(({ target }) => target.runtimeKey === expectedRuntimeKey && target.sessionId === session.sessionId && queueOwnerOf(target.directory) === owner);
                    if (active) {
                        const accepted = session.items.find((item) => item.clientRequestId === active.requestId);
                        if (accepted) {
                            active.accept({ session, revision, itemId: accepted.id });
                        }
                        if (!active.deferred || active.deferred.revision <= revision) active.deferred = { session, revision, owner };
                        return;
                    }
                    if ((snapshotRevisions.get(ownerRevisionKey(expectedRuntimeKey, owner)) ?? -1) > revision) return;
                    const target = createMessageQueueTarget(session.sessionId, session.directory, expectedRuntimeKey);
                    if (!target) {
                        // Servers before 1.22.2 drop a session's directory once its
                        // queue is empty. A session id is unique across directories,
                        // so an empty session still says which projection is done.
                        if (session.items.length > 0) return;
                        set((state) => {
                            const cleared = clearSessionProjection(state, expectedRuntimeKey, session.sessionId, revision);
                            const queuedMessages = { ...cleared.queuedMessages };
                            for (const [key, queue] of Object.entries(state.queuedMessages)) {
                                const parsed = parseMessageQueueKey(key);
                                if (parsed?.runtimeKey !== expectedRuntimeKey || parsed.sessionId !== session.sessionId) continue;
                                const pending = pendingRows(queue);
                                if (pending.length) queuedMessages[key] = pending;
                            }
                            return { ...cleared, queuedMessages };
                        });
                        return;
                    }
                    const key = getMessageQueueKey(target);
                    if (newestSessionRevision(expectedRuntimeKey, owner, session.sessionId) > revision) return;
                    set((state) => {
                        // A moved session speaks for one directory only: its projection under
                        // every other directory of this owner goes, or the composer would show
                        // the same queued message in both places until the next full snapshot.
                        const cleared = clearSessionProjection(state, expectedRuntimeKey, session.sessionId, revision, owner);
                        appliedRevisions.set(key, revision);
                        const queue = [...session.items.map(toQueuedMessage), ...pendingForSession(state.queuedMessages, target)];
                        const queuedMessages = queue.length > 0
                            ? { ...cleared.queuedMessages, [key]: queue }
                            : cleared.queuedMessages;
                        const sendingIds = session.sendingId
                            ? { ...cleared.sendingIds, [key]: [session.sendingId] }
                            : cleared.sendingIds;
                        return { queuedMessages, sendingIds };
                    });
                };

                /** Server state wins; a failed round-trip re-reads it instead of guessing. */
                const refreshSession = async (target: MessageQueueTarget) => {
                    if (target.runtimeKey !== getRuntimeKey()) return;
                    const generation = queueGeneration;
                    const owner = queueOwnerOf(target.directory);
                    try {
                        const snapshot = await readOwnerSnapshot(owner);
                        const session = snapshot.sessions.find((entry) => entry.sessionId === target.sessionId)
                            ?? { sessionId: target.sessionId, directory: target.directory, items: [], sendingId: null };
                        if (generation === queueGeneration) applyServerSession(session, snapshot.revision, target.runtimeKey, owner);
                    } catch {
                        // Offline: keep the optimistic projection; the next broadcast or hydration corrects it.
                    }
                };

                const serverMutation = async (
                    target: MessageQueueTarget,
                    path: string,
                    init: RequestInit,
                ) => {
                    if (target.runtimeKey !== getRuntimeKey()) return;
                    const generation = queueGeneration;
                    try {
                        const result = await requestJson(serverSessionResponseSchema, path, toOwner(target, init));
                        if (generation === queueGeneration) applyServerSession(result.session, result.revision, target.runtimeKey, queueOwnerOf(target.directory));
                    } catch (error) {
                        if (generation !== queueGeneration) return;
                        console.warn('[queue] server update failed:', error);
                        await refreshSession(target);
                    }
                };

                /**
                 * A complete queue of one owner replaces that owner's part of the projection; the
                 * rest stays. Resolves false for a snapshot older than one already applied.
                 */
                const applyOwnerSnapshot = (snapshot: z.infer<typeof serverSnapshotSchema>, runtimeKey: string, owner: string): boolean => {
                    const revisionKey = ownerRevisionKey(runtimeKey, owner);
                    if ((snapshotRevisions.get(revisionKey) ?? -1) > snapshot.revision) return false;
                    snapshotRevisions.set(revisionKey, snapshot.revision);
                    for (const session of snapshot.sessions) rememberDirectory(runtimeKey, owner, session, snapshot.revision);
                    for (const active of activeEnqueues.values()) {
                        if (active.target.runtimeKey !== runtimeKey || queueOwnerOf(active.target.directory) !== owner) continue;
                        const session = snapshot.sessions.find((entry) => entry.sessionId === active.target.sessionId)
                            ?? { sessionId: active.target.sessionId, directory: active.target.directory, items: [], sendingId: null };
                        const accepted = session.items.find((item) => item.clientRequestId === active.requestId);
                        if (accepted) active.accept({ session, revision: snapshot.revision, itemId: accepted.id });
                        if (!active.deferred || active.deferred.revision <= snapshot.revision) active.deferred = { session, revision: snapshot.revision, owner };
                    }
                    set((state) => {
                        // A broadcast newer than this snapshot wins, listed in it or not.
                        const isNewerThanSnapshot = (key: string) => (appliedRevisions.get(key) ?? -1) > snapshot.revision;
                        const isOwned = (key: string) => {
                            const parsed = parseMessageQueueKey(key);
                            return parsed?.runtimeKey === runtimeKey && queueOwnerOf(parsed.directory) === owner;
                        };
                        const isActive = (sessionId: string) => [...activeEnqueues.values()].some(({ target }) => target.runtimeKey === runtimeKey && target.sessionId === sessionId && queueOwnerOf(target.directory) === owner);
                        const keep = (key: string) => !isOwned(key) || isNewerThanSnapshot(key) || isActive(parseMessageQueueKey(key)?.sessionId ?? '');
                        const queuedMessages: Record<string, QueuedMessage[]> = {};
                        const sendingIds: Record<string, string[]> = {};
                        for (const [key, queue] of Object.entries(state.queuedMessages)) {
                            if (keep(key)) queuedMessages[key] = queue;
                        }
                        for (const [key, ids] of Object.entries(state.sendingIds)) {
                            if (keep(key)) sendingIds[key] = ids;
                        }
                        for (const session of snapshot.sessions) {
                            if (queueOwnerOf(session.directory) !== owner) continue;
                            if (isActive(session.sessionId)) continue;
                            const target = createMessageQueueTarget(session.sessionId, session.directory, runtimeKey);
                            if (!target) continue;
                            const key = getMessageQueueKey(target);
                            // Per session, not per key: a move broadcast newer than this snapshot
                            // already placed the session under another directory.
                            if (newestSessionRevision(runtimeKey, owner, session.sessionId) > snapshot.revision) continue;
                            appliedRevisions.set(key, snapshot.revision);
                            const queue = [...session.items.map(toQueuedMessage), ...pendingForSession(state.queuedMessages, target)];
                            if (queue.length > 0) queuedMessages[key] = queue;
                            if (session.sendingId) sendingIds[key] = [session.sendingId];
                        }
                        for (const [key, queue] of Object.entries(state.queuedMessages)) {
                            if (!isOwned(key) || queuedMessages[key] || isNewerThanSnapshot(key)) continue;
                            const target = parseMessageQueueKey(key);
                            if (target && Object.keys(queuedMessages).some((candidate) => {
                                const existing = parseMessageQueueKey(candidate);
                                return existing && operationKeyFor(existing) === operationKeyFor(target);
                            })) continue;
                            const pending = pendingRows(queue);
                            if (pending.length) queuedMessages[key] = pending;
                        }
                        return { queuedMessages, sendingIds };
                    });
                    return true;
                };

                return {
                    queuedMessages: {},
                    quarantinedLegacyMessages: {},
                    followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
                    sendingIds: {},

                    addToQueue: async (target, message) => {
                        const key = getMessageQueueKey(target);
                        const generation = queueGeneration;
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
                        if (message.goal) queuedMessage.goal = message.goal;

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
                        const sendConfig = message.sendConfig;
                        const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
                        const historyIdentity = createInputHistoryIdentity(target.runtimeKey, target.directory, target.sessionId);
                        const historySubmission = createInputHistorySubmission(message.content, message.attachments ?? []);
                        let enqueueState: (typeof activeEnqueues extends Map<string, infer T> ? T : never) | undefined;
                        try {
                            const request = serializeTarget(key, () => {
                                if (target.runtimeKey !== getRuntimeKey()) throw new Error('The runtime changed while waiting for the queue.');
                                const accepted = new Promise<z.infer<typeof serverEnqueueResponseSchema>>((accept) => {
                                    enqueueState = { target, requestId, accept };
                                    activeEnqueues.set(key, enqueueState);
                                });
                                const directory = sessionDirectories.get(operationKeyFor(target))?.directory ?? target.directory;
                                const posted = requestJson(serverEnqueueResponseSchema, `${sessionPath(target.sessionId)}/items`, toOwner(target, jsonInit('POST', {
                                    directory,
                                    item: { ...toServerItemInput(message, sendConfig), clientRequestId: requestId },
                                })));
                                return Promise.race([posted, accepted]);
                            });
                            const serverId = request.then((result) => result.itemId);
                            pendingServerIds.set(id, serverId);
                            void serverId.catch(() => {});
                            const result = await request;
                            if (generation !== queueGeneration) return;
                            const active = enqueueState;
                            if (activeEnqueues.get(key) === active) activeEnqueues.delete(key);
                            // The optimistic entry is replaced by the server's copy of the queue.
                            set((state) => removePending(state, key, id));
                            applyServerSession(result.session, result.revision, target.runtimeKey, queueOwnerOf(target.directory));
                            if (active?.deferred) applyServerSession(active.deferred.session, active.deferred.revision, target.runtimeKey, active.deferred.owner);
                            if (historyIdentity) {
                                useInputHistoryStore.getState().appendSubmissions(historyIdentity, [historySubmission]);
                            }
                        } catch (error) {
                            if (generation !== queueGeneration) throw error;
                            const active = enqueueState;
                            if (activeEnqueues.get(key) === active) activeEnqueues.delete(key);
                            set((state) => removePending(state, key, id));
                            if (active?.deferred) applyServerSession(active.deferred.session, active.deferred.revision, target.runtimeKey, active.deferred.owner);
                            await refreshSession(target);
                            throw error;
                        } finally {
                            pendingServerIds.delete(id);
                        }
                    },

                    removeFromQueue: (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        set((state) => removeMessageLocally(state, key, messageId));
                        if (isServerOwnedMessageQueue()) {
                            const pending = pendingServerIds.get(messageId);
                            void serializeTarget(key, async () => {
                                try {
                                    const itemId = await (pending ?? messageId);
                                    if (target.runtimeKey !== getRuntimeKey()) return;
                                    set((state) => removeMessageLocally(state, key, itemId));
                                    await serverMutation(target, `${sessionPath(target.sessionId)}/items/${encodeURIComponent(itemId)}`, jsonInit('DELETE'));
                                } catch {
                                    await refreshSession(target);
                                }
                            }).catch(() => {});
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
                            const ids = newQueue.map((message) => pendingServerIds.get(message.id) ?? message.id);
                            void serializeTarget(key, async () => {
                                try {
                                    const itemIds = await Promise.all(ids);
                                    await serverMutation(target, `${sessionPath(target.sessionId)}/order`, jsonInit('PUT', { itemIds }));
                                } catch {
                                    await refreshSession(target);
                                }
                            }).catch(() => {});
                        }
                    },

                    popToInput: async (target, messageId) => {
                        const [message] = await get().takeForSend(target, messageId);
                        return message ?? null;
                    },

                    takeForSend: async (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        const generation = queueGeneration;
                        if (isServerOwnedMessageQueue()) {
                            try {
                                const owner = queueOwnerOf(target.directory);
                                if (messageId) {
                                    const pending = pendingServerIds.get(messageId) ?? messageId;
                                    return await serializeTarget(key, async () => {
                                        const itemId = await pending;
                                        if (target.runtimeKey !== getRuntimeKey()) throw new Error('The runtime changed while waiting for the queue.');
                                        let result;
                                        try {
                                            result = await requestJson(
                                                serverTakeResponseSchema,
                                                `${sessionPath(target.sessionId)}/items/${encodeURIComponent(itemId)}/take`,
                                                toOwner(target, jsonInit('POST')),
                                            );
                                        } catch (error) {
                                            if (error instanceof Error && 'status' in error && error.status === 409 && 'reason' in error && error.reason === 'message is being sent') {
                                                await refreshSession(target);
                                                return [];
                                            }
                                            throw error;
                                        }
                                        if (generation === queueGeneration) applyServerSession(result.session, result.revision, target.runtimeKey, owner);
                                        return [toQueuedMessage(result.item)];
                                    });
                                }
                                const result = await serializeTarget(key, () => {
                                    if (target.runtimeKey !== getRuntimeKey()) throw new Error('The runtime changed while waiting for the queue.');
                                    return requestJson(serverTakeAllResponseSchema, `${sessionPath(target.sessionId)}/take`, toOwner(target, jsonInit('POST')));
                                });
                                if (generation === queueGeneration) applyServerSession(result.session, result.revision, target.runtimeKey, owner);
                                return result.items.map(toQueuedMessage);
                            } catch (error) {
                                if (generation === queueGeneration) await refreshSession(target);
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
                            void serializeTarget(key, () => serverMutation(target, sessionPath(target.sessionId), jsonInit('DELETE'))).catch(() => {});
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

                    followSessionMove: (destination) => {
                        if (isServerOwnedMessageQueue()) return;
                        const destinationKey = getMessageQueueKey(destination);
                        set((state) => {
                            const queuedMessages = { ...state.queuedMessages };
                            const sendingIds = { ...state.sendingIds };
                            let moved = false;
                            for (const key of new Set([...Object.keys(state.queuedMessages), ...Object.keys(state.sendingIds)])) {
                                if (key === destinationKey) continue;
                                const parsed = parseMessageQueueKey(key);
                                if (parsed?.runtimeKey !== destination.runtimeKey || parsed.sessionId !== destination.sessionId) continue;
                                moved = true;
                                const messages = queuedMessages[key] ?? [];
                                delete queuedMessages[key];
                                if (messages.length > 0) {
                                    const existing = queuedMessages[destinationKey] ?? [];
                                    queuedMessages[destinationKey] = [...existing, ...messages.filter((message) => !existing.some((entry) => entry.id === message.id))];
                                }
                                const ids = sendingIds[key] ?? [];
                                delete sendingIds[key];
                                if (ids.length > 0) sendingIds[destinationKey] = [...new Set([...(sendingIds[destinationKey] ?? []), ...ids])];
                            }
                            return moved ? { queuedMessages, sendingIds } : {};
                        });
                    },

                    locateQueuedMessage: (target, messageId) => {
                        const { queuedMessages, sendingIds } = get();
                        for (const key of new Set([...Object.keys(queuedMessages), ...Object.keys(sendingIds)])) {
                            const parsed = parseMessageQueueKey(key);
                            if (parsed?.runtimeKey !== target.runtimeKey || parsed.sessionId !== target.sessionId) continue;
                            if (queuedMessages[key]?.some((message) => message.id === messageId) || sendingIds[key]?.includes(messageId)) return parsed;
                        }
                        return target;
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
                                const upload = requestJson(serverSessionResponseSchema, `${sessionPath(target.sessionId)}/items`, toOwner(target, jsonInit('POST', {
                                    directory: target.directory,
                                    item: toServerItemInput(message, next.message.sendConfig),
                                }))).then(() => undefined).catch((error) => {
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
                                    snapshot = await readOwnerSnapshot('', AbortSignal.timeout(15_000));
                                } catch (error) {
                                    if (!isCurrent()) return;
                                    if (resyncRequested) continue;
                                    throw error;
                                }
                                if (!isCurrent()) return;
                                serverOwnedRuntimeKeys.add(runtimeKey);
                                // The host's snapshot owns the host's sessions; each space's queue is read from that space.
                                if (!applyOwnerSnapshot(snapshot, runtimeKey, '')) continue;
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

                    refreshSpaceQueue: async (spaceId) => {
                        if (!isServerOwnedMessageQueue()) return;
                        const runtimeKey = getRuntimeKey();
                        let snapshot: z.infer<typeof serverSnapshotSchema>;
                        try {
                            snapshot = await readOwnerSnapshot(spaceId, AbortSignal.timeout(15_000));
                        } catch {
                            // A stopped or unreachable space keeps what was last known of its queue.
                            return;
                        }
                        if (runtimeKey !== getRuntimeKey()) return;
                        serverOwnedRuntimeKeys.add(runtimeKey);
                        applyOwnerSnapshot(snapshot, runtimeKey, spaceId);
                    },

                    applyServerSession,

                    resetForRuntimeSwitch: (previousRuntimeKey) => {
                        queueGeneration += 1;
                        for (const cancel of cancellations) cancel();
                        cancellations.clear();
                        targetOperations.clear();
                        activeEnqueues.clear();
                        const pendingIds = new Set(pendingServerIds.keys());
                        pendingServerIds.clear();
                        sessionDirectories.clear();
                        hydrationGeneration += 1;
                        hydration = null;
                        resyncRequested = false;
                        if (previousRuntimeKey) {
                            for (const key of snapshotRevisions.keys()) {
                                if (key.startsWith(`${previousRuntimeKey}\n`)) snapshotRevisions.delete(key);
                            }
                            for (const key of appliedRevisions.keys()) {
                                if (parseMessageQueueKey(key)?.runtimeKey === previousRuntimeKey) appliedRevisions.delete(key);
                            }
                        }
                        if (!previousRuntimeKey) return;
                        // The previous runtime's projection belongs to its server;
                        // switching back re-hydrates it from there.
                        set((state) => {
                            const queuedMessages: Record<string, QueuedMessage[]> = {};
                            const sendingIds: Record<string, string[]> = {};
                            for (const [key, queue] of Object.entries(state.queuedMessages)) {
                                if (parseMessageQueueKey(key)?.runtimeKey !== previousRuntimeKey) {
                                    queuedMessages[key] = queue;
                                } else if (!serverOwnedRuntimeKeys.has(previousRuntimeKey)) {
                                    const retained = queue.filter((item) => !pendingIds.has(item.id));
                                    if (retained.length) queuedMessages[key] = retained;
                                }
                            }
                            for (const [key, ids] of Object.entries(state.sendingIds)) {
                                if (parseMessageQueueKey(key)?.runtimeKey !== previousRuntimeKey || !serverOwnedRuntimeKeys.has(previousRuntimeKey)) sendingIds[key] = ids;
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
    // `spaceId` marks a change the host forwarded from that space's own queue.
    properties: z.object({ revision: z.number(), session: serverSessionSchema, spaceId: z.string().optional() }),
});

export type MessageQueueUpdatedEvent = z.infer<typeof messageQueueUpdatedEventSchema>;

/** `openchamber:message-queue.updated` broadcast → projection. */
export const applyMessageQueueUpdatedEvent = (payload: SyncEvent | MessageQueueUpdatedEvent, expectedRuntimeKey: string): void => {
    if (!isServerOwnedMessageQueue()) return;
    const parsed = messageQueueUpdatedEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const { session, revision, spaceId } = parsed.data.properties;
    useMessageQueueStore.getState().applyServerSession(session, revision, expectedRuntimeKey, spaceId ?? '');
};
