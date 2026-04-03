/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import type { Message, Part } from "@opencode-ai/sdk/v2";
import { opencodeClient } from "@/lib/opencode/client";
import { isExecutionForkMetaText } from "@/lib/messages/executionMeta";
import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from "@/lib/messages/providerAuthError";
import type { SessionMemoryState, SessionHistoryMeta, MessageStreamLifecycle, AttachedFile } from "./types/sessionTypes";
import { MEMORY_LIMITS, getMemoryLimits } from "./types/sessionTypes";
import {
    touchStreamingLifecycle,
    removeLifecycleEntries,
    clearLifecycleTimersForIds,
    clearLifecycleCompletionTimer
} from "./utils/streamingUtils";
import { extractTextFromPart, normalizeStreamingPart } from "./utils/messageUtils";
import { filterMessagesByRevertPoint, normalizeMessageInfoForProjection } from "./utils/messageProjectors";
import { getSafeStorage } from "./utils/safeStorage";
import { useFileStore } from "./fileStore";
import { useSessionStore } from "./sessionStore";
import { useContextStore } from "./contextStore";
import { useUIStore } from "./useUIStore";
import { useCommandsStore } from "./useCommandsStore";

// Helper function to clean up pending user message metadata
const cleanupPendingUserMessageMeta = (
    currentPending: Map<string, { mode?: string; providerID?: string; modelID?: string; variant?: string }>,

    sessionId: string
): Map<string, { mode?: string; providerID?: string; modelID?: string; variant?: string }> => {
    const nextPending = new Map(currentPending);
    nextPending.delete(sessionId);
    return nextPending;
};

const COMPACTION_WINDOW_MS = 30_000;

const timeoutRegistry = new Map<string, ReturnType<typeof setTimeout>>();
const lastContentRegistry = new Map<string, string>();
const streamingCooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();
const loadMessagesInFlightBySession = new Map<string, Promise<void>>();
const loadMessagesRequestSeqBySession = new Map<string, number>();

interface QueuedStreamingPart {
    sessionId: string;
    messageId: string;
    part: Part;
    role?: string;
    currentSessionId?: string;
}

interface QueuedPartDelta {
    sessionId: string;
    messageId: string;
    partId: string;
    field: string;
    delta: string;
    role?: string;
    currentSessionId?: string;
}

type StreamingPartImmediateHandler = (
    sessionId: string,
    messageId: string,
    part: Part,
    role?: string,
    currentSessionId?: string,
) => void;

const queuedNonTextStreamingPartsByKey = new Map<string, QueuedStreamingPart>();
const queuedNonTextStreamingPartOrder: string[] = [];
let nonTextStreamingFlushScheduled = false;
let nonTextStreamingFlushRafId: number | null = null;
let nonTextStreamingFlushTimeoutId: ReturnType<typeof setTimeout> | null = null;
const NON_TEXT_STREAMING_QUEUE_HARD_LIMIT = 2500;

const queuedPartDeltasByKey = new Map<string, QueuedPartDelta>();
const queuedPartDeltaOrder: string[] = [];
let partDeltaFlushScheduled = false;
let partDeltaFlushRafId: number | null = null;
let partDeltaFlushTimeoutId: ReturnType<typeof setTimeout> | null = null;
const PART_DELTA_QUEUE_HARD_LIMIT = 3500;
const ENABLE_STREAMING_FRAME_BATCHING = true;
const TOOL_STREAMING_BATCH_DELAY_MS = 120;

const clearNonTextStreamingFlushSchedule = () => {
    if (nonTextStreamingFlushRafId !== null) {
        cancelAnimationFrame(nonTextStreamingFlushRafId);
        nonTextStreamingFlushRafId = null;
    }
    if (nonTextStreamingFlushTimeoutId !== null) {
        clearTimeout(nonTextStreamingFlushTimeoutId);
        nonTextStreamingFlushTimeoutId = null;
    }
    nonTextStreamingFlushScheduled = false;
};

const queuedStreamingPartKey = (entry: QueuedStreamingPart): string => {
    const partKey = getPartKey(entry.part) ?? `${entry.part.type ?? "unknown"}`;
    const roleKey = typeof entry.role === 'string' ? entry.role : '';
    return `${entry.sessionId}:${entry.messageId}:${roleKey}:${partKey}`;
};

const enqueueNonTextStreamingPart = (entry: QueuedStreamingPart) => {
    const key = queuedStreamingPartKey(entry);
    if (!queuedNonTextStreamingPartsByKey.has(key)) {
        queuedNonTextStreamingPartOrder.push(key);
    }
    queuedNonTextStreamingPartsByKey.set(key, entry);
};

const flushQueuedNonTextStreamingParts = (
    immediateHandler: StreamingPartImmediateHandler,
    filter?: (entry: QueuedStreamingPart) => boolean,
) => {
    if (queuedNonTextStreamingPartOrder.length === 0) {
        clearNonTextStreamingFlushSchedule();
        return;
    }

    const batch: QueuedStreamingPart[] = [];
    const nextOrder: string[] = [];

    for (const key of queuedNonTextStreamingPartOrder) {
        const entry = queuedNonTextStreamingPartsByKey.get(key);
        if (!entry) {
            continue;
        }
        if (filter && !filter(entry)) {
            nextOrder.push(key);
            continue;
        }
        batch.push(entry);
        queuedNonTextStreamingPartsByKey.delete(key);
    }

    queuedNonTextStreamingPartOrder.length = 0;
    queuedNonTextStreamingPartOrder.push(...nextOrder);

    if (batch.length === 0) {
        if (queuedNonTextStreamingPartOrder.length === 0) {
            clearNonTextStreamingFlushSchedule();
        }
        return;
    }

    for (const entry of batch) {
        immediateHandler(entry.sessionId, entry.messageId, entry.part, entry.role, entry.currentSessionId);
    }

    if (queuedNonTextStreamingPartOrder.length === 0) {
        clearNonTextStreamingFlushSchedule();
    }
};

const flushQueuedNonTextStreamingPartsForSession = (
    immediateHandler: StreamingPartImmediateHandler,
    sessionId: string,
) => {
    flushQueuedNonTextStreamingParts(immediateHandler, (entry) => entry.sessionId === sessionId);
};

const flushQueuedNonTextStreamingPartsForMessage = (
    immediateHandler: StreamingPartImmediateHandler,
    sessionId: string,
    messageId: string,
) => {
    flushQueuedNonTextStreamingParts(
        immediateHandler,
        (entry) => entry.sessionId === sessionId && entry.messageId === messageId,
    );
};

const discardQueuedNonTextStreamingPartsForSession = (sessionId: string): void => {
    if (queuedNonTextStreamingPartOrder.length === 0) {
        return;
    }

    for (let i = queuedNonTextStreamingPartOrder.length - 1; i >= 0; i -= 1) {
        const key = queuedNonTextStreamingPartOrder[i];
        const entry = queuedNonTextStreamingPartsByKey.get(key);
        if (!entry) {
            queuedNonTextStreamingPartOrder.splice(i, 1);
            continue;
        }
        if (entry.sessionId === sessionId) {
            queuedNonTextStreamingPartsByKey.delete(key);
            queuedNonTextStreamingPartOrder.splice(i, 1);
        }
    }

    if (queuedNonTextStreamingPartOrder.length === 0) {
        clearNonTextStreamingFlushSchedule();
    }
};

const scheduleNonTextStreamingFlush = (flush: () => void): void => {
    if (nonTextStreamingFlushScheduled) {
        return;
    }
    nonTextStreamingFlushScheduled = true;
    nonTextStreamingFlushTimeoutId = setTimeout(() => {
        nonTextStreamingFlushTimeoutId = null;
        if (!nonTextStreamingFlushScheduled) {
            return;
        }
        flush();
    }, TOOL_STREAMING_BATCH_DELAY_MS);
};

const clearPartDeltaFlushSchedule = () => {
    if (partDeltaFlushRafId !== null) {
        cancelAnimationFrame(partDeltaFlushRafId);
        partDeltaFlushRafId = null;
    }
    if (partDeltaFlushTimeoutId !== null) {
        clearTimeout(partDeltaFlushTimeoutId);
        partDeltaFlushTimeoutId = null;
    }
    partDeltaFlushScheduled = false;
};

const queuedPartDeltaKey = (entry: QueuedPartDelta): string => {
    const roleKey = typeof entry.role === 'string' ? entry.role : '';
    return `${entry.sessionId}:${entry.messageId}:${entry.partId}:${entry.field}:${roleKey}`;
};

const enqueuePartDelta = (entry: QueuedPartDelta) => {
    const key = queuedPartDeltaKey(entry);
    const existing = queuedPartDeltasByKey.get(key);
    if (existing) {
        existing.delta += entry.delta;
        if (!existing.currentSessionId && entry.currentSessionId) {
            existing.currentSessionId = entry.currentSessionId;
        }
        return;
    }

    queuedPartDeltasByKey.set(key, { ...entry });
    queuedPartDeltaOrder.push(key);
};

const flushQueuedPartDeltas = (
    immediateHandler: (
        sessionId: string,
        messageId: string,
        partId: string,
        field: string,
        delta: string,
        role?: string,
        currentSessionId?: string,
    ) => void,
    filter?: (entry: QueuedPartDelta) => boolean,
) => {
    if (queuedPartDeltaOrder.length === 0) {
        clearPartDeltaFlushSchedule();
        return;
    }

    const batch: QueuedPartDelta[] = [];
    const nextOrder: string[] = [];

    for (const key of queuedPartDeltaOrder) {
        const entry = queuedPartDeltasByKey.get(key);
        if (!entry) {
            continue;
        }
        if (filter && !filter(entry)) {
            nextOrder.push(key);
            continue;
        }
        batch.push(entry);
        queuedPartDeltasByKey.delete(key);
    }

    queuedPartDeltaOrder.length = 0;
    queuedPartDeltaOrder.push(...nextOrder);

    if (batch.length === 0) {
        if (queuedPartDeltaOrder.length === 0) {
            clearPartDeltaFlushSchedule();
        }
        return;
    }

    for (const entry of batch) {
        immediateHandler(
            entry.sessionId,
            entry.messageId,
            entry.partId,
            entry.field,
            entry.delta,
            entry.role,
            entry.currentSessionId,
        );
    }

    if (queuedPartDeltaOrder.length === 0) {
        clearPartDeltaFlushSchedule();
    }
};

const flushQueuedPartDeltasForSession = (
    immediateHandler: (
        sessionId: string,
        messageId: string,
        partId: string,
        field: string,
        delta: string,
        role?: string,
        currentSessionId?: string,
    ) => void,
    sessionId: string,
) => {
    flushQueuedPartDeltas(immediateHandler, (entry) => entry.sessionId === sessionId);
};

const flushQueuedPartDeltasForMessage = (
    immediateHandler: (
        sessionId: string,
        messageId: string,
        partId: string,
        field: string,
        delta: string,
        role?: string,
        currentSessionId?: string,
    ) => void,
    sessionId: string,
    messageId: string,
) => {
    flushQueuedPartDeltas(
        immediateHandler,
        (entry) => entry.sessionId === sessionId && entry.messageId === messageId,
    );
};

const discardQueuedPartDeltasForSession = (sessionId: string): void => {
    if (queuedPartDeltaOrder.length === 0) {
        return;
    }

    for (let i = queuedPartDeltaOrder.length - 1; i >= 0; i -= 1) {
        const key = queuedPartDeltaOrder[i];
        const entry = queuedPartDeltasByKey.get(key);
        if (!entry) {
            queuedPartDeltaOrder.splice(i, 1);
            continue;
        }
        if (entry.sessionId === sessionId) {
            queuedPartDeltasByKey.delete(key);
            queuedPartDeltaOrder.splice(i, 1);
        }
    }

    if (queuedPartDeltaOrder.length === 0) {
        clearPartDeltaFlushSchedule();
    }
};

const schedulePartDeltaFlush = (flush: () => void): void => {
    if (partDeltaFlushScheduled) {
        return;
    }
    partDeltaFlushScheduled = true;
    partDeltaFlushTimeoutId = setTimeout(() => {
        partDeltaFlushTimeoutId = null;
        if (!partDeltaFlushScheduled) {
            return;
        }
        flush();
    }, TOOL_STREAMING_BATCH_DELAY_MS);
};

const shouldBatchStreamingPart = (part: Part | undefined): boolean => {
    if (!part || typeof part.type !== 'string') {
        return false;
    }

    if (part.type === 'tool') {
        return true;
    }

    if (part.type === 'text' || part.type === 'reasoning') {
        return useUIStore.getState().chatRenderMode === 'sorted';
    }

    return false;
};

const shouldBatchPartDelta = (
    messagesBySession: Map<string, StoredMessage[]>,
    sessionId: string,
    messageId: string,
    partId: string,
): boolean => {
    const sessionMessages = messagesBySession.get(sessionId);
    if (!sessionMessages || sessionMessages.length === 0) {
        return false;
    }
    const messageIndex = resolveSessionMessagePosition(sessionId, messageId, sessionMessages);
    if (messageIndex === -1) {
        return false;
    }
    const targetMessage = sessionMessages[messageIndex];
    const targetPart = targetMessage.parts.find((part) => part?.id === partId);
    if (targetPart?.type === 'tool') {
        return true;
    }

    if (targetPart?.type === 'text' || targetPart?.type === 'reasoning') {
        return useUIStore.getState().chatRenderMode === 'sorted';
    }

    return false;
};

const RECENT_SEND_EMPTY_GUARD_MS = 15_000;

const MIN_SORTABLE_LENGTH = 10;

const extractSortableId = (id: unknown): string | null => {
    if (typeof id !== "string") {
        return null;
    }
    const trimmed = id.trim();
    if (!trimmed) {
        return null;
    }
    const underscoreIndex = trimmed.indexOf("_");
    const candidate = underscoreIndex >= 0 ? trimmed.slice(underscoreIndex + 1) : trimmed;
    if (!candidate || candidate.length < MIN_SORTABLE_LENGTH) {
        return null;
    }
    return candidate;
};

const countLoadedTurns = (messages: Array<{ info: { role?: string; clientRole?: string | null } }>): number => {
    let count = 0;
    for (const message of messages) {
        const role = message.info.clientRole ?? message.info.role;
        if (role === 'user') {
            count += 1;
        }
    }
    return count;
};

const compareMessageEntriesChronologically = (
    a: { info?: { id?: string; time?: { created?: number } } },
    b: { info?: { id?: string; time?: { created?: number } } },
): number => {
    const aId = typeof a?.info?.id === "string" ? a.info.id : "";
    const bId = typeof b?.info?.id === "string" ? b.info.id : "";

    if (aId && bId) {
        const aSortable = extractSortableId(aId);
        const bSortable = extractSortableId(bId);
        if (aSortable && bSortable && aSortable.length === bSortable.length && aSortable !== bSortable) {
            return aSortable < bSortable ? -1 : 1;
        }
        if (aId !== bId) {
            return aId.localeCompare(bId);
        }
    }

    const aCreated = typeof a?.info?.time?.created === "number" ? a.info.time.created : 0;
    const bCreated = typeof b?.info?.time?.created === "number" ? b.info.time.created : 0;
    return aCreated - bCreated;
};

const streamDebugEnabled = (): boolean => {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem("openchamber_stream_debug") === "1";
    } catch {
        return false;
    }
};

const toFileUrl = (inputPath: string): string => {
    const normalized = inputPath.replace(/\\/g, "/").trim();
    if (normalized.startsWith("file://")) {
        return normalized;
    }
    const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
    return `file://${encodeURI(withLeadingSlash)}`;
};

const getPartKey = (part: Part | undefined): string | undefined => {
    if (!part) {
        return undefined;
    }
    if (typeof part.id === "string" && part.id.length > 0) {
        return part.id;
    }
    if (part.type) {
        const reason = (part as Record<string, unknown>).reason;
        const toolName = typeof (part as Record<string, unknown>).tool === "string"
            ? ((part as Record<string, unknown>).tool as string)
            : "";
        const directCallId = (part as Record<string, unknown>).callID;
        const nestedTool = (part as Record<string, unknown>).tool;
        const nestedCallId =
            nestedTool && typeof nestedTool === "object"
                ? (nestedTool as Record<string, unknown>).callID
                : undefined;
        const callId = directCallId ?? nestedCallId;
        return `${part.type}-${toolName}-${reason ?? ""}-${callId ?? ""}`;
    }
    return undefined;
};

const findMatchingPartIndex = (parts: Part[], incoming: Part): number => {
    if (!Array.isArray(parts) || parts.length === 0) {
        return -1;
    }

    if (typeof incoming.id === "string" && incoming.id.length > 0) {
        const byId = parts.findIndex((part) => part?.id === incoming.id);
        if (byId !== -1) {
            return byId;
        }

        return -1;
    }

    const incomingKey = getPartKey(incoming);
    if (!incomingKey) {
        return -1;
    }

    return parts.findIndex((part) => getPartKey(part) === incomingKey);
};

const ignoredAssistantMessageIds = new Set<string>();

const mergeDuplicateMessage = (
    existing: { info: any; parts: Part[] },
    incoming: { info: any; parts: Part[] }
): { info: any; parts: Part[] } => {
    return {
        ...incoming,
        info: {
            ...existing.info,
            ...incoming.info,
        },
        parts: Array.isArray(incoming.parts) ? incoming.parts : [],
    };
};

const dedupeMessagesById = (messages: { info: any; parts: Part[] }[]) => {
    const deduped: { info: any; parts: Part[] }[] = [];
    const indexById = new Map<string, number>();

    for (const message of messages) {
        const messageId = typeof message?.info?.id === "string" ? message.info.id : null;
        if (!messageId) {
            deduped.push(message);
            continue;
        }
        const existingIndex = indexById.get(messageId);
        if (existingIndex === undefined) {
            indexById.set(messageId, deduped.length);
            deduped.push(message);
            continue;
        }
        deduped[existingIndex] = mergeDuplicateMessage(deduped[existingIndex], message);
    }

    return deduped;
};

const setStreamingIdForSession = (source: Map<string, string | null>, sessionId: string, messageId: string | null) => {
    const existing = source.get(sessionId);
    if (existing === messageId) {
        return source;
    }
    const next = new Map(source);
    if (messageId) {
        next.set(sessionId, messageId);
    } else {
        next.delete(sessionId);
    }
    return next;
};

const upsertMessageSessionIndex = (source: Map<string, string>, messageId: string, sessionId: string) => {
    const existing = source.get(messageId);
    if (existing === sessionId) {
        return source;
    }
    const next = new Map(source);
    next.set(messageId, sessionId);
    return next;
};

type StoredMessage = { info: any; parts: Part[] };

const sessionMessagePositionCache = new Map<string, Map<string, number>>();

const buildSessionMessagePositionIndex = (messages: StoredMessage[]): Map<string, number> => {
    const index = new Map<string, number>();
    for (let position = 0; position < messages.length; position += 1) {
        const id = (messages[position]?.info as { id?: unknown })?.id;
        if (typeof id === 'string' && id.length > 0) {
            index.set(id, position);
        }
    }
    return index;
};

const primeSessionMessagePositionIndex = (sessionId: string, messages: StoredMessage[]) => {
    sessionMessagePositionCache.set(sessionId, buildSessionMessagePositionIndex(messages));
};

const updateSessionMessagePositionEntry = (sessionId: string, messageId: string, position: number) => {
    let sessionIndex = sessionMessagePositionCache.get(sessionId);
    if (!sessionIndex) {
        sessionIndex = new Map<string, number>();
        sessionMessagePositionCache.set(sessionId, sessionIndex);
    }
    sessionIndex.set(messageId, position);
};

const resolveSessionMessagePosition = (sessionId: string, messageId: string, messages: StoredMessage[]): number => {
    const sessionIndex = sessionMessagePositionCache.get(sessionId);
    const cachedPosition = sessionIndex?.get(messageId);
    if (
        typeof cachedPosition === 'number'
        && cachedPosition >= 0
        && cachedPosition < messages.length
        && (messages[cachedPosition]?.info as { id?: unknown })?.id === messageId
    ) {
        return cachedPosition;
    }

    const resolved = messages.findIndex((message) => message.info.id === messageId);
    if (resolved !== -1) {
        updateSessionMessagePositionEntry(sessionId, messageId, resolved);
    } else if (sessionIndex) {
        sessionIndex.delete(messageId);
    }

    return resolved;
};

const removeMessageSessionIndexEntries = (source: Map<string, string>, ids: Iterable<string>) => {
    const next = new Map(source);
    let mutated = false;
    for (const id of ids) {
        if (next.delete(id)) {
            mutated = true;
        }
    }
    return mutated ? next : source;
};

const collectActiveMessageIdsForSession = (state: MessageState, sessionId: string): Set<string> => {
    const ids = new Set<string>();
    const latest = state.streamingMessageIds.get(sessionId);
    if (latest) {
        ids.add(latest);
    }
    state.messageStreamStates.forEach((_lifecycle, messageId) => {
        if (state.messageSessionIndex.get(messageId) === sessionId) {
            ids.add(messageId);
        }
    });
    return ids;
};

const isMessageStreamingInSession = (state: MessageState, sessionId: string, messageId: string) => {
    if (state.streamingMessageIds.get(sessionId) === messageId) {
        return true;
    }
    return state.messageSessionIndex.get(messageId) === sessionId && state.messageStreamStates.has(messageId);
};

const resolveSessionDirectory = async (sessionId: string | null | undefined): Promise<string | undefined> => {
    if (!sessionId) {
        return undefined;
    }

    try {
        const sessionStore = useSessionStore.getState();
        const directory = sessionStore.getDirectoryForSession(sessionId);
        return directory ?? undefined;
    } catch (error) {
        console.warn('Failed to resolve session directory override:', error);
        return undefined;
    }
};

const getSessionRevertMessageId = (sessionId: string | null | undefined): string | null => {
    if (!sessionId) return null;
    try {
        const sessionStore = useSessionStore.getState();
        const session = sessionStore.sessions.find((entry) => entry.id === sessionId) as { revert?: { messageID?: string } } | undefined;
        return session?.revert?.messageID ?? null;
    } catch {
        return null;
    }
};

const executeWithSessionDirectory = async <T>(sessionId: string | null | undefined, operation: () => Promise<T>): Promise<T> => {
    const directoryOverride = await resolveSessionDirectory(sessionId);
    if (directoryOverride) {
        return opencodeClient.withDirectory(directoryOverride, operation);
    }
    return operation();
};

interface SessionAbortRecord {
    timestamp: number;
    acknowledged: boolean;
}

interface MessageState {
    messages: Map<string, { info: any; parts: Part[] }[]>;
    sessionMemoryState: Map<string, SessionMemoryState>;
    sessionHistoryMeta: Map<string, SessionHistoryMeta>;
    messageStreamStates: Map<string, MessageStreamLifecycle>;
    messageSessionIndex: Map<string, string>;
    streamingMessageIds: Map<string, string | null>;
    abortControllers: Map<string, AbortController>;
    lastUsedProvider: { providerID: string; modelID: string } | null;
    isSyncing: boolean;
    pendingAssistantParts: Map<string, { sessionId: string; parts: Part[] }>;
    sessionCompactionUntil: Map<string, number>;
    sessionAbortFlags: Map<string, SessionAbortRecord>;
    pendingUserMessageMetaBySession: Map<string, { mode?: string; providerID?: string; modelID?: string; variant?: string }>;

}

interface MessageActions {
    loadMessages: (sessionId: string, limit?: number) => Promise<void>;
    sendMessage: (content: string, providerID: string, modelID: string, agent?: string, currentSessionId?: string, attachments?: AttachedFile[], agentMentionName?: string | null, additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>, variant?: string, inputMode?: 'normal' | 'shell', format?: { type: 'json_schema'; schema: Record<string, unknown>; retryCount?: number }) => Promise<void>;
    abortCurrentOperation: (currentSessionId?: string) => Promise<void>;
    _addStreamingPartImmediate: (sessionId: string, messageId: string, part: Part, role?: string, currentSessionId?: string) => void;
    addStreamingPart: (sessionId: string, messageId: string, part: Part, role?: string, currentSessionId?: string) => void;
    _applyPartDeltaImmediate: (sessionId: string, messageId: string, partId: string, field: string, delta: string, role?: string, currentSessionId?: string) => void;
    applyPartDelta: (sessionId: string, messageId: string, partId: string, field: string, delta: string, role?: string, currentSessionId?: string) => void;
    forceCompleteMessage: (sessionId: string | null | undefined, messageId: string, source?: "timeout" | "cooldown") => void;
    completeStreamingMessage: (sessionId: string, messageId: string) => void;
    markMessageStreamSettled: (messageId: string) => void;
    updateMessageInfo: (sessionId: string, messageId: string, messageInfo: any) => void;
    syncMessages: (
        sessionId: string,
        messages: { info: Message; parts: Part[] }[],
        options?: { replace?: boolean }
    ) => void;
    updateViewportAnchor: (sessionId: string, anchor: number) => void;
    loadMoreMessages: (sessionId: string, direction: "up" | "down") => Promise<void>;
    getLastMessageModel: (sessionId: string) => { providerID?: string; modelID?: string } | null;
    updateSessionCompaction: (sessionId: string, compactingTimestamp: number | null | undefined) => void;
    acknowledgeSessionAbort: (sessionId: string) => void;
}

type MessageStore = MessageState & MessageActions;

export const useMessageStore = create<MessageStore>()(
    devtools(
        persist(
            (set, get) => ({

                messages: new Map(),
                sessionMemoryState: new Map(),
                sessionHistoryMeta: new Map(),
                messageStreamStates: new Map(),
                messageSessionIndex: new Map(),
                streamingMessageIds: new Map(),
                abortControllers: new Map(),
                lastUsedProvider: null,
                isSyncing: false,
                pendingAssistantParts: new Map(),
                sessionCompactionUntil: new Map(),
                sessionAbortFlags: new Map(),
                pendingUserMessageMetaBySession: new Map(),

                loadMessages: async (sessionId: string, limit?: number) => {
                        const existingRequest = loadMessagesInFlightBySession.get(sessionId);
                        if (existingRequest) {
                            return existingRequest;
                        }

                        const requestSeq = (loadMessagesRequestSeqBySession.get(sessionId) ?? 0) + 1;
                        loadMessagesRequestSeqBySession.set(sessionId, requestSeq);
                        const isLatestRequest = () => loadMessagesRequestSeqBySession.get(sessionId) === requestSeq;

                        const task = (async () => {
                            const memLimits = getMemoryLimits();
                            const noLimit = limit === Infinity;
                            const previousMemoryState = get().sessionMemoryState.get(sessionId);
                            const previousHistoryMeta = get().sessionHistoryMeta.get(sessionId);
                            if (previousHistoryMeta?.loading) {
                                return;
                            }

                            // OpenCode parity: history window is driven by meta.limit.
                            const baseLimit = previousHistoryMeta?.limit ?? memLimits.HISTORICAL_MESSAGES;
                            const requestedLimit =
                                typeof limit === 'number' && Number.isFinite(limit)
                                    ? limit
                                    : baseLimit;
                            // Never proactively shrink loaded history window on resync.
                            const targetLimit = Math.max(baseLimit, requestedLimit);

                            set((snapshot) => {
                                if (!isLatestRequest()) {
                                    return snapshot;
                                }
                                const nextHistoryMeta = new Map(snapshot.sessionHistoryMeta);
                                const currentMeta = nextHistoryMeta.get(sessionId);
                                nextHistoryMeta.set(sessionId, {
                                    limit: currentMeta?.limit ?? baseLimit,
                                    complete: currentMeta?.complete ?? false,
                                    loading: true,
                                });
                                return { sessionHistoryMeta: nextHistoryMeta };
                            });

                            // Don't pass Infinity to API - use undefined for "fetch all".
                            // Use targetLimit directly and infer "has more" when payload fills the window,
                            // matching OpenCode behavior and avoiding hidden "load older" on exact-limit responses.
                            try {
                                const fetchLimit = noLimit ? undefined : targetLimit;
                                const allMessages = await executeWithSessionDirectory(sessionId, () => opencodeClient.getSessionMessages(sessionId, fetchLimit));
                                if (!isLatestRequest()) {
                                    return;
                                }

                                // Filter out reverted messages first
                                const revertMessageId = getSessionRevertMessageId(sessionId);
                                const messagesWithoutReverted = filterMessagesByRevertPoint<{ info: Message; parts: Part[] }>(
                                    allMessages as { info: Message; parts: Part[] }[],
                                    revertMessageId,
                                );
                                const orderedMessages = [...messagesWithoutReverted].sort(compareMessageEntriesChronologically);

                                // If server fills the requested window, assume there may be more above.
                                const hasMoreAbove = typeof fetchLimit === 'number'
                                    ? orderedMessages.length >= targetLimit
                                    : false;

                                const messagesToKeep = orderedMessages.slice(-targetLimit);

                                set((state) => {
                                    if (!isLatestRequest()) {
                                        return state;
                                    }

                                    const previousMessages = state.messages.get(sessionId) || [];
                                    const normalizedMessages = messagesToKeep.map((message) => {
                                        const infoWithMarker = normalizeMessageInfoForProjection(message.info as Message) as any;

                                        const serverParts = (Array.isArray(message.parts) ? message.parts : []).map((part) => {
                                            if (part?.type === 'text') {
                                                const raw = (part as any).text ?? (part as any).content ?? '';
                                                if (isExecutionForkMetaText(raw)) {
                                                    return { ...part, synthetic: true } as Part;
                                                }
                                            }
                                            return part;
                                        });
                                        return {
                                            ...message,
                                            info: infoWithMarker,
                                            parts: serverParts,
                                        };
                                    });

                                    const mergedMessages = dedupeMessagesById(normalizedMessages);
                                    const currentMemoryState = state.sessionMemoryState.get(sessionId) ?? previousMemoryState;
                                    const hasStreamingMessage = Boolean(state.streamingMessageIds.get(sessionId));
                                    const sentRecently =
                                        typeof currentMemoryState?.lastUserMessageAt === 'number'
                                        && Date.now() - currentMemoryState.lastUserMessageAt < RECENT_SEND_EMPTY_GUARD_MS;

                                    const shouldPreserveExistingSnapshot =
                                        mergedMessages.length === 0
                                        && previousMessages.length > 0
                                        && (hasStreamingMessage || currentMemoryState?.isStreaming === true || sentRecently);

                                    if (shouldPreserveExistingSnapshot) {
                                        const newMemoryState = new Map(state.sessionMemoryState);
                                        const existingMemory = newMemoryState.get(sessionId) ?? previousMemoryState ?? {
                                            viewportAnchor: 0,
                                            isStreaming: false,
                                            lastAccessedAt: Date.now(),
                                            backgroundMessageCount: 0,
                                        };
                                        newMemoryState.set(sessionId, {
                                            ...existingMemory,
                                            lastAccessedAt: Date.now(),
                                            historyLoading: false,
                                            historyLimit: targetLimit,
                                        });

                                        const newHistoryMeta = new Map(state.sessionHistoryMeta);
                                        const currentMeta = newHistoryMeta.get(sessionId);
                                        newHistoryMeta.set(sessionId, {
                                            limit: targetLimit,
                                            complete: currentMeta?.complete ?? false,
                                            loading: false,
                                        });

                                        return {
                                            sessionMemoryState: newMemoryState,
                                            sessionHistoryMeta: newHistoryMeta,
                                        };
                                    }

                                    const loadedTurnCount = countLoadedTurns(mergedMessages);
                                    const previousIds = new Set(previousMessages.map((msg) => msg.info.id));
                                    const nextIds = new Set(mergedMessages.map((msg) => msg.info.id));
                                    const removedIds: string[] = [];
                                    previousIds.forEach((id) => {
                                        if (!nextIds.has(id)) {
                                            removedIds.push(id);
                                        }
                                    });

                                    const newMessages = new Map(state.messages);
                                    newMessages.set(sessionId, mergedMessages);
                                    primeSessionMessagePositionIndex(sessionId, mergedMessages);

                                    const newMemoryState = new Map(state.sessionMemoryState);
                                    newMemoryState.set(sessionId, {
                                        ...previousMemoryState,
                                        viewportAnchor: mergedMessages.length - 1,
                                        isStreaming: false,
                                        lastAccessedAt: Date.now(),
                                        backgroundMessageCount: 0,
                                        totalAvailableMessages: previousMemoryState?.totalAvailableMessages,
                                        loadedTurnCount,
                                        hasMoreAbove,
                                        hasMoreTurnsAbove: hasMoreAbove,
                                        historyLoading: false,
                                        historyComplete: !hasMoreAbove,
                                        historyLimit: targetLimit,
                                        streamingCooldownUntil: undefined,
                                    });

                                    const newHistoryMeta = new Map(state.sessionHistoryMeta);
                                    newHistoryMeta.set(sessionId, {
                                        limit: targetLimit,
                                        complete: !hasMoreAbove,
                                        loading: false,
                                    });

                                    const result: Record<string, any> = {
                                        messages: newMessages,
                                        sessionMemoryState: newMemoryState,
                                        sessionHistoryMeta: newHistoryMeta,
                                    };

                                    clearLifecycleTimersForIds(removedIds);
                                    const updatedLifecycle = removeLifecycleEntries(state.messageStreamStates, removedIds);
                                    if (updatedLifecycle !== state.messageStreamStates) {
                                        result.messageStreamStates = updatedLifecycle;
                                    }

                                    if (removedIds.length > 0) {
                                        const currentStreaming = state.streamingMessageIds.get(sessionId);
                                        if (currentStreaming && removedIds.includes(currentStreaming)) {
                                            result.streamingMessageIds = setStreamingIdForSession(
                                                result.streamingMessageIds ?? state.streamingMessageIds,
                                                sessionId,
                                                null
                                            );
                                        }
                                    }

                                    if (removedIds.length > 0) {
                                        const nextIndex = removeMessageSessionIndexEntries(
                                            result.messageSessionIndex ?? state.messageSessionIndex,
                                            removedIds
                                        );
                                        if (nextIndex !== (result.messageSessionIndex ?? state.messageSessionIndex)) {
                                            result.messageSessionIndex = nextIndex;
                                        }
                                    }

                                    if (removedIds.length > 0) {
                                        const nextPendingParts = new Map(state.pendingAssistantParts);
                                        let pendingChanged = false;
                                        removedIds.forEach((id) => {
                                            if (nextPendingParts.delete(id)) {
                                                pendingChanged = true;
                                            }
                                        });
                                        if (pendingChanged) {
                                            result.pendingAssistantParts = nextPendingParts;
                                        }
                                    }

                                    const targetIndex = result.messageSessionIndex ?? state.messageSessionIndex;
                                    let indexAccumulator = targetIndex;
                                    mergedMessages.forEach((message) => {
                                        const id = (message?.info as { id?: unknown })?.id;
                                        if (typeof id === "string" && id.length > 0) {
                                            indexAccumulator = upsertMessageSessionIndex(indexAccumulator, id, sessionId);
                                        }
                                    });
                                    if (indexAccumulator !== targetIndex) {
                                        result.messageSessionIndex = indexAccumulator;
                                    }

                                    return result;
                                });
                            } finally {
                                set((snapshot) => {
                                    if (!isLatestRequest()) {
                                        return snapshot;
                                    }
                                    const currentMeta = snapshot.sessionHistoryMeta.get(sessionId);
                                    if (!currentMeta?.loading) {
                                        return snapshot;
                                    }
                                    const nextHistoryMeta = new Map(snapshot.sessionHistoryMeta);
                                    nextHistoryMeta.set(sessionId, {
                                        ...currentMeta,
                                        loading: false,
                                    });
                                    return { sessionHistoryMeta: nextHistoryMeta };
                                });
                            }
                        })();

                        loadMessagesInFlightBySession.set(sessionId, task);
                        try {
                            await task;
                        } finally {
                            if (loadMessagesInFlightBySession.get(sessionId) === task) {
                                loadMessagesInFlightBySession.delete(sessionId);
                            }
                        }
                },

                sendMessage: async (content: string, providerID: string, modelID: string, agent?: string, currentSessionId?: string, attachments?: AttachedFile[], agentMentionName?: string | null, additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>, variant?: string, inputMode: 'normal' | 'shell' = 'normal', format?: { type: 'json_schema'; schema: Record<string, unknown>; retryCount?: number }) => {
                    if (!currentSessionId) {
                        throw new Error("No session selected");
                    }

                    const sessionId = currentSessionId;

                    if (get().sessionAbortFlags.has(sessionId)) {
                        set((state) => {
                            const nextAbortFlags = new Map(state.sessionAbortFlags);
                            nextAbortFlags.delete(sessionId);
                            return { sessionAbortFlags: nextAbortFlags };
                        });
                    }

                    await executeWithSessionDirectory(sessionId, async () => {
                        try {
                            const trimmedContent = content.trimStart();
                            const firstTokenLooksLikeAbsolutePath = (() => {
                                if (!trimmedContent.startsWith('/')) return false;
                                const firstWhitespaceIndex = trimmedContent.search(/\s/);
                                const firstToken = firstWhitespaceIndex === -1
                                    ? trimmedContent
                                    : trimmedContent.slice(0, firstWhitespaceIndex);
                                if (firstToken.length <= 1) return false;
                                const tokenWithoutLeadingSlash = firstToken.slice(1);
                                if (!tokenWithoutLeadingSlash.includes('/')) return false;
                                // Namespaced commands (e.g. /my/commit) contain '/' but
                                // should not be treated as absolute file paths.
                                if (useCommandsStore.getState().getCommandByName(tokenWithoutLeadingSlash)) return false;
                                return true;
                            })();
                            const commandPayload = (() => {
                                if (inputMode === 'shell') return null;
                                if (!trimmedContent.startsWith("/")) return null;
                                if (firstTokenLooksLikeAbsolutePath) return null;
                                const firstLineEnd = trimmedContent.indexOf("\n");
                                const firstLine = firstLineEnd === -1 ? trimmedContent : trimmedContent.slice(0, firstLineEnd);
                                const [commandToken, ...firstLineArgs] = firstLine.split(" ");
                                const command = commandToken.slice(1).trim();
                                if (command.toLowerCase() === "shell") return null;
                                if (!command) return null;
                                const restOfInput = firstLineEnd === -1 ? "" : trimmedContent.slice(firstLineEnd + 1);
                                const argsFromFirstLine = firstLineArgs.join(" ").trim();
                                const args = restOfInput
                                    ? (argsFromFirstLine ? `${argsFromFirstLine}\n${restOfInput}` : restOfInput)
                                    : argsFromFirstLine;
                                return {
                                    command,
                                    arguments: args,
                                };
                            })();
                            const shellPayload = (() => {
                                if (inputMode !== 'shell') return null;
                                const command = content.trim();
                                if (!command.trim()) return null;
                                return { command };
                            })();
                            const slashShellPayload = (() => {
                                if (!trimmedContent.startsWith("/")) return null;
                                if (firstTokenLooksLikeAbsolutePath) return null;
                                const firstLineEnd = trimmedContent.indexOf("\n");
                                const firstLine = firstLineEnd === -1 ? trimmedContent : trimmedContent.slice(0, firstLineEnd);
                                const [commandToken, ...firstLineArgs] = firstLine.split(" ");
                                const commandName = commandToken.slice(1).trim().toLowerCase();
                                if (commandName !== "shell") return null;
                                const restOfInput = firstLineEnd === -1 ? "" : trimmedContent.slice(firstLineEnd + 1);
                                const argsFromFirstLine = firstLineArgs.join(" ").trim();
                                const command = restOfInput
                                    ? (argsFromFirstLine ? `${argsFromFirstLine}\n${restOfInput}` : restOfInput)
                                    : argsFromFirstLine;
                                if (!command.trim()) return null;
                                return { command };
                            })();

                            set({
                                lastUsedProvider: { providerID, modelID },
                            });

                            set((state) => {
                                const memoryState = state.sessionMemoryState.get(sessionId) || {
                                    viewportAnchor: 0,
                                    isStreaming: false,
                                    lastAccessedAt: Date.now(),
                                    backgroundMessageCount: 0,
                                };

                                const existingTimer = streamingCooldownTimers.get(sessionId);
                                if (existingTimer) {
                                    clearTimeout(existingTimer);
                                    streamingCooldownTimers.delete(sessionId);
                                }

                                const newMemoryState = new Map(state.sessionMemoryState);
                                newMemoryState.set(sessionId, {
                                    ...memoryState,
                                    isStreaming: true,
                                    streamStartTime: Date.now(),
                                    streamingCooldownUntil: undefined,
                                });
                                return { sessionMemoryState: newMemoryState };
                            });

                            try {
                                const controller = new AbortController();
                                set((state) => {
                                    const nextControllers = new Map(state.abortControllers);
                                    nextControllers.set(sessionId, controller);
                                    return { abortControllers: nextControllers };
                                });

                                const filePayloads = (attachments ?? []).map((file) => ({
                                    type: "file" as const,
                                    mime: file.mimeType,
                                    filename: file.filename,
                                    url:
                                        file.source === "server" &&
                                        file.serverPath &&
                                        (file.mimeType === "text/plain" || file.mimeType === "application/x-directory")
                                            ? toFileUrl(file.serverPath)
                                            : file.dataUrl,
                                }));

                                set((state) => {
                                    const nextUserMeta = new Map(state.pendingUserMessageMetaBySession);
                                    nextUserMeta.set(sessionId, {
                                        mode: typeof agent === 'string' && agent.trim().length > 0 ? agent.trim() : undefined,
                                        providerID,
                                        modelID,
                                        variant: typeof variant === 'string' && variant.trim().length > 0 ? variant : undefined,
                                    });
                                    return { pendingUserMessageMetaBySession: nextUserMeta };
                                });

                                // Convert additional parts to SDK format
                                const additionalPartsPayload = additionalParts?.map((part) => ({
                                    text: part.text,
                                    synthetic: part.synthetic,
                                    files: part.attachments?.map((file) => ({
                                        type: "file" as const,
                                        mime: file.mimeType,
                                        filename: file.filename,
                                        url:
                                            file.source === "server" &&
                                            file.serverPath &&
                                            (file.mimeType === "text/plain" || file.mimeType === "application/x-directory")
                                                ? toFileUrl(file.serverPath)
                                                : file.dataUrl,
                                    })),
                                }));

                                const apiClient = opencodeClient.getApiClient();
                                const directory = opencodeClient.getDirectory();

                                if (shellPayload || slashShellPayload) {
                                    await apiClient.session.shell({
                                        sessionID: sessionId,
                                        ...(directory ? { directory } : {}),
                                        ...(agent ? { agent } : {}),
                                        model: {
                                            providerID,
                                            modelID,
                                        },
                                        command: (shellPayload ?? slashShellPayload)!.command,
                                    });
                                } else if (commandPayload && commandPayload.command.toLowerCase() === 'compact') {
                                    await apiClient.session.summarize({
                                        sessionID: sessionId,
                                        ...(directory ? { directory } : {}),
                                        providerID,
                                        modelID,
                                    });
                                } else if (commandPayload) {
                                    await opencodeClient.sendCommand({
                                        id: sessionId,
                                        providerID,
                                        modelID,
                                        command: commandPayload.command,
                                        arguments: commandPayload.arguments,
                                        agent,
                                        variant,
                                        files: filePayloads.length > 0 ? filePayloads : undefined,
                                    });
                                } else {
                                    if (format) {
                                        console.info('[git-generation][browser] dispatch structured sendMessage', {
                                            sessionId,
                                            providerID,
                                            modelID,
                                            agent,
                                            variant,
                                            directory,
                                            formatType: format.type,
                                        });
                                    }
                                    await opencodeClient.sendMessage({
                                        id: sessionId,
                                        providerID,
                                        modelID,
                                        text: content,
                                        agent,
                                        variant,
                                        ...(format ? { format } : {}),
                                        files: filePayloads.length > 0 ? filePayloads : undefined,
                                        additionalParts: additionalPartsPayload && additionalPartsPayload.length > 0 ? additionalPartsPayload : undefined,
                                        agentMentions: agentMentionName ? [{ name: agentMentionName }] : undefined,
                                    });
                                }

                                if (filePayloads.length > 0) {
                                    try {
                                        useFileStore.getState().clearAttachedFiles();
                                    } catch (clearError) {
                                        console.error("Failed to clear attached files after send", clearError);
                                    }
                                }
                                set((state) => {
                                    const nextControllers = new Map(state.abortControllers);
                                    nextControllers.delete(sessionId);
                                    return { abortControllers: nextControllers };
                                });
                            } catch (error: any) {
                                let errorMessage = "Network error while sending message. The message may still be processing.";

                                if (error.name === "AbortError") {
                                    errorMessage = "Request timed out. The message may still be processing.";
                                } else if (error.message?.includes("504") || error.message?.includes("Gateway")) {
                                    errorMessage = "Gateway timeout - your message is being processed. Please wait for response.";
                                    set((state) => {
                                        const nextControllers = new Map(state.abortControllers);
                                        nextControllers.delete(sessionId);
                                        return { abortControllers: nextControllers };
                                    });
                                    return;
                                } else if (isLikelyProviderAuthFailure(error.message)) {
                                    errorMessage = PROVIDER_AUTH_FAILURE_MESSAGE;
                                } else if (error.message) {
                                    errorMessage = error.message;
                                }

                                set((state) => {
                                    const nextControllers = new Map(state.abortControllers);
                                    nextControllers.delete(sessionId);
                                    const nextUserMeta = new Map(state.pendingUserMessageMetaBySession);
                                    nextUserMeta.delete(sessionId);
                                    return { abortControllers: nextControllers, pendingUserMessageMetaBySession: nextUserMeta };
                                });

                                throw new Error(errorMessage);
                            }
                        } catch (error: any) {
                            let errorMessage = "Network error while sending message. The message may still be processing.";

                            if (error.name === "AbortError") {
                                errorMessage = "Request timed out. The message may still be processing.";
                            } else if (error.response?.status === 401) {
                                errorMessage = "Session not found or unauthorized. Please refresh the page.";
                            } else if (error.response?.status === 502) {
                                errorMessage = "OpenCode is restarting. Please wait a moment and try again.";
                            } else if (error.message?.includes("504") || error.message?.includes("Gateway")) {
                                errorMessage = "Gateway timeout - your message is being processed. Please wait for response.";
                            } else if (isLikelyProviderAuthFailure(error.message)) {
                                errorMessage = PROVIDER_AUTH_FAILURE_MESSAGE;
                            } else if (error.message) {
                                errorMessage = error.message;
                            }

                            set((state) => {
                                const nextControllers = new Map(state.abortControllers);
                                nextControllers.delete(sessionId);
                                const nextUserMeta = new Map(state.pendingUserMessageMetaBySession);
                                nextUserMeta.delete(sessionId);
                                return { abortControllers: nextControllers, pendingUserMessageMetaBySession: nextUserMeta };
                            });

                            throw new Error(errorMessage);
                        }
                    });
                },

                abortCurrentOperation: async (currentSessionId?: string) => {
                    if (!currentSessionId) {
                        return;
                    }

                    discardQueuedNonTextStreamingPartsForSession(currentSessionId);
                    discardQueuedPartDeltasForSession(currentSessionId);

                    const stateSnapshot = get();
                    const { abortControllers, messages: storeMessages } = stateSnapshot;

                    const controller = abortControllers.get(currentSessionId);
                    controller?.abort();

                    const activeIds = collectActiveMessageIdsForSession(stateSnapshot, currentSessionId);

                    if (activeIds.size === 0) {
                        const sessionMessages = currentSessionId ? storeMessages.get(currentSessionId) ?? [] : [];
                        let fallbackAssistantId: string | null = null;
                        for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
                            const message = sessionMessages[index];
                            if (!message || message.info.role !== 'assistant') {
                                continue;
                            }

                            if (!fallbackAssistantId) {
                                fallbackAssistantId = message.info.id;
                            }

                            const hasWorkingPart = (message.parts ?? []).some((part) => {
                                return part.type === 'reasoning' || part.type === 'tool' || part.type === 'step-start';
                            });
                            if (hasWorkingPart) {
                                activeIds.add(message.info.id);
                                break;
                            }
                        }

                        if (activeIds.size === 0 && fallbackAssistantId) {
                            activeIds.add(fallbackAssistantId);
                        }
                    }

                    for (const id of activeIds) {
                        const timeout = timeoutRegistry.get(id);
                        if (timeout) {
                            clearTimeout(timeout);
                            timeoutRegistry.delete(id);
                            lastContentRegistry.delete(id);
                        }
                    }

                    if (activeIds.size > 0) {
                        clearLifecycleTimersForIds(activeIds);
                    }

                    const abortTimestamp = Date.now();

                    set((state) => {
                        const updatedStates = removeLifecycleEntries(state.messageStreamStates, activeIds);

                        const sessionMessages = state.messages.get(currentSessionId) ?? [];
                        let messagesChanged = false;
                        let updatedMessages = state.messages;

                        if (sessionMessages.length > 0 && activeIds.size > 0) {
                            const updatedSessionMessages = sessionMessages.map((message) => {
                                if (!activeIds.has(message.info.id) && activeIds.size > 0) {
                                    return message;
                                }

                                const updatedParts = (message.parts ?? []).map((part) => {
                                    if (part.type === 'reasoning') {
                                        const reasoningPart = part as any;
                                        const time = { ...(reasoningPart.time ?? {}) };
                                        if (typeof time.end !== 'number') {
                                            time.end = abortTimestamp;
                                        }
                                        return {
                                            ...reasoningPart,
                                            time,
                                        } as Part;
                                    }

                                    if (part.type === 'tool') {
                                        const toolPart = part as any;
                                        const stateData = { ...(toolPart.state ?? {}) };
                                        if (stateData.status === 'running' || stateData.status === 'pending') {
                                            stateData.status = 'aborted';
                                        }
                                        return {
                                            ...toolPart,
                                            state: stateData,
                                        } as Part;
                                    }

                                    if (part.type === 'step-start') {
                                        const stepPart = part as any;
                                        return {
                                            ...stepPart,
                                            type: 'step-finish',
                                            aborted: true,
                                        } as Part;
                                    }

                                    return part;
                                });

                                messagesChanged = true;
                                return {
                                    ...message,
                                    info: {
                                        ...message.info,
                                        abortedAt: abortTimestamp,
                                        streaming: false,
                                        status: 'aborted',
                                    },
                                    parts: updatedParts,
                                };
                            });

                            if (messagesChanged) {
                                updatedMessages = new Map(state.messages);
                                updatedMessages.set(currentSessionId, updatedSessionMessages);
                            }
                        }
                        const memoryState = state.sessionMemoryState.get(currentSessionId);
                        let nextMemoryState = state.sessionMemoryState;
                        if (memoryState) {
                            const updatedMemory = new Map(state.sessionMemoryState);
                            updatedMemory.set(currentSessionId, {
                                ...memoryState,
                                isStreaming: false,
                                streamStartTime: undefined,
                                isZombie: false,
                            });
                            nextMemoryState = updatedMemory;
                        }

                        const nextAbortFlags = new Map(state.sessionAbortFlags);
                        nextAbortFlags.set(currentSessionId, {
                            timestamp: abortTimestamp,
                            acknowledged: false,
                        });

                        return {
                            messageStreamStates: updatedStates,
                            sessionMemoryState: nextMemoryState,
                            sessionAbortFlags: nextAbortFlags,
                            abortControllers: (() => {
                                const nextControllers = new Map(state.abortControllers);
                                nextControllers.delete(currentSessionId);
                                return nextControllers;
                            })(),
                            streamingMessageIds: setStreamingIdForSession(state.streamingMessageIds, currentSessionId, null),
                            ...(messagesChanged ? { messages: updatedMessages } : {}),
                        };
                    });

                    void opencodeClient.abortSession(currentSessionId).catch((error) => {
                        console.warn('Abort request failed:', error);
                    });
                },

                _addStreamingPartImmediate: (sessionId: string, messageId: string, part: Part, role?: string, currentSessionId?: string) => {
                    const stateSnapshot = get();
                    if (ignoredAssistantMessageIds.has(messageId)) {
                        return;
                    }

                    const existingMessagesSnapshot = stateSnapshot.messages.get(sessionId) || [];
                    const existingMessageSnapshotIndex = resolveSessionMessagePosition(sessionId, messageId, existingMessagesSnapshot);
                    const existingMessageSnapshot = existingMessageSnapshotIndex >= 0
                        ? existingMessagesSnapshot[existingMessageSnapshotIndex]
                        : undefined;

                    const actualRole = (() => {
                        if (role === 'user') return 'user';
                        if (existingMessageSnapshot?.info.role === 'user') return 'user';
                        return role || existingMessageSnapshot?.info.role || 'assistant';
                    })();

                    const memoryStateSnapshot = get().sessionMemoryState.get(sessionId);
                    if (memoryStateSnapshot?.streamStartTime) {
                        const streamDuration = Date.now() - memoryStateSnapshot.streamStartTime;
                        if (streamDuration > MEMORY_LIMITS.ZOMBIE_TIMEOUT) {
                            if (!memoryStateSnapshot.isZombie) {
                                set((state) => {
                                    const newMemoryState = new Map(state.sessionMemoryState);
                                    newMemoryState.set(sessionId, {
                                        ...memoryStateSnapshot,
                                        isZombie: true,
                                    });
                                    return { sessionMemoryState: newMemoryState };
                                });
                            }

                            setTimeout(() => {
                                const store = get();
                                store.completeStreamingMessage(sessionId, messageId);
                            }, 0);
                            (window as any).__messageTracker?.(messageId, 'skipped_zombie_stream');
                            return;
                        }
                    }

                    set((state) => {
                        const sessionMessages = state.messages.get(sessionId) || [];
                        const messagesArray = [...sessionMessages];
                        const updates: any = {};

                        const indexedSessions = upsertMessageSessionIndex(state.messageSessionIndex, messageId, sessionId);
                        if (indexedSessions !== state.messageSessionIndex) {
                            updates.messageSessionIndex = indexedSessions;
                        }

                        const finalizeAbortState = (result: Partial<MessageState>): Partial<MessageState> => {
                            const shouldClearAbortFlag =
                                (actualRole === 'assistant' || actualRole === 'user') &&
                                state.sessionAbortFlags.has(sessionId);
                            if (!shouldClearAbortFlag) {
                                return result;
                            }
                            const nextAbortFlags = new Map(state.sessionAbortFlags);
                            nextAbortFlags.delete(sessionId);
                            return {
                                ...result,
                                sessionAbortFlags: nextAbortFlags,
                            };
                        };

                        const maintainTimeouts = (text: string) => {
                            const value = text || '';
                            const lastContent = lastContentRegistry.get(messageId);

                            if (value && lastContent === value) {
                                const currentState = get();
                                if (isMessageStreamingInSession(currentState, sessionId, messageId)) {
                                    const existingTimeout = timeoutRegistry.get(messageId);
                                    if (existingTimeout) {
                                        clearTimeout(existingTimeout);
                                        timeoutRegistry.delete(messageId);
                                    }
                                    setTimeout(() => {
                                        const store = get();
                                        if (typeof store.forceCompleteMessage === "function") {
                                            store.forceCompleteMessage(sessionId, messageId, "timeout");
                                        }
                                        store.completeStreamingMessage(sessionId, messageId);
                                    }, 100);
                                }
                            }

                            lastContentRegistry.set(messageId, value);

                            const existingTimeout = timeoutRegistry.get(messageId);
                            if (existingTimeout) {
                                clearTimeout(existingTimeout);
                            }
                            const newTimeout = setTimeout(() => {
                                const store = get();
                                if (typeof store.forceCompleteMessage === "function") {
                                    store.forceCompleteMessage(sessionId, messageId, "timeout");
                                }
                                if (isMessageStreamingInSession(store, sessionId, messageId)) {
                                    store.completeStreamingMessage(sessionId, messageId);
                                }
                                timeoutRegistry.delete(messageId);
                                lastContentRegistry.delete(messageId);
                            }, 8000);
                            timeoutRegistry.set(messageId, newTimeout);
                        };

                        const isBackgroundSession = sessionId !== currentSessionId;
                        const memoryState = state.sessionMemoryState.get(sessionId);
                        if (isBackgroundSession && memoryState?.isStreaming) {
                            const newMemoryState = new Map(state.sessionMemoryState);
                            newMemoryState.set(sessionId, {
                                ...memoryState,
                                backgroundMessageCount: (memoryState.backgroundMessageCount || 0) + 1,
                            });
                            updates.sessionMemoryState = newMemoryState;
                        }

                        if (actualRole === 'assistant') {
                            const baseMemoryMap = updates.sessionMemoryState ?? state.sessionMemoryState;
                            const currentMemoryState = baseMemoryMap.get(sessionId);
                            if (currentMemoryState) {
                                const now = Date.now();
                                const nextMemoryState = new Map(baseMemoryMap);
                                nextMemoryState.set(sessionId, {
                                    ...currentMemoryState,
                                    isStreaming: true,
                                    streamStartTime: currentMemoryState.streamStartTime ?? now,
                                    lastAccessedAt: now,
                                    isZombie: false,
                                });
                                updates.sessionMemoryState = nextMemoryState;
                            }
                        }

                    const incomingText = extractTextFromPart(part);
                    if (isExecutionForkMetaText(incomingText)) {
                        (part as any).synthetic = true;
                    }
                    if (streamDebugEnabled() && actualRole === "assistant") {
                        try {
                            console.info("[STREAM-TRACE] part", {
                                messageId,
                                partId: (part as any)?.id,
                                role: actualRole,
                                type: (part as any)?.type || "text",
                                textLen: incomingText.length,
                                snapshotParts: existingMessagesSnapshot.length,
                            });
                        } catch { /* ignored */ }
                    }

                        const previousStreamingMap = updates.streamingMessageIds ?? state.streamingMessageIds;
                        if (actualRole === 'assistant') {
                            const nextStreamingMap = setStreamingIdForSession(previousStreamingMap, sessionId, messageId);
                            if (nextStreamingMap !== previousStreamingMap) {
                                updates.streamingMessageIds = nextStreamingMap;
                                (window as any).__messageTracker?.(messageId, 'streamingId_set_latest');
                            }
                        }

                        const messageIndex = resolveSessionMessagePosition(sessionId, messageId, messagesArray);

                        if (messageIndex !== -1 && actualRole === 'user') {
                            const existingMessage = messagesArray[messageIndex];
                            const existingPartIndex = findMatchingPartIndex(existingMessage.parts, part);

                            if ((part as any).synthetic === true) {
                                const incomingText = extractTextFromPart(part).trim();
                                const shouldKeep =
                                    incomingText.startsWith('User has requested to enter plan mode') ||
                                    incomingText.startsWith('The plan at ') ||
                                    incomingText.startsWith('The following tool was executed by the user');
                                if (!shouldKeep) {
                                    (window as any).__messageTracker?.(messageId, 'skipped_synthetic_user_part');
                                    return state;
                                }
                            }

                            const normalizedPart = normalizeStreamingPart(
                                part,
                                existingPartIndex !== -1 ? existingMessage.parts[existingPartIndex] : undefined
                            );
                            (window as any).__messageTracker?.(messageId, `user_part_type:${(normalizedPart as any).type || 'unknown'}`);

                            const updatedMessage = { ...existingMessage };
                            if (existingPartIndex !== -1) {
                                updatedMessage.parts = updatedMessage.parts.map((p, idx) =>
                                    idx === existingPartIndex ? normalizedPart : p
                                );
                            } else {
                                updatedMessage.parts = [...updatedMessage.parts, normalizedPart];
                            }

                            const updatedMessages = [...messagesArray];
                            updatedMessages[messageIndex] = updatedMessage;

                            const newMessages = new Map(state.messages);
                            newMessages.set(sessionId, updatedMessages);

                            return finalizeAbortState({ messages: newMessages, ...updates });
                        }

                        if (actualRole === 'assistant' && messageIndex !== -1) {

                            const existingMessage = messagesArray[messageIndex];
                            const existingPartIndex = findMatchingPartIndex(existingMessage.parts, part);

                            const normalizedPart = normalizeStreamingPart(
                                part,
                                existingPartIndex !== -1 ? existingMessage.parts[existingPartIndex] : undefined
                            );
                            (window as any).__messageTracker?.(messageId, `part_type:${(normalizedPart as any).type || 'unknown'}`);

                            const updatedMessage = { ...existingMessage };
                            if (existingPartIndex !== -1) {
                                updatedMessage.parts = updatedMessage.parts.map((p, idx) =>
                                    idx === existingPartIndex ? normalizedPart : p
                                );
                            } else {
                                updatedMessage.parts = [...updatedMessage.parts, normalizedPart];
                            }

                            const updatedMessages = [...messagesArray];
                            updatedMessages[messageIndex] = updatedMessage;

                            const newMessages = new Map(state.messages);
                            newMessages.set(sessionId, updatedMessages);

                            updates.messageStreamStates = touchStreamingLifecycle(state.messageStreamStates, messageId);
                            const nextStreamingMap = setStreamingIdForSession(updates.streamingMessageIds ?? state.streamingMessageIds, sessionId, messageId);
                            if (nextStreamingMap !== (updates.streamingMessageIds ?? state.streamingMessageIds)) {
                                updates.streamingMessageIds = nextStreamingMap;
                                (window as any).__messageTracker?.(messageId, 'streamingId_set');
                            }

                            if ((normalizedPart as any).type === 'text') {
                                maintainTimeouts((normalizedPart as any).text || '');
                            } else {
                                maintainTimeouts('');
                            }

                            return finalizeAbortState({ messages: newMessages, ...updates });
                        }

                        if (messageIndex === -1) {

                            if (actualRole === 'user') {

                                if ((part as any).synthetic === true) {
                                    const incomingText = extractTextFromPart(part).trim();
                                    const shouldKeep =
                                        incomingText.startsWith('User has requested to enter plan mode') ||
                                        incomingText.startsWith('The plan at ') ||
                                        incomingText.startsWith('The following tool was executed by the user');
                                    if (!shouldKeep) {
                                        (window as any).__messageTracker?.(messageId, 'skipped_synthetic_new_user_part');
                                        return state;
                                    }
                                }

                                const normalizedPart = normalizeStreamingPart(part);
                                (window as any).__messageTracker?.(messageId, `new_user_part_type:${(normalizedPart as any).type || 'unknown'}`);

                                const pendingMeta = state.pendingUserMessageMetaBySession.get(sessionId);
                                const contextStore = useContextStore.getState();
                                const sessionAgent =
                                    pendingMeta?.mode ??
                                    contextStore.getSessionAgentSelection(sessionId) ??
                                    contextStore.getCurrentAgent(sessionId);
                                const agentMode = typeof sessionAgent === 'string' && sessionAgent.trim().length > 0
                                    ? sessionAgent.trim()
                                    : undefined;
                                const providerID = pendingMeta?.providerID ?? (state.lastUsedProvider?.providerID || undefined);
                                const modelID = pendingMeta?.modelID ?? (state.lastUsedProvider?.modelID || undefined);

                                if (pendingMeta) {
                                    updates.pendingUserMessageMetaBySession = cleanupPendingUserMessageMeta(state.pendingUserMessageMetaBySession, sessionId);
                                }

                                const newUserMessage = {
                                    info: {
                                        id: messageId,
                                        sessionID: sessionId,
                                        role: 'user' as const,
                                        clientRole: 'user',
                                        userMessageMarker: true,
                                        ...(agentMode ? { mode: agentMode } : {}),
                                        ...(providerID ? { providerID } : {}),
                                        ...(modelID ? { modelID } : {}),
                                        time: {
                                            created: Date.now(),
                                        },
                                    },
                                    parts: [normalizedPart],
                                };

                                const updatedMessages = [...messagesArray, newUserMessage];

                                updatedMessages.sort((a, b) => {
                                    const aTime = (a.info as any)?.time?.created || 0;
                                    const bTime = (b.info as any)?.time?.created || 0;
                                    return aTime - bTime;
                                });

                                const newMessages = new Map(state.messages);
                                newMessages.set(sessionId, updatedMessages);
                                primeSessionMessagePositionIndex(sessionId, updatedMessages);

                                return finalizeAbortState({ messages: newMessages, ...updates });
                            }

                            if ((part as any)?.type === 'text') {
                                const textIncoming = extractTextFromPart(part).trim();
                                if (textIncoming.length > 0) {
                                    const latestUser = [...messagesArray]
                                        .reverse()
                                        .find((m) => m.info.role === 'user');
                                    if (latestUser) {
                                        const latestUserText = latestUser.parts.map((p) => extractTextFromPart(p)).join('').trim();
                                        if (latestUserText.length > 0 && latestUserText === textIncoming) {
                                            // Cap ignoredAssistantMessageIds size — it's only relevant for active streaming
                                            if (ignoredAssistantMessageIds.size > 1000) {
                                                ignoredAssistantMessageIds.clear();
                                            }
                                            ignoredAssistantMessageIds.add(messageId);
                                            (window as any).__messageTracker?.(messageId, 'ignored_assistant_echo');
                                            return state;
                                        }
                                    }
                                }
                            }

                            const pendingEntry = state.pendingAssistantParts.get(messageId);
                            const pendingParts = pendingEntry ? [...pendingEntry.parts] : [];
                            const pendingIndex = findMatchingPartIndex(pendingParts, part);
                            const existingPendingPart = pendingIndex !== -1 ? pendingParts[pendingIndex] : undefined;
                            const normalizedPart = normalizeStreamingPart(part, existingPendingPart);
                            (window as any).__messageTracker?.(messageId, `part_type:${(normalizedPart as any).type || 'unknown'}`);

                            if ((normalizedPart as any).type === 'text') {
                                maintainTimeouts((normalizedPart as any).text || '');
                            } else {
                                maintainTimeouts('');
                            }

                            if (pendingIndex !== -1) {
                                const normalizedRecord = normalizedPart as Record<string, unknown>;
                                if (
                                    normalizedRecord.type === 'tool' &&
                                    typeof existingPendingPart?.id === 'string' &&
                                    existingPendingPart.id.length > 0
                                ) {
                                    normalizedRecord.id = existingPendingPart.id;
                                }
                                pendingParts[pendingIndex] = normalizedRecord as Part;
                            } else {
                                pendingParts.push(normalizedPart);
                            }

                            const newPending = new Map(state.pendingAssistantParts);
                            newPending.set(messageId, { sessionId, parts: pendingParts });

                            const providerID = state.lastUsedProvider?.providerID || "";
                            const modelID = state.lastUsedProvider?.modelID || "";
                            const now = Date.now();
                            const cwd = opencodeClient.getDirectory() ?? "/";
                            const contextStore = useContextStore.getState();
                            const sessionAgent = contextStore.getSessionAgentSelection(sessionId)
                                ?? contextStore.getCurrentAgent(sessionId);
                            const agentMode = typeof sessionAgent === "string" && sessionAgent.trim().length > 0
                                ? sessionAgent.trim()
                                : undefined;

                            const placeholderInfo = (actualRole === "user"
                                ? {
                                    id: messageId,
                                    sessionID: sessionId,
                                    role: "user",
                                    time: { created: now },
                                    agent: agentMode || "default",
                                    model: { providerID, modelID },
                                    clientRole: actualRole,
                                    animationSettled: undefined,
                                    streaming: undefined,
                                }
                                : {
                                    id: messageId,
                                    sessionID: sessionId,
                                    role: "assistant",
                                    time: { created: now },
                                    parentID: messageId,
                                    modelID,
                                    providerID,
                                    mode: agentMode || "default",
                                    path: { cwd, root: cwd },
                                    cost: 0,
                                    tokens: {
                                        input: 0,
                                        output: 0,
                                        reasoning: 0,
                                        cache: { read: 0, write: 0 },
                                    },
                                    clientRole: actualRole,
                                    animationSettled: false,
                                    streaming: true,
                                }) as unknown as Message;

                            const placeholderMessage = {
                                info: placeholderInfo,
                                parts: pendingParts,
                            };

                            const nextMessages = [...messagesArray, placeholderMessage];

                            const newMessages = new Map(state.messages);
                            newMessages.set(sessionId, nextMessages);
                            updateSessionMessagePositionEntry(sessionId, messageId, nextMessages.length - 1);

                            if (actualRole === 'assistant') {
                                updates.messageStreamStates = touchStreamingLifecycle(state.messageStreamStates, messageId);

                                const nextStreamingMap = setStreamingIdForSession(updates.streamingMessageIds ?? state.streamingMessageIds, sessionId, messageId);
                                if (nextStreamingMap !== (updates.streamingMessageIds ?? state.streamingMessageIds)) {
                                    updates.streamingMessageIds = nextStreamingMap;
                                    (window as any).__messageTracker?.(messageId, 'streamingId_set');
                                }
                            }

                            return finalizeAbortState({
                                messages: newMessages,
                                pendingAssistantParts: newPending,
                                ...updates,
                            });
                        } else {

                            const existingMessage = messagesArray[messageIndex];
                            const existingPartIndex = findMatchingPartIndex(existingMessage.parts, part);
                            const existingPart = existingPartIndex !== -1 ? existingMessage.parts[existingPartIndex] : undefined;

                            const normalizedPart = normalizeStreamingPart(
                                part,
                                existingPart
                            );
                            if (
                                (normalizedPart as Record<string, unknown>).type === 'tool' &&
                                typeof existingPart?.id === 'string' &&
                                existingPart.id.length > 0
                            ) {
                                (normalizedPart as Record<string, unknown>).id = existingPart.id;
                            }
                            (window as any).__messageTracker?.(messageId, `part_type:${(normalizedPart as any).type || 'unknown'}`);

                            const updatedMessage = { ...existingMessage };
                            if (existingPartIndex !== -1) {
                                updatedMessage.parts = updatedMessage.parts.map((p, idx) =>
                                    idx === existingPartIndex ? normalizedPart : p
                                );
                            } else {
                                updatedMessage.parts = [...updatedMessage.parts, normalizedPart];
                            }

                            const updatedMessages = [...messagesArray];
                            updatedMessages[messageIndex] = updatedMessage;

                            const newMessages = new Map(state.messages);
                            newMessages.set(sessionId, updatedMessages);

                            if (updatedMessage.info.role === "assistant") {
                                updates.messageStreamStates = touchStreamingLifecycle(state.messageStreamStates, messageId);
                                const nextStreamingMap = setStreamingIdForSession(updates.streamingMessageIds ?? state.streamingMessageIds, sessionId, messageId);
                                if (nextStreamingMap !== (updates.streamingMessageIds ?? state.streamingMessageIds)) {
                                    updates.streamingMessageIds = nextStreamingMap;
                                    (window as any).__messageTracker?.(messageId, 'streamingId_set');
                                }
                            }

                            if ((normalizedPart as any).type === 'text') {
                                maintainTimeouts((normalizedPart as any).text || '');
                            } else {
                                maintainTimeouts('');
                            }

                            return finalizeAbortState({ messages: newMessages, ...updates });
                        }
                    });
                },

                addStreamingPart: (sessionId: string, messageId: string, part: Part, role?: string, currentSessionId?: string) => {
                    if (!ENABLE_STREAMING_FRAME_BATCHING) {
                        get()._addStreamingPartImmediate(sessionId, messageId, part, role, currentSessionId);
                        return;
                    }

                    if (!shouldBatchStreamingPart(part)) {
                        get()._addStreamingPartImmediate(sessionId, messageId, part, role, currentSessionId);
                        return;
                    }

                    enqueueNonTextStreamingPart({
                        sessionId,
                        messageId,
                        part,
                        role,
                        currentSessionId,
                    });

                    const flushQueuedParts = () => {
                        flushQueuedNonTextStreamingParts(get()._addStreamingPartImmediate);
                    };

                    if (queuedNonTextStreamingPartOrder.length >= NON_TEXT_STREAMING_QUEUE_HARD_LIMIT) {
                        flushQueuedParts();
                        return;
                    }

                    scheduleNonTextStreamingFlush(flushQueuedParts);
                },

                _applyPartDeltaImmediate: (sessionId: string, messageId: string, partId: string, field: string, delta: string, role?: string, currentSessionId?: string) => {
                    set((state) => {
                        const sessionMessages = state.messages.get(sessionId) || [];
                        const messageIndex = resolveSessionMessagePosition(sessionId, messageId, sessionMessages);
                        if (messageIndex === -1) {
                            return state;
                        }

                        const targetMessage = sessionMessages[messageIndex];
                        const partIndex = targetMessage.parts.findIndex((part) => part?.id === partId);
                        if (partIndex === -1) {
                            return state;
                        }

                        const existingPart = targetMessage.parts[partIndex] as Record<string, unknown>;
                        const existingField = existingPart[field];

                        const nextFieldValue = `${typeof existingField === 'string' ? existingField : ''}${delta}`;
                        const nextPart: Record<string, unknown> = {
                            ...existingPart,
                            [field]: nextFieldValue,
                        };

                        const updatedParts = [...targetMessage.parts];
                        updatedParts[partIndex] = nextPart as Part;

                        const updatedMessage = {
                            ...targetMessage,
                            parts: updatedParts,
                        };

                        const updatedSessionMessages = [...sessionMessages];
                        updatedSessionMessages[messageIndex] = updatedMessage;

                        const nextMessages = new Map(state.messages);
                        nextMessages.set(sessionId, updatedSessionMessages);

                        const actualRole = (() => {
                            if (role === 'user') return 'user';
                            if (updatedMessage.info.role === 'user') return 'user';
                            return role || updatedMessage.info.role || 'assistant';
                        })();

                        const updates: Partial<MessageState> = {
                            messages: nextMessages,
                        };

                        if (streamDebugEnabled() && actualRole === 'assistant') {
                            try {
                                const previousText = extractTextFromPart(existingPart as Part);
                                const nextText = extractTextFromPart(nextPart as Part);
                                console.info('[STREAM-TRACE] delta_apply', {
                                    messageId,
                                    partId,
                                    field,
                                    deltaLen: delta.length,
                                    prevFieldLen: typeof existingField === 'string' ? existingField.length : 0,
                                    nextFieldLen: nextFieldValue.length,
                                    prevTextLen: previousText.length,
                                    nextTextLen: nextText.length,
                                    partType: typeof existingPart.type === 'string' ? existingPart.type : 'unknown',
                                });
                            } catch {
                                // ignore debug log failures
                            }
                        }

                        if (actualRole === 'assistant') {
                            updates.messageStreamStates = touchStreamingLifecycle(state.messageStreamStates, messageId);
                            const effectiveCurrent = currentSessionId || sessionId;
                            const nextStreamingMap = setStreamingIdForSession(state.streamingMessageIds, sessionId, messageId);
                            if (nextStreamingMap !== state.streamingMessageIds) {
                                updates.streamingMessageIds = nextStreamingMap;
                            }

                            if (effectiveCurrent !== sessionId) {
                                const memoryState = state.sessionMemoryState.get(sessionId);
                                if (memoryState) {
                                    const now = Date.now();
                                    const nextMemoryState = new Map(state.sessionMemoryState);
                                    nextMemoryState.set(sessionId, {
                                        ...memoryState,
                                        isStreaming: true,
                                        streamStartTime: memoryState.streamStartTime ?? now,
                                        lastAccessedAt: now,
                                        isZombie: false,
                                    });
                                    updates.sessionMemoryState = nextMemoryState;
                                }
                            }
                        }

                        return updates;
                    });
                },

                applyPartDelta: (sessionId: string, messageId: string, partId: string, field: string, delta: string, role?: string, currentSessionId?: string) => {
                    if (!ENABLE_STREAMING_FRAME_BATCHING) {
                        get()._applyPartDeltaImmediate(sessionId, messageId, partId, field, delta, role, currentSessionId);
                        return;
                    }

                    if (!shouldBatchPartDelta(get().messages, sessionId, messageId, partId)) {
                        get()._applyPartDeltaImmediate(sessionId, messageId, partId, field, delta, role, currentSessionId);
                        return;
                    }

                    enqueuePartDelta({
                        sessionId,
                        messageId,
                        partId,
                        field,
                        delta,
                        role,
                        currentSessionId,
                    });

                    const flushQueuedDeltas = () => {
                        flushQueuedPartDeltas(get()._applyPartDeltaImmediate);
                    };

                    if (queuedPartDeltaOrder.length >= PART_DELTA_QUEUE_HARD_LIMIT) {
                        flushQueuedDeltas();
                        return;
                    }

                    schedulePartDeltaFlush(flushQueuedDeltas);
                },

                forceCompleteMessage: (sessionId: string | null | undefined, messageId: string, source: "timeout" | "cooldown" = "timeout") => {
                    const resolveSessionId = (state: MessageState): string | null => {
                        if (sessionId) {
                            return sessionId;
                        }
                        const indexedSession = state.messageSessionIndex.get(messageId);
                        if (indexedSession) {
                            return indexedSession;
                        }
                        for (const [candidateId, sessionMessages] of state.messages.entries()) {
                            if (sessionMessages.some((msg) => msg.info.id === messageId)) {
                                return candidateId;
                            }
                        }
                        return null;
                    };

                    set((state) => {
                        const targetSessionId = resolveSessionId(state);
                        if (!targetSessionId) {
                            return state;
                        }

                        const sessionMessages = state.messages.get(targetSessionId) ?? [];
                        const messageIndex = resolveSessionMessagePosition(targetSessionId, messageId, sessionMessages);
                        if (messageIndex === -1) {
                            return state;
                        }

                        const message = sessionMessages[messageIndex];
                        if (!message) {
                            return state;
                        }

                        const now = Date.now();
                        const existingInfo = message.info as any;
                        const existingCompleted = typeof existingInfo?.time?.completed === "number" && existingInfo.time.completed > 0;

                        let infoChanged = false;
                        const updatedInfo: Record<string, any> = { ...existingInfo };

                        if (!existingCompleted) {
                            updatedInfo.time = {
                                ...(existingInfo.time ?? {}),
                                completed: now,
                            };
                            infoChanged = true;
                        }

                        if (updatedInfo.status !== "completed") {
                            updatedInfo.status = "completed";
                            infoChanged = true;
                        }

                        if (updatedInfo.streaming) {
                            updatedInfo.streaming = false;
                            infoChanged = true;
                        }

                        let partsChanged = false;
                        const updatedParts = message.parts.map((part) => {
                            if (!part) {
                                return part;
                            }

                            if (part.type === "tool") {
                                const existingState = (part as any).state;
                                if (!existingState) {
                                    return part;
                                }

                                const status = existingState.status;
                                const needsStatusUpdate = status === "running" || status === "pending" || status === "started";
                                const needsEndTimestamp = !existingState.time || typeof existingState.time?.end !== "number";

                                if (needsStatusUpdate || needsEndTimestamp) {
                                    const nextState: Record<string, any> = { ...existingState };
                                    if (needsStatusUpdate) {
                                        nextState.status = "completed";
                                    }
                                    if (needsEndTimestamp) {
                                        nextState.time = {
                                            ...(existingState.time ?? {}),
                                            end: now,
                                        };
                                    }
                                    partsChanged = true;
                                    return {
                                        ...part,
                                        state: nextState,
                                    } as Part;
                                }
                                return part;
                            }

                            if (part.type === "reasoning") {
                                const reasoningTime = (part as any).time;
                                if (!reasoningTime || typeof reasoningTime.end !== "number") {
                                    partsChanged = true;
                                    return {
                                        ...part,
                                        time: {
                                            ...(reasoningTime ?? {}),
                                            end: now,
                                        },
                                    } as Part;
                                }
                                return part;
                            }

                            if (part.type === "text") {
                                const textTime = (part as any).time;
                                if (textTime && typeof textTime.end !== "number") {
                                    partsChanged = true;
                                    return {
                                        ...part,
                                        time: {
                                            ...textTime,
                                            end: now,
                                        },
                                    } as Part;
                                }
                                return part;
                            }

                            return part;
                        });

                        if (!infoChanged && !partsChanged) {
                            return state;
                        }

                        (window as any).__messageTracker?.(messageId, `force_complete:${source}`);

                        const updatedMessage = {
                            ...message,
                            info: updatedInfo as Message,
                            parts: partsChanged ? updatedParts : message.parts,
                        };

                        const nextSessionMessages = [...sessionMessages];
                        nextSessionMessages[messageIndex] = updatedMessage;

                        const nextMessages = new Map(state.messages);
                        nextMessages.set(targetSessionId, nextSessionMessages);

                        return { messages: nextMessages };
                    });
                },

                markMessageStreamSettled: (messageId: string) => {
                    set((state) => {

                        clearLifecycleCompletionTimer(messageId);
                        const next = new Map(state.messageStreamStates);
                        next.delete(messageId);

                        let updatedMessages = state.messages;
                        let messagesModified = false;
                        const indexedSessionId = state.messageSessionIndex.get(messageId);
                        const sessionIdCandidates = indexedSessionId
                            ? [
                                indexedSessionId,
                                ...Array.from(state.messages.keys()).filter((sessionId) => sessionId !== indexedSessionId),
                            ]
                            : Array.from(state.messages.keys());

                        for (const sessionId of sessionIdCandidates) {
                            const sessionMessages = state.messages.get(sessionId);
                            if (!sessionMessages) {
                                continue;
                            }
                            const idx = resolveSessionMessagePosition(sessionId, messageId, sessionMessages);
                            if (idx === -1) {
                                continue;
                            }

                            const message = sessionMessages[idx];
                            if ((message.info as any)?.animationSettled) {
                                break;
                            }

                            const updatedMessage = {
                                ...message,
                                info: {
                                    ...message.info,
                                    animationSettled: true,
                                },
                            };

                            const sessionArray = [...sessionMessages];
                            sessionArray[idx] = updatedMessage;

                            const newMessages = new Map(state.messages);
                            newMessages.set(sessionId, sessionArray);
                            updatedMessages = newMessages;
                            messagesModified = true;
                            break;
                        }

                        const updates: Partial<MessageState> & { messageStreamStates: Map<string, MessageStreamLifecycle> } = {
                            messageStreamStates: next,
                            ...(messagesModified ? { messages: updatedMessages } : {}),
                        } as any;

                        return updates;
                    });
                    clearLifecycleTimersForIds([messageId]);
                },

                updateMessageInfo: (sessionId: string, messageId: string, messageInfo: any) => {
                    set((state) => {
                        const sessionMessages = state.messages.get(sessionId) ?? [];
                        const normalizedSessionMessages = [...sessionMessages];

                        const messageIndex = resolveSessionMessagePosition(sessionId, messageId, normalizedSessionMessages);
                        const pendingEntry = state.pendingAssistantParts.get(messageId);

                        const ensureClientRole = (info: any) => {
                            if (!info) {
                                return info;
                            }
                            return normalizeMessageInfoForProjection(info as Message) as any;
                        };

                        if (messageIndex === -1) {
                            if (process.env.NODE_ENV === 'development') {
                                console.info("[MESSAGE-DEBUG] updateMessageInfo: messageIndex === -1", {
                                    sessionId,
                                    messageId,
                                    messageInfo,
                                    existingCount: normalizedSessionMessages.length,
                                });
                            }

                            if (normalizedSessionMessages.length > 0) {
                                const firstMessage = normalizedSessionMessages[0];
                                const firstInfo = firstMessage?.info as any;
                                const firstCreated = typeof firstInfo?.time?.created === 'number' ? firstInfo.time.created : null;
                                const firstId = typeof firstInfo?.id === 'string' ? firstInfo.id : null;

                                const incomingInfoToCompare = messageInfo as any;
                                const incomingCreated = typeof incomingInfoToCompare?.time?.created === 'number'
                                    ? incomingInfoToCompare.time.created
                                    : null;
                                const incomingId = typeof incomingInfoToCompare?.id === 'string' ? incomingInfoToCompare.id : messageId;

                                let isOlderThanViewport = false;
                                if (incomingCreated !== null && firstCreated !== null) {
                                    isOlderThanViewport = incomingCreated < firstCreated;
                                }
                                if (!isOlderThanViewport && incomingId && firstId) {
                                    isOlderThanViewport = incomingId.localeCompare(firstId) < 0;
                                }

                                if (isOlderThanViewport) {
                                    (window as any).__messageTracker?.(messageId, 'skipped_evicted_message_update');
                                    return state;
                                }
                            }

                            const incomingInfo = ensureClientRole(messageInfo);

                            if (incomingInfo && incomingInfo.role === 'user') {
                                const pendingParts = pendingEntry?.parts ?? [];
                                const pendingMeta = state.pendingUserMessageMetaBySession.get(sessionId);
                                const newUserMessage = {
                                    info: {
                                        ...incomingInfo,
                                        userMessageMarker: true,
                                        clientRole: 'user',
                                        ...(pendingMeta?.mode ? { mode: pendingMeta.mode } : {}),
                                        ...(pendingMeta?.providerID ? { providerID: pendingMeta.providerID } : {}),
                                        ...(pendingMeta?.modelID ? { modelID: pendingMeta.modelID } : {}),
                                    } as Message,
                                    parts: pendingParts.length > 0 ? [...pendingParts] : [],
                                };

                                const newMessages = new Map(state.messages);

                                const appended = [...normalizedSessionMessages, newUserMessage];

                                appended.sort((a, b) => {
                                    const aTime = (a.info as any)?.time?.created || 0;
                                    const bTime = (b.info as any)?.time?.created || 0;
                                    return aTime - bTime;
                                });
                                newMessages.set(sessionId, appended);
                                primeSessionMessagePositionIndex(sessionId, appended);

                                const updates: Partial<MessageState> = {
                                    messages: newMessages,
                              ...(pendingMeta
                                 ? {
                                      pendingUserMessageMetaBySession: cleanupPendingUserMessageMeta(state.pendingUserMessageMetaBySession, sessionId),
                                  }
                                 : {}),
                                };

                                const nextIndex = upsertMessageSessionIndex(
                                    updates.messageSessionIndex ?? state.messageSessionIndex,
                                    messageId,
                                    sessionId
                                );
                                if (nextIndex !== (updates.messageSessionIndex ?? state.messageSessionIndex)) {
                                    updates.messageSessionIndex = nextIndex;
                                }

                                if (pendingEntry) {
                                    const newPending = new Map(state.pendingAssistantParts);
                                    newPending.delete(messageId);
                                    updates.pendingAssistantParts = newPending;
                                }

                                return updates;
                            }

                            if (!incomingInfo || incomingInfo.role !== 'assistant') {
                                return state;
                            }

                            const pendingParts = pendingEntry?.parts ?? [];

                            const newMessage = {
                                info: {
                                    ...incomingInfo,
                                    animationSettled: (incomingInfo as any)?.animationSettled ?? false,
                                } as Message,
                                parts: pendingParts.length > 0 ? [...pendingParts] : [],
                            };

                            const newMessages = new Map(state.messages);

                            const appended = [...normalizedSessionMessages, newMessage];
                            newMessages.set(sessionId, appended);
                            updateSessionMessagePositionEntry(sessionId, messageId, appended.length - 1);

                            const updates: Partial<MessageState> = {
                                messages: newMessages,
                            };

                            const nextIndex = upsertMessageSessionIndex(
                                updates.messageSessionIndex ?? state.messageSessionIndex,
                                messageId,
                                sessionId
                            );
                            if (nextIndex !== (updates.messageSessionIndex ?? state.messageSessionIndex)) {
                                updates.messageSessionIndex = nextIndex;
                            }

                            if (pendingEntry) {
                                const newPending = new Map(state.pendingAssistantParts);
                                newPending.delete(messageId);
                                updates.pendingAssistantParts = newPending;
                            }

                            return updates;
                        }

                        const existingMessage = normalizedSessionMessages[messageIndex];

                        const existingInfo = existingMessage.info as any;
                        const isUserMessage =
                            existingInfo.userMessageMarker === true ||
                            existingInfo.clientRole === 'user' ||
                            existingInfo.role === 'user';

                         if (isUserMessage) {
 
                             const updatedInfo = {
                                 ...existingMessage.info,
                                 ...messageInfo,
 
                                 role: 'user',
                                 clientRole: 'user',
                                 userMessageMarker: true,
 
                                 providerID: existingInfo.providerID || undefined,
                                 modelID: existingInfo.modelID || undefined,
                             } as any;

                             const pendingMeta = state.pendingUserMessageMetaBySession.get(sessionId);
                             if (pendingMeta && !updatedInfo.mode && pendingMeta.mode) {
                                 updatedInfo.mode = pendingMeta.mode;
                             }
 
                             const updatedMessage = {
                                 ...existingMessage,
                                 info: updatedInfo
                             };
 
                             const newMessages = new Map(state.messages);
                             const updatedSessionMessages = [...normalizedSessionMessages];
                             updatedSessionMessages[messageIndex] = updatedMessage;
                             newMessages.set(sessionId, updatedSessionMessages);

                             if (pendingMeta) {
                                 const nextPending = new Map(state.pendingUserMessageMetaBySession);
                                 nextPending.delete(sessionId);
                                 return { messages: newMessages, pendingUserMessageMetaBySession: nextPending };
                             }
 
                             return { messages: newMessages };
                         }


                        const updatedInfo = {
                            ...existingMessage.info,
                            ...messageInfo,
                        } as any;

                        if (messageInfo.role && messageInfo.role !== existingMessage.info.role) {
                            updatedInfo.role = existingMessage.info.role;
                        }

                        updatedInfo.clientRole = updatedInfo.clientRole ?? existingMessage.info.clientRole ?? existingMessage.info.role;
                        if (updatedInfo.clientRole === "user") {
                            updatedInfo.userMessageMarker = true;
                        }

                        const updatedMessage = {
                            ...existingMessage,
                            info: updatedInfo,
                            parts: existingMessage.parts,
                        };

                        const newMessages = new Map(state.messages);
                        const updatedSessionMessages = [...normalizedSessionMessages];
                        updatedSessionMessages[messageIndex] = updatedMessage;
                        newMessages.set(sessionId, updatedSessionMessages);

                        const updates: Partial<MessageState> = {
                            messages: newMessages,
                        };

                        if (pendingEntry) {
                            const newPending = new Map(state.pendingAssistantParts);
                            newPending.delete(messageId);
                            updates.pendingAssistantParts = newPending;
                        }

                        return updates;
                    });

                    // Trigger completion when info.finish is present for assistant messages
                    const infoFinish = (messageInfo as { finish?: string })?.finish;
                    const messageRole = (messageInfo as { role?: string })?.role;
                    if (typeof infoFinish === 'string' && messageRole !== 'user') {
                        setTimeout(() => {
                            const store = get();
                            store.completeStreamingMessage(sessionId, messageId);
                        }, 0);
                    }
                },

                completeStreamingMessage: (sessionId: string, messageId: string) => {
                    flushQueuedNonTextStreamingPartsForMessage(get()._addStreamingPartImmediate, sessionId, messageId);
                    flushQueuedPartDeltasForMessage(get()._applyPartDeltaImmediate, sessionId, messageId);

                    const state = get();

                    (window as any).__messageTracker?.(
                        messageId,
                        `completion_called_current:${state.streamingMessageIds.get(sessionId) ?? 'none'}`
                    );

                    if (typeof state.forceCompleteMessage === "function") {
                        state.forceCompleteMessage(sessionId, messageId, "cooldown");
                    }

                    const shouldClearStreamingId = state.streamingMessageIds.get(sessionId) === messageId;
                    if (shouldClearStreamingId) {
                        (window as any).__messageTracker?.(messageId, 'streamingId_cleared');
                    } else {
                        (window as any).__messageTracker?.(messageId, 'streamingId_NOT_cleared_different_id');
                    }

                    const updates: Record<string, any> = {};
                    if (shouldClearStreamingId) {
                        updates.streamingMessageIds = setStreamingIdForSession(state.streamingMessageIds, sessionId, null);
                        updates.abortControllers = (() => {
                            const next = new Map(state.abortControllers);
                            next.delete(sessionId);
                            return next;
                        })();
                    }

                    if (state.messageStreamStates.has(messageId)) {
                        const next = new Map(state.messageStreamStates);
                        next.delete(messageId);
                        updates.messageStreamStates = next;
                    }

                    if (Object.keys(updates).length > 0) {
                        set(updates);
                    }

                    if (state.pendingAssistantParts.has(messageId)) {
                        set((currentState) => {
                            if (!currentState.pendingAssistantParts.has(messageId)) {
                                return currentState;
                            }
                            const nextPending = new Map(currentState.pendingAssistantParts);
                            nextPending.delete(messageId);
                            return { pendingAssistantParts: nextPending };
                        });
                    }

                    clearLifecycleTimersForIds([messageId]);

                    let startedCooldown = false;
                    set((state) => {
                        const memoryState = state.sessionMemoryState.get(sessionId);
                        if (!memoryState || !memoryState.isStreaming) return state;

                        const newMemoryState = new Map(state.sessionMemoryState);
                        const now = Date.now();
                        const updatedMemory: SessionMemoryState = {
                            ...memoryState,
                            isStreaming: false,
                            streamStartTime: undefined,
                            isZombie: false,
                            lastAccessedAt: now,
                            streamingCooldownUntil: now + 2000,
                        };
                        newMemoryState.set(sessionId, updatedMemory);
                        startedCooldown = true;
                        return { sessionMemoryState: newMemoryState };
                    });

                    if (startedCooldown) {
                        const existingTimer = streamingCooldownTimers.get(sessionId);
                        if (existingTimer) {
                            clearTimeout(existingTimer);
                            streamingCooldownTimers.delete(sessionId);
                        }

                        const timeoutId = setTimeout(() => {
                            set((state) => {
                                const memoryState = state.sessionMemoryState.get(sessionId);
                                if (!memoryState) return state;

                                if (memoryState.isStreaming) {
                                    return state;
                                }

                                const nextMemoryState = new Map(state.sessionMemoryState);
                                const { streamingCooldownUntil: _streamingCooldownUntil, ...rest } = memoryState;
                                void _streamingCooldownUntil;
                                nextMemoryState.set(sessionId, rest as SessionMemoryState);
                                return { sessionMemoryState: nextMemoryState };
                            });
                            streamingCooldownTimers.delete(sessionId);
                        }, 2000);

                        streamingCooldownTimers.set(sessionId, timeoutId);
                    }
                },

                syncMessages: (
                    sessionId: string,
                    messages: { info: Message; parts: Part[] }[],
                    options?: { replace?: boolean }
                ) => {
                    flushQueuedNonTextStreamingPartsForSession(get()._addStreamingPartImmediate, sessionId);
                    flushQueuedPartDeltasForSession(get()._applyPartDeltaImmediate, sessionId);

                    // Filter out reverted messages first
                    const revertMessageId = getSessionRevertMessageId(sessionId);
                    const messagesWithoutReverted = filterMessagesByRevertPoint(messages, revertMessageId);

                    const messagesFiltered = messagesWithoutReverted;
                    const shouldReplace = options?.replace === true;

                    set((state) => {
                        const newMessages = new Map(state.messages);
                        const previousMessages = state.messages.get(sessionId) || [];
                        const normalizedIncomingMessages = messagesFiltered.map((message) => {
                            const infoWithMarker = {
                                ...normalizeMessageInfoForProjection(message.info as Message),
                                animationSettled:
                                    message.info.role === "assistant"
                                        ? (message.info as any)?.animationSettled ?? true
                                        : (message.info as any)?.animationSettled,
                            } as any;

                            const serverParts = (Array.isArray(message.parts) ? message.parts : []).map((part) => {
                                if (part?.type === 'text') {
                                    const raw = (part as any).text ?? (part as any).content ?? '';
                                    if (isExecutionForkMetaText(raw)) {
                                        return { ...part, synthetic: true } as Part;
                                    }
                                }
                                return part;
                            });
                            return {
                                ...message,
                                info: infoWithMarker,
                                parts: serverParts,
                            };
                        });

                        const incomingIds = new Set(
                            normalizedIncomingMessages
                                .map((message) => (message?.info as { id?: unknown })?.id)
                                .filter((id): id is string => typeof id === 'string' && id.length > 0)
                        );

                        const existingOnlyMessages = shouldReplace
                            ? []
                            : previousMessages.filter((message) => {
                                const id = (message?.info as { id?: unknown })?.id;
                                return typeof id === 'string' && id.length > 0 ? !incomingIds.has(id) : true;
                            });

                        const mergedMessages = dedupeMessagesById([
                            ...existingOnlyMessages,
                            ...normalizedIncomingMessages,
                        ]).sort(compareMessageEntriesChronologically);

                        const previousIds = new Set(previousMessages.map((msg) => msg.info.id));
                        const nextIds = new Set(mergedMessages.map((msg) => msg.info.id));
                        const removedIds: string[] = [];
                        previousIds.forEach((id) => {
                            if (!nextIds.has(id)) {
                                removedIds.push(id);
                            }
                        });

                        newMessages.set(sessionId, mergedMessages);
                        primeSessionMessagePositionIndex(sessionId, mergedMessages);

                        const result: Record<string, any> = {
                            messages: newMessages,
                            isSyncing: true,
                        };

                        clearLifecycleTimersForIds(removedIds);
                        const updatedLifecycle = removeLifecycleEntries(state.messageStreamStates, removedIds);
                        if (updatedLifecycle !== state.messageStreamStates) {
                            result.messageStreamStates = updatedLifecycle;
                        }

                        if (removedIds.length > 0) {
                            const currentStreaming = state.streamingMessageIds.get(sessionId);
                            if (currentStreaming && removedIds.includes(currentStreaming)) {
                                result.streamingMessageIds = setStreamingIdForSession(
                                    result.streamingMessageIds ?? state.streamingMessageIds,
                                    sessionId,
                                    null
                                );
                            }
                        }

                        if (removedIds.length > 0) {
                            const nextIndex = removeMessageSessionIndexEntries(
                                result.messageSessionIndex ?? state.messageSessionIndex,
                                removedIds
                            );
                            if (nextIndex !== (result.messageSessionIndex ?? state.messageSessionIndex)) {
                                result.messageSessionIndex = nextIndex;
                            }
                        }

                        if (removedIds.length > 0) {
                            const nextPendingParts = new Map(state.pendingAssistantParts);
                            let pendingChanged = false;
                            removedIds.forEach((id) => {
                                if (nextPendingParts.delete(id)) {
                                    pendingChanged = true;
                                }
                            });
                            if (pendingChanged) {
                                result.pendingAssistantParts = nextPendingParts;
                            }
                        }

                        const targetIndex = result.messageSessionIndex ?? state.messageSessionIndex;
                        let indexAccumulator = targetIndex;
                        mergedMessages.forEach((message) => {
                            const id = (message?.info as { id?: unknown })?.id;
                            if (typeof id === "string" && id.length > 0) {
                                indexAccumulator = upsertMessageSessionIndex(indexAccumulator, id, sessionId);
                            }
                        });
                        if (indexAccumulator !== targetIndex) {
                            result.messageSessionIndex = indexAccumulator;
                        }

                        return result;
                    });

                    setTimeout(() => {
                        set({ isSyncing: false });
                    }, 100);
                },

                updateSessionCompaction: (sessionId: string, compactingTimestamp: number | null | undefined) => {
                    set((state) => {
                        const nextCompaction = new Map(state.sessionCompactionUntil);

                        if (!compactingTimestamp || compactingTimestamp <= 0) {
                            if (!nextCompaction.has(sessionId)) {
                                return state;
                            }
                            nextCompaction.delete(sessionId);
                            return { sessionCompactionUntil: nextCompaction };
                        }

                        const deadline = compactingTimestamp + COMPACTION_WINDOW_MS;
                        const existingDeadline = nextCompaction.get(sessionId);
                        if (existingDeadline === deadline) {
                            return state;
                        }

                        nextCompaction.set(sessionId, deadline);
                        return { sessionCompactionUntil: nextCompaction };
                    });
                },

                acknowledgeSessionAbort: (sessionId: string) => {
                    if (!sessionId) {
                        return;
                    }

                    set((state) => {
                        const record = state.sessionAbortFlags.get(sessionId);
                        if (!record || record.acknowledged) {
                            return state;
                        }

                        const nextAbortFlags = new Map(state.sessionAbortFlags);
                        nextAbortFlags.set(sessionId, { ...record, acknowledged: true });
                        return { sessionAbortFlags: nextAbortFlags } as Partial<MessageState>;
                    });
                },

                updateViewportAnchor: (sessionId: string, anchor: number) => {
                    set((state) => {
                        const memoryState = state.sessionMemoryState.get(sessionId) || {
                            viewportAnchor: 0,
                            isStreaming: false,
                            lastAccessedAt: Date.now(),
                            backgroundMessageCount: 0,
                        };

                        if (memoryState.viewportAnchor === anchor) {
                            return state;
                        }

                        const newMemoryState = new Map(state.sessionMemoryState);
                        newMemoryState.set(sessionId, { ...memoryState, viewportAnchor: anchor });
                        return { sessionMemoryState: newMemoryState };
                    });
                },

                loadMoreMessages: async (sessionId: string, direction: "up" | "down" = "up") => {
                    const state = get();
                    const currentMessages = state.messages.get(sessionId);
                    const memoryState = state.sessionMemoryState.get(sessionId);
                    const historyMeta = state.sessionHistoryMeta.get(sessionId);

                    if (!currentMessages || !memoryState) {
                        return;
                    }

                    if (historyMeta?.loading) {
                        return;
                    }

                    if (historyMeta?.complete) {
                        return;
                    }

                    const memLimits = getMemoryLimits();
                    const baseLimit = historyMeta?.limit ?? memLimits.HISTORICAL_MESSAGES;
                    const desiredLimit = direction === "up" ? baseLimit + memLimits.HISTORY_CHUNK : baseLimit;

                    if (desiredLimit <= baseLimit) {
                        return;
                    }

                    await get().loadMessages(sessionId, desiredLimit);
                },

                getLastMessageModel: (sessionId: string) => {
                    const { messages } = get();
                    const sessionMessages = messages.get(sessionId);

                    if (!sessionMessages || sessionMessages.length === 0) {
                        return null;
                    }

                    for (let i = sessionMessages.length - 1; i >= 0; i--) {
                        const message = sessionMessages[i];
                        if (message.info.role === "assistant" && "providerID" in message.info && "modelID" in message.info) {
                            return {
                                providerID: (message.info as any).providerID,
                                modelID: (message.info as any).modelID,
                            };
                        }
                    }

                    return null;
                },
            }),
            {
                name: "message-store",
                storage: createJSONStorage(() => getSafeStorage()),
                partialize: (state: MessageStore) => ({
                    lastUsedProvider: state.lastUsedProvider,
                    sessionMemoryState: Array.from(state.sessionMemoryState.entries()).map(([sessionId, memory]) => [
                        sessionId,
                        {
                            viewportAnchor: memory.viewportAnchor,
                            lastAccessedAt: memory.lastAccessedAt,
                            totalAvailableMessages: memory.totalAvailableMessages,
                            loadedTurnCount: memory.loadedTurnCount,
                            hasMoreAbove: memory.hasMoreAbove,
                            hasMoreTurnsAbove: memory.hasMoreTurnsAbove,
                            historyLoading: memory.historyLoading,
                            historyComplete: memory.historyComplete,
                            historyLimit: memory.historyLimit,
                        },
                    ]),
                    sessionAbortFlags: Array.from(state.sessionAbortFlags.entries()).map(([sessionId, record]) => [
                        sessionId,
                        { timestamp: record.timestamp, acknowledged: record.acknowledged },
                    ]),
                }),
                merge: (persistedState: any, currentState: MessageStore): MessageStore => {
                    if (!persistedState) {
                        return currentState;
                    }

                    let restoredMemoryState = currentState.sessionMemoryState;
                    if (Array.isArray(persistedState.sessionMemoryState)) {
                        restoredMemoryState = new Map<string, SessionMemoryState>(
                            persistedState.sessionMemoryState.map((entry: [string, SessionMemoryState]) => {
                                const [id, memory] = entry;
                                // Never trust persisted history flags — they must be
                                // recomputed from a fresh API fetch on session open.
                                return [id, {
                                    ...memory,
                                    isStreaming: false,
                                    backgroundMessageCount: typeof memory.backgroundMessageCount === 'number'
                                        ? memory.backgroundMessageCount
                                        : 0,
                                    hasMoreAbove: undefined,
                                    hasMoreTurnsAbove: undefined,
                                    historyComplete: undefined,
                                    historyLimit: undefined,
                                    historyLoading: false,
                                }] as [string, SessionMemoryState];
                            })
                        );
                    }

                    let restoredAbortFlags = currentState.sessionAbortFlags;
                    if (Array.isArray(persistedState.sessionAbortFlags)) {
                        restoredAbortFlags = new Map<string, SessionAbortRecord>(persistedState.sessionAbortFlags);
                    }

                    return {
                        ...currentState,
                        lastUsedProvider: persistedState.lastUsedProvider ?? currentState.lastUsedProvider,
                        sessionMemoryState: restoredMemoryState,
                        sessionAbortFlags: restoredAbortFlags,
                    };
                },
            }
        ),
        {
            name: "message-store",
        }
    )
);
