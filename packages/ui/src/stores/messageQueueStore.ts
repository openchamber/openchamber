import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { z } from 'zod';
import type { Event } from '@opencode-ai/sdk/v2';
import { createInputHistoryIdentity, createInputHistorySubmission, useInputHistoryStore } from './useInputHistoryStore';
import { createDeferredSafeJSONStorage, getSafeStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { contextPartMetadataSchema, type ContextPartMetadata } from '@/lib/messages/contextParts';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch, type RuntimeFetchOptions, type RuntimeFetchTarget } from '@/lib/runtime-fetch';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync, getRuntimeUrlAuthTokenSync } from '@/lib/runtime-auth';
import { canonicalizePathIdentity, normalizePath } from '@/lib/pathNormalization';
import { getQueuedMessagePreview } from '@/lib/messages/queuedMessagePreview';

export type FollowUpBehavior = 'steer' | 'queue';

const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

export const isFollowUpBehavior = (value: string | null | undefined): value is FollowUpBehavior => (
    value === 'steer' || value === 'queue'
);

export const normalizeFollowUpBehavior = (
    value: string | null | undefined,
    legacyQueueModeEnabled?: boolean | null,
): FollowUpBehavior => {
    // Follow-up delivery is queue-only. Keep accepting the old persisted
    // values at the boundary so legacy settings cannot re-enable steer.
    void value;
    void legacyQueueModeEnabled;
    return DEFAULT_FOLLOW_UP_BEHAVIOR;
};

type MainSessionSendIntent = 'composer' | 'queued';
type MainSessionSendDisposition = 'send' | 'queue' | 'preserve-queued';

export type MessageQueueDispatchState = {
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
    if (!input.hasMainSession || input.isBtwActive) return 'send';
    if (input.hasQueuedMessageInFlight) {
        if (input.intent === 'queued' || !input.canQueue) return 'preserve-queued';
        return 'queue';
    }
    if (!input.isBusy || !input.canQueue) return 'send';
    return input.intent === 'queued' ? 'preserve-queued' : 'queue';
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
    /** Legacy local-queue context shape retained for migration/compatibility. */
    additionalParts?: QueuedMessagePart[];
    capturedContext?: QueuedMessagePart[];
    contextClaimed?: boolean;
    /** Absent on a server projection item; a take brings it back. */
    context?: QueuedContextPart[];
    /** Bounded display-only context summary retained in server projections. */
    contextPreview?: string;
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: QueuedMessageSendConfig;
}

export type QueuedMessagePart = {
    text: string;
    attachments?: AttachedFile[];
    synthetic?: boolean;
    metadata?: ContextPartMetadata;
};

interface QueuedMessageInput {
    content: string;
    /** Defaults to `content`. */
    text?: string;
    agentMention?: string;
    attachments?: AttachedFile[];
    additionalParts?: QueuedMessagePart[];
    capturedContext?: QueuedMessagePart[];
    contextClaimed?: boolean;
    context?: QueuedContextPart[];
    sendConfig?: QueuedMessageSendConfig;
    /** Rollbacks re-enqueue an accepted item without recording history twice. */
    skipHistory?: boolean;
}

export type MessageQueueTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

export type MessageQueueHoldTarget = Pick<MessageQueueTarget, 'runtimeKey' | 'directory' | 'sessionId'> & {
    generation: number;
    clientToken: string;
    deleted?: boolean;
    runtimeTarget?: RuntimeFetchTarget;
};

type MessageQueueHoldOptions = {
    releaseForRuntimeSwitch?: boolean;
    /** Cleanup for a target superseded by a session move, deletion, or recreation. */
    releaseObsoleteTarget?: boolean;
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
    generation: z.number().int().nonnegative().optional(),
    deleted: z.boolean().optional(),
});

const serverSessionLifecycleSchema = z.object({
    generation: z.number().int().nonnegative(),
    deleted: z.boolean().optional(),
    restoreRequiresReceipt: z.boolean().optional(),
    directory: z.string().optional(),
    deletedAt: z.number().finite().optional(),
});

const serverSnapshotSchema = z.object({
    revision: z.number(),
    sessions: z.array(serverSessionSchema),
    /** The queue endpoint is complete unless a future server explicitly says otherwise. */
    complete: z.boolean().optional(),
    sessionLifecycles: z.record(z.string(), serverSessionLifecycleSchema).optional(),
});

const serverSessionResponseSchema = z.object({
    revision: z.number(),
    session: serverSessionSchema,
});

const serverHoldResponseSchema = z.object({
    held: z.boolean(),
    expiresAt: z.number().nullable(),
    sequence: z.number().int().nonnegative().optional(),
});
type ServerHoldResponse = z.infer<typeof serverHoldResponseSchema>;

const createMessageQueueClientToken = (): string => `queue-client-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
const serverErrorSchema = z.object({
    error: z.string().optional(),
    generation: z.number().int().nonnegative().optional(),
    directory: z.string().optional(),
    deleted: z.boolean().optional(),
});

const serverEnqueueResponseSchema = serverSessionResponseSchema.extend({
    itemId: z.string().min(1).optional(),
});

const serverTakeResponseSchema = serverSessionResponseSchema.extend({ item: serverItemSchema, generation: z.number().optional() });
const serverTakeAllResponseSchema = serverSessionResponseSchema.extend({ items: z.array(serverItemSchema), generation: z.number().optional() });

type ServerQueueSession = z.infer<typeof serverSessionSchema>;
type ServerQueueItem = z.infer<typeof serverItemSchema>;
type ServerQueueAttachment = z.infer<typeof serverAttachmentSchema>;
type ServerQueueSnapshot = z.infer<typeof serverSnapshotSchema>;

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

type ServerQueueRestoreItemInput = ServerQueueItemInput & { id: string; createdAt: number };

type ServerQueueRequestBody =
    | { directory: string }
    | { directory: string; item: ServerQueueItemInput; idempotencyKey?: string; generation?: number }
    | { directory: string; items: ServerQueueRestoreItemInput[]; generation?: number; operationId?: string }
    | { itemIds: string[]; generation?: number }
     | { operationId: string; requireHead?: boolean; generation?: number }
    | { generation?: number }
    | { held: boolean; ttlMs?: number; generation?: number; sequence?: number; clientToken?: string };

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

const toServerContext = (message: Pick<QueuedMessage, 'context' | 'additionalParts' | 'capturedContext'>): QueuedContextPart[] => {
    if (message.context !== undefined) return message.context;
    const legacyParts = message.additionalParts && message.additionalParts.length > 0
        ? message.additionalParts
        : message.capturedContext ?? [];
    return legacyParts.map((part) => part.metadata
        ? { kind: 'context', text: part.text, metadata: part.metadata }
        : { kind: 'synthetic', text: part.text });
};

const toServerAttachments = (message: Pick<QueuedMessageInput, 'attachments' | 'additionalParts'>): ServerQueueAttachmentInput[] => {
    const attachments = [
        ...(message.attachments ?? []),
        ...(message.additionalParts ?? []).flatMap((part) => part.attachments ?? []),
    ];
    return Array.from(new Map(attachments.map((attachment) => [attachment.id, attachment])).values())
        .filter((file) => Boolean(file.dataUrl))
        .map(toServerAttachment);
};

const toServerItemInput = (message: QueuedMessageInput, sendConfig: QueuedMessageSendConfig): ServerQueueItemInput => {
    const item: ServerQueueItemInput = {
        content: message.content,
        text: message.text ?? message.content,
        attachments: toServerAttachments(message),
        context: toServerContext(message),
        sendConfig,
    };
    if (message.agentMention) item.agentMention = message.agentMention;
    const contextPreview = getQueuedMessagePreview({ content: '', context: message.context });
    if (contextPreview) item.contextPreview = contextPreview;
    return item;
};

const toServerRestoreItemInput = (message: QueuedMessage): ServerQueueRestoreItemInput => {
    if (!message.sendConfig) throw new Error('A queued message needs a provider and model to be delivered later.');
    return { id: message.id, createdAt: message.createdAt, ...toServerItemInput(message, message.sendConfig) };
};

/**
 * Resolve a send configuration only from selections that belong to this
 * session, followed by the active directory configuration. The resolver runs
 * after a queue snapshot has established server authority. It deliberately
 * does not use the global last-used provider or invent a fallback model.
 */
const resolveLegacySendConfig = async (target: MessageQueueTarget): Promise<QueuedMessageSendConfig | undefined> => {
    const [{ useConfigStore }, { useContextStore }] = await Promise.all([
        import('./useConfigStore'),
        import('./contextStore'),
    ]);
    const config = useConfigStore.getState();
    const context = useContextStore.getState();
    const selectedAgent = context.getSessionAgentSelection(target.sessionId)
        ?? context.getCurrentAgent(target.sessionId)
        ?? config.currentAgentName;
    const sessionModel = context.getSessionModelSelection(target.sessionId);
    const agentModel = selectedAgent
        ? context.getAgentModelForSession(target.sessionId, selectedAgent)
        : null;
    const candidates = [
        agentModel,
        sessionModel,
        config.currentProviderId && config.currentModelId
            ? { providerId: config.currentProviderId, modelId: config.currentModelId }
            : null,
    ];
    const selected = candidates.find((candidate) => candidate !== null && config.providers.some((provider) => (
        provider.id === candidate.providerId
        && provider.models.some((model) => model.id === candidate.modelId)
    )));
    if (!selected) return undefined;

    const agent = selectedAgent && config.agents.some((candidate) => candidate.name === selectedAgent)
        ? selectedAgent
        : undefined;
    const selectedVariant = agent
        ? context.getAgentModelVariantForSession(target.sessionId, agent, selected.providerId, selected.modelId)
        : undefined;
    const variant = selectedVariant ?? (
        selected.providerId === config.currentProviderId && selected.modelId === config.currentModelId
            ? config.currentVariant
            : undefined
    );
    const model = config.providers
        .find((provider) => provider.id === selected.providerId)
        ?.models.find((candidate) => candidate.id === selected.modelId);
    const validVariant = variant && model?.variants && Object.prototype.hasOwnProperty.call(model.variants, variant)
        ? variant
        : undefined;

    const sendConfig: QueuedMessageSendConfig = {
        providerID: selected.providerId,
        modelID: selected.modelId,
    };
    if (agent) sendConfig.agent = agent;
    if (validVariant) sendConfig.variant = validVariant;
    return sendConfig;
};

const requestJson = async <T,>(schema: z.ZodType<T>, path: string, init?: RuntimeFetchOptions): Promise<T> => {
    const response = await runtimeFetch(path, init);
    if (!response.ok) {
        const body = serverErrorSchema.safeParse(await response.json().catch(() => null));
        const error: Error & { status?: number; generation?: number; directory?: string; deleted?: boolean } = new Error(
            body.success && body.data.error ? body.data.error : `Message queue request failed (${response.status})`,
        );
        error.status = response.status;
        if (body.success) {
            error.generation = body.data.generation;
            error.directory = body.data.directory;
            error.deleted = body.data.deleted;
        }
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

/** Older queue servers did not return the accepted id; only use an unambiguous response match as a fallback. */
const findAcceptedQueueItemId = (
    session: ServerQueueSession,
    message: QueuedMessageInput,
    sendConfig: QueuedMessageSendConfig,
): string | undefined => {
    const expectedText = message.text ?? message.content;
    const matches = session.items.filter((item) => (
        item.content === message.content
        && item.text === expectedText
        && item.agentMention === message.agentMention
        && item.sendConfig.providerID === sendConfig.providerID
        && item.sendConfig.modelID === sendConfig.modelID
        && item.sendConfig.agent === sendConfig.agent
        && item.sendConfig.variant === sendConfig.variant
    ));
    return matches.length === 1 ? matches[0]?.id : undefined;
};

/**
 * Runtime keys whose queue the server owns, established by a successful
 * hydration. Their entries are a projection and must not be persisted: a
 * stale local copy would resurrect messages the server already delivered.
 */
const serverOwnedRuntimeKeys = new Set<string>();
/** Server revision last applied per queue key; older snapshots are ignored. */
const appliedRevisions = new Map<string, number>();
/** A full snapshot also owns sessions it omits, including previously unseen keys. */
const snapshotRevisions = new Map<string, number>();
const appliedSessionRevisions = new Map<string, number>();
const serverSessionLifecycleGenerations = new Map<string, number>();
const serverSessionDeleted = new Set<string>();
const serverSessionRestoreRequirements = new Set<string>();
const serverHoldMutationSequences = new Map<string, number>();
const serverMutationChains = new Map<string, Promise<void>>();
const takenServerGenerations = new Map<string, Map<string, number>>();
const takenServerRevisions = new Map<string, Map<string, number>>();
const serverSessionDirectories = new Map<string, string>();
const serverSessionDirectoryRevisions = new Map<string, number>();
const serverHoldMutationVersions = new Map<string, number>();
const serverHoldReleaseChains = new Map<string, Promise<void>>();
const HOLD_RELEASE_RETRY_DELAYS_MS = [0, 2_000, 10_000, 30_000, 120_000] as const;
const MAX_HOLD_MUTATION_ECHO_RETRIES = 2;

/**
 * Hold ownership is the UI's identity, not a credential: the server refuses a
 * hold mutation from any token but the active hold's owner. That token has to
 * outlive a page load, or a reload can neither re-assert nor release the
 * previous incarnation's hold and the queue sits behind a foreign hold until
 * the TTL expires. Persist one token per runtime plus the last sequence the
 * server accepted or echoed for each session, so a reload continues where the
 * previous incarnation stopped. The stored payload is an owner id and sequence
 * numbers only.
 */
const HOLD_IDENTITY_STORAGE_KEY = 'openchamber-message-queue-hold.v1';
const MAX_HOLD_IDENTITY_RUNTIMES = 8;
const MAX_HOLD_IDENTITY_SESSIONS = 50;

const persistedHoldIdentitySessionSchema = z.object({
    sequence: z.number().int().nonnegative(),
    updatedAt: z.number().finite(),
});
const persistedHoldIdentityRuntimeSchema = z.object({
    clientToken: z.string().min(1),
    updatedAt: z.number().finite(),
    sequences: z.record(z.string(), persistedHoldIdentitySessionSchema),
});
const persistedHoldIdentityEnvelopeSchema = z.object({
    version: z.literal(1),
    runtimes: z.record(z.string(), persistedHoldIdentityRuntimeSchema),
});
type PersistedHoldIdentityEnvelope = z.infer<typeof persistedHoldIdentityEnvelopeSchema>;

const emptyHoldIdentityEnvelope = (): PersistedHoldIdentityEnvelope => ({ version: 1, runtimes: {} });

const readHoldIdentityEnvelope = (): PersistedHoldIdentityEnvelope => {
    try {
        const raw = getSafeStorage().getItem(HOLD_IDENTITY_STORAGE_KEY);
        if (!raw) return emptyHoldIdentityEnvelope();
        const parsed = persistedHoldIdentityEnvelopeSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : emptyHoldIdentityEnvelope();
    } catch {
        // A blocked, corrupt, or over-quota store must not break hold mutations.
        return emptyHoldIdentityEnvelope();
    }
};

const writeHoldIdentityEnvelope = (envelope: PersistedHoldIdentityEnvelope): void => {
    try {
        getSafeStorage().setItem(HOLD_IDENTITY_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
        // The in-memory maps remain authoritative for this load.
    }
};

const cachedHoldIdentityClientTokens = new Map<string, string>();

/** One hold owner per runtime; persisted so a reload keeps the same identity. */
const getMessageQueueClientToken = (runtimeKey: string): string => {
    const cached = cachedHoldIdentityClientTokens.get(runtimeKey);
    if (cached) return cached;
    const persisted = readHoldIdentityEnvelope().runtimes[runtimeKey]?.clientToken;
    const clientToken = persisted ?? createMessageQueueClientToken();
    cachedHoldIdentityClientTokens.set(runtimeKey, clientToken);
    return clientToken;
};

const readPersistedHoldMutationSequence = (runtimeKey: string, sessionId: string): number | undefined =>
    readHoldIdentityEnvelope().runtimes[runtimeKey]?.sequences[sessionId]?.sequence;

const persistHoldMutationSequence = (runtimeKey: string, sessionId: string, sequence: number): void => {
    const envelope = readHoldIdentityEnvelope();
    const previous = envelope.runtimes[runtimeKey];
    const existing = previous?.sequences[sessionId];
    if (existing && existing.sequence >= sequence) return;
    const now = Date.now();
    const sequences = { ...(previous?.sequences ?? {}), [sessionId]: { sequence, updatedAt: now } };
    envelope.runtimes[runtimeKey] = {
        clientToken: getMessageQueueClientToken(runtimeKey),
        updatedAt: now,
        sequences: Object.fromEntries(
            Object.entries(sequences)
                .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
                .slice(0, MAX_HOLD_IDENTITY_SESSIONS),
        ),
    };
    envelope.runtimes = Object.fromEntries(
        Object.entries(envelope.runtimes)
            .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
            .slice(0, MAX_HOLD_IDENTITY_RUNTIMES),
    );
    writeHoldIdentityEnvelope(envelope);
};

const prunePersistedHoldMutationSequence = (runtimeKey: string, sessionId: string): void => {
    const envelope = readHoldIdentityEnvelope();
    const previous = envelope.runtimes[runtimeKey];
    if (!previous || !(sessionId in previous.sequences)) return;
    const sequences = { ...previous.sequences };
    delete sequences[sessionId];
    envelope.runtimes[runtimeKey] = { ...previous, sequences };
    writeHoldIdentityEnvelope(envelope);
};

type PendingServerHoldRelease = {
    target: MessageQueueHoldTarget;
    sequence: number;
    retryIndex: number;
    timer?: ReturnType<typeof setTimeout>;
};
const pendingServerHoldReleases = new Map<string, PendingServerHoldRelease>();
let hydrationGeneration = 0;
let hydrationInFlight: { runtimeKey: string; promise: Promise<void> } | null = null;
let resyncRequested = false;

const staleRuntimeError = (): Error & { code: string } => Object.assign(
    new Error('Message queue operation belongs to an inactive runtime'),
    { code: 'STALE_RUNTIME' },
);
const staleSessionError = (): Error & { code: string } => Object.assign(
    new Error('Message queue operation belongs to an obsolete session incarnation'),
    { code: 'STALE_SESSION' },
);
const assertTargetRuntime = (target: Pick<MessageQueueTarget, 'runtimeKey'>): void => {
    if (target.runtimeKey !== getRuntimeKey()) throw staleRuntimeError();
};

type PendingServerEnqueue = {
    target: MessageQueueTarget;
    removed: boolean;
    message: QueuedMessage;
    generation?: number;
    acceptedItemId?: string;
    /** Stable across path canonicalization and reloads; sent to the server as the idempotency key. */
    idempotencyKey?: string;
    /** A stale-generation or delete conflict stops automatic retries but keeps the prompt recoverable. */
    blocked?: boolean;
};

type PendingServerRestore = {
    target: MessageQueueTarget;
    messages: QueuedMessage[];
    deletionGeneration: number;
    generation?: number;
    sourceRevision?: number;
    mutationGeneration?: number;
    operationId?: string;
    /** A clear or stale-generation conflict invalidates retry without deleting the taken payload. */
    blocked?: boolean;
};

type PendingServerTake = {
    target: MessageQueueTarget;
    operationId: string;
    deletionGeneration: number;
    serverGeneration?: number;
    takeGeneration?: number;
    invalidated?: boolean;
    invalidatedMessageIds?: string[];
    invalidateAll?: boolean;
    messageId?: string;
    requireHead?: boolean;
};

type PendingServerTakeAck = {
    target: MessageQueueTarget;
    operationId: string;
    generation?: number;
    messageIds?: string[];
};

type ClearSendingOptions = { retryPending?: boolean };

/**
 * The server deliberately omits context from queue projections. Keep the
 * context captured by this window beside the projection so explicit removal
 * can still restore it without fetching a second, potentially stale item.
 */
const localQueueContexts = new Map<string, Map<string, QueuedContextPart[]>>();

const getServerSessionKey = (runtimeKey: string, sessionId: string): string => `${runtimeKey}\n${sessionId}`;
const getServerSessionLifecycleGeneration = (target: Pick<MessageQueueTarget, 'runtimeKey' | 'sessionId'>): number | undefined => serverSessionLifecycleGenerations.get(getServerSessionKey(target.runtimeKey, target.sessionId));
const queueMutationInit = (target: Pick<MessageQueueTarget, 'runtimeKey' | 'directory' | 'sessionId'>, method: string, body?: ServerQueueRequestBody, capturedGeneration = getServerSessionLifecycleGeneration(target)): RuntimeFetchOptions => {
    const requestBody = body === undefined ? { directory: target.directory } : { ...body, directory: target.directory };
    return jsonInit(method, capturedGeneration === undefined ? requestBody : { ...requestBody, generation: capturedGeneration });
};
const nextServerHoldMutationSequence = (target: MessageQueueHoldTarget): number => {
    const key = getServerSessionKey(target.runtimeKey, target.sessionId);
    const previous = Math.max(
        serverHoldMutationSequences.get(key) ?? 0,
        readPersistedHoldMutationSequence(target.runtimeKey, target.sessionId) ?? 0,
    );
    const sequence = previous + 1;
    serverHoldMutationSequences.set(key, sequence);
    persistHoldMutationSequence(target.runtimeKey, target.sessionId, sequence);
    return sequence;
};
const observeServerHoldMutationSequence = (target: MessageQueueHoldTarget, sequence: number | undefined): void => {
    if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 0) return;
    const key = getServerSessionKey(target.runtimeKey, target.sessionId);
    const current = Math.max(
        serverHoldMutationSequences.get(key) ?? 0,
        readPersistedHoldMutationSequence(target.runtimeKey, target.sessionId) ?? 0,
    );
    if (sequence <= current) return;
    serverHoldMutationSequences.set(key, sequence);
    persistHoldMutationSequence(target.runtimeKey, target.sessionId, sequence);
};
const nextServerHoldMutationVersion = (target: MessageQueueHoldTarget): number => {
    const key = getServerSessionKey(target.runtimeKey, target.sessionId);
    const version = (serverHoldMutationVersions.get(key) ?? 0) + 1;
    serverHoldMutationVersions.set(key, version);
    return version;
};
const getServerHoldMutationVersion = (target: MessageQueueHoldTarget): number =>
    serverHoldMutationVersions.get(getServerSessionKey(target.runtimeKey, target.sessionId)) ?? 0;
type MessageQueueError = Error & { code?: string; status?: number };
const messageQueueErrorSchema = z.object({ code: z.string().optional(), status: z.number().optional() });
const isTerminalPendingOperationError = (error: Error): boolean => {
    const parsed = messageQueueErrorSchema.safeParse(error);
    return parsed.success && (
        parsed.data.status === 409
        || parsed.data.code === 'STALE_RUNTIME'
        || parsed.data.code === 'STALE_SESSION'
    );
};
const shouldRetryServerHoldRelease = (error: MessageQueueError): boolean =>
    error.code !== 'STALE_RUNTIME' && error.code !== 'STALE_SESSION' && error.status !== 409;
const captureRuntimeFetchTarget = (): RuntimeFetchTarget => {
    const requestHeaders = { ...getRuntimeExtraHeadersSync() };
    const bearerToken = getRuntimeBearerTokenSync();
    if (bearerToken) requestHeaders.Authorization = `Bearer ${bearerToken}`;
    const target: RuntimeFetchTarget = {
        apiBaseUrl: getRuntimeApiBaseUrl(),
        requestHeaders,
    };
    const urlAuthToken = getRuntimeUrlAuthTokenSync();
    if (urlAuthToken) target.urlAuthToken = urlAuthToken;
    return target;
};
const setTakenServerGeneration = (queueKey: string, messageId: string, generation: number): void => {
    const generations = takenServerGenerations.get(queueKey) ?? new Map<string, number>();
    generations.set(messageId, generation);
    takenServerGenerations.set(queueKey, generations);
};
const setTakenServerRevision = (queueKey: string, messageId: string, revision: number): void => {
    const revisions = takenServerRevisions.get(queueKey) ?? new Map<string, number>();
    revisions.set(messageId, revision);
    takenServerRevisions.set(queueKey, revisions);
};
type TakenServerOperations = Record<string, Record<string, string>>;
const setTakenServerOperation = (
    operations: TakenServerOperations,
    target: MessageQueueTarget,
    messageId: string,
    operationId: string,
) => {
    const key = getServerSessionKey(target.runtimeKey, target.sessionId);
    return {
        ...operations,
        [key]: { ...(operations[key] ?? {}), [messageId]: operationId },
    };
};
const getTakenServerOperation = (
    operations: TakenServerOperations,
    target: MessageQueueTarget,
    messageId: string,
): string | undefined => operations[getServerSessionKey(target.runtimeKey, target.sessionId)]?.[messageId];
const clearTakenServerOperationIds = (
    operations: TakenServerOperations,
    target: MessageQueueTarget,
    messageIds: readonly string[],
) => {
    const key = getServerSessionKey(target.runtimeKey, target.sessionId);
    const current = operations[key];
    if (!current) return operations;
    const remaining = { ...current };
    for (const messageId of messageIds) delete remaining[messageId];
    if (Object.keys(remaining).length === 0) return withoutKey(operations, key);
    return { ...operations, [key]: remaining };
};
const clearTakenServerOperations = (
    operations: TakenServerOperations,
    target: MessageQueueTarget,
    messages: readonly QueuedMessage[],
) => clearTakenServerOperationIds(operations, target, messages.map((message) => message.id));
const clearTakenServerTracking = (target: MessageQueueTarget, messageIds: readonly string[]): void => {
    const key = getMessageQueueKey(target);
    const generations = takenServerGenerations.get(key);
    const revisions = takenServerRevisions.get(key);
    for (const messageId of messageIds) {
        generations?.delete(messageId);
        revisions?.delete(messageId);
    }
    if (generations?.size === 0) takenServerGenerations.delete(key);
    if (revisions?.size === 0) takenServerRevisions.delete(key);
};

const queueItemEphemeralKey = (queueKey: string, messageId: string): string => JSON.stringify([queueKey, messageId]);

const setLocalQueueContext = (queueKey: string, messageId: string, context: QueuedContextPart[]): void => {
    const contexts = localQueueContexts.get(queueKey) ?? new Map<string, QueuedContextPart[]>();
    contexts.set(messageId, context);
    localQueueContexts.set(queueKey, contexts);
};

const getLocalQueueContext = (queueKey: string, messageId: string): QueuedContextPart[] | undefined =>
    localQueueContexts.get(queueKey)?.get(messageId);

const deleteLocalQueueContext = (queueKey: string, messageId: string): void => {
    const contexts = localQueueContexts.get(queueKey);
    if (!contexts) return;
    contexts.delete(messageId);
    if (contexts.size === 0) localQueueContexts.delete(queueKey);
};

const moveLocalQueueContext = (queueKey: string, fromId: string, toId: string): void => {
    const context = getLocalQueueContext(queueKey, fromId);
    deleteLocalQueueContext(queueKey, fromId);
    if (context && toId !== fromId) setLocalQueueContext(queueKey, toId, context);
};

const reconcileLocalQueueContexts = (queueKey: string, items: readonly ServerQueueItem[]): void => {
    const contexts = localQueueContexts.get(queueKey);
    if (!contexts) return;
    const serverIds = new Set(items.map((item) => item.id));
    for (const messageId of contexts.keys()) {
        if (!serverIds.has(messageId)) contexts.delete(messageId);
    }
    if (contexts.size === 0) localQueueContexts.delete(queueKey);
};

const clearLocalQueueContexts = (queueKey: string): void => {
    localQueueContexts.delete(queueKey);
};

const markPendingServerEnqueueRemoved = (
    pendingEnqueues: Record<string, PendingServerEnqueue>,
    queueKey: string,
    messageId: string,
) => {
    const enqueueKey = queueItemEphemeralKey(queueKey, messageId);
    const pending = pendingEnqueues[enqueueKey];
    if (!pending || pending.removed) return { pendingEnqueues, found: false };
    return {
        pendingEnqueues: { ...pendingEnqueues, [enqueueKey]: { ...pending, removed: true } },
        found: true,
    };
};

const markPendingServerEnqueuesRemoved = (
    pendingEnqueues: Record<string, PendingServerEnqueue>,
    queueKey: string,
) => {
    let next = pendingEnqueues;
    for (const [enqueueKey, pending] of Object.entries(pendingEnqueues)) {
        if (getMessageQueueKey(pending.target) !== queueKey || pending.removed) continue;
        next = { ...next, [enqueueKey]: { ...pending, removed: true } };
    }
    return next;
};

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // runtime + directory + session → queue
    quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
    /** Legacy prompts that still need an explicit model/config choice. */
    pendingLegacyMessages: Record<string, QueuedMessage[]>;
    followUpBehavior: FollowUpBehavior;
    /** Invalidates rollback/context restoration after session deletion. */
    queueDeletionGenerations: Record<string, number>;
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
    pendingServerRestores: Record<string, PendingServerRestore>;
    pendingServerTakes: Record<string, PendingServerTake>;
    pendingServerTakeAcks: Record<string, PendingServerTakeAck>;
    pendingServerEnqueues: Record<string, PendingServerEnqueue>;
    takenServerOperations: TakenServerOperations;
    retryPendingIds: Record<string, string[]>;
    /** Ephemeral signal for consumers that must reconcile lifecycle identity changes. */
    serverSessionIdentityVersion: number;
}

interface MessageQueueActions {
    addToQueue: (target: MessageQueueTarget, message: QueuedMessageInput) => Promise<string | undefined>;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => void;
    /** Removes the message and returns it in full, attachments included. */
    popToInput: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null | Promise<QueuedMessage | null>;
    /**
     * Removes what the composer is about to send itself — one message or every
     * message not already being delivered — and returns it in full.
     */
    takeForSend: (target: MessageQueueTarget, messageId?: string, options?: { requireHead?: boolean }) => Promise<QueuedMessage[]>;
    acknowledgeTakenServerBatch: (target: MessageQueueTarget, messages: QueuedMessage[]) => Promise<void>;
    clearQueue: (target: MessageQueueTarget) => QueuedMessage[];
    /** Drops the local projection only (the session is gone); never a server call. */
    forgetQueue: (target: MessageQueueTarget) => void;
     clearAllQueues: () => void;
     markSending: (target: MessageQueueTarget, messageId: string) => boolean;
     /** Claims the local queue head without removing it from the visible queue. */
     claimLocalSend: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
     clearSending: (target: MessageQueueTarget, messageId: string, options?: ClearSendingOptions) => void;
     completeSending: (target: MessageQueueTarget, messageId: string) => void;
    getSendableQueue: (target: MessageQueueTarget) => QueuedMessage[];
    getQueueDispatchState: (target: MessageQueueTarget) => MessageQueueDispatchState;
    getQueueRestorationGuard: (target: MessageQueueTarget) => MessageQueueRestorationGuard;
    isQueueRestorationGuardCurrent: (target: MessageQueueTarget, guard: MessageQueueRestorationGuard) => boolean;
    restoreQueue: (target: MessageQueueTarget, messages: QueuedMessage[], guard: MessageQueueRestorationGuard) => Promise<boolean>;
    retryPendingServerRestores: () => Promise<void>;
    clearQueueForSessionDeletion: (target: MessageQueueTarget) => void;
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
    /** Server-owned queue: load the authoritative queue for the active runtime. */
    hydrate: () => Promise<void>;
    /** Server-owned queue: re-read after an event-stream gap. */
    resync: () => Promise<void>;
    /** Server-owned queue: apply one session's authoritative state (broadcast or response). */
    applyServerSession: (session: ServerQueueSession, revision: number, expectedRuntimeKey: string, invalidatePending?: boolean) => void;
    /** Server-owned queue: tell the server to hold or release a session's delivery. */
     getServerHoldTarget: (sessionId: string, directory?: string) => MessageQueueHoldTarget;
     setServerHold: (target: MessageQueueHoldTarget, held: boolean, options?: MessageQueueHoldOptions) => Promise<void>;
    resetForRuntimeSwitch: (previousRuntimeKey: string | null | undefined) => void;
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

export type MessageQueueRestorationGuard = {
    target: MessageQueueTarget;
    /** Queue ownership captured before an async send can switch runtimes. */
    serverOwned?: boolean;
    deletionGeneration: number;
    mutationGeneration?: number;
    authoritativeDirectory: string;
    authoritativeDirectoryRevision: number;
    requiresReceipt: boolean;
    operationId?: string;
};

export type RemovedQueueMessages = {
    target: MessageQueueTarget;
    messages: QueuedMessage[];
};

/** Messages persisted before version 3 carried only `content`. */
const persistedQueuedMessageSchema = z.object({
    id: z.string().min(1),
    content: z.string(),
    text: z.string().optional(),
    agentMention: z.string().optional(),
    attachments: z.array(serverAttachmentSchema).optional(),
    additionalParts: z.array(z.object({
        text: z.string(),
        attachments: z.array(serverAttachmentSchema).optional(),
        synthetic: z.boolean().optional(),
        metadata: contextPartMetadataSchema.optional(),
    })).optional(),
    capturedContext: z.array(z.object({
        text: z.string(),
        attachments: z.array(serverAttachmentSchema).optional(),
        synthetic: z.boolean().optional(),
        metadata: contextPartMetadataSchema.optional(),
    })).optional(),
    contextClaimed: z.boolean().optional(),
    context: z.array(serverContextPartSchema).optional(),
    createdAt: z.number().finite(),
    sendConfig: serverSendConfigSchema.optional(),
});

const persistedMessageQueueTargetSchema = z.object({
    runtimeKey: z.string().min(1),
    directory: z.string().min(1),
    sessionId: z.string().min(1),
});

const persistedPendingServerEnqueueSchema = z.object({
    target: persistedMessageQueueTargetSchema,
    removed: z.boolean(),
    message: persistedQueuedMessageSchema,
    generation: z.number().int().nonnegative().optional(),
    acceptedItemId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).optional(),
    blocked: z.boolean().optional(),
});

const persistedPendingServerTakeSchema = z.object({
    target: persistedMessageQueueTargetSchema,
    operationId: z.string().min(1),
    deletionGeneration: z.number().int().nonnegative(),
    serverGeneration: z.number().int().nonnegative().optional(),
    takeGeneration: z.number().int().nonnegative().optional(),
    invalidated: z.boolean().optional(),
    invalidatedMessageIds: z.array(z.string().min(1)).optional(),
    invalidateAll: z.boolean().optional(),
    messageId: z.string().min(1).optional(),
    requireHead: z.boolean().optional(),
});

const persistedPendingServerRestoreSchema = z.object({
    target: persistedMessageQueueTargetSchema,
    messages: z.array(persistedQueuedMessageSchema),
    deletionGeneration: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative().optional(),
    sourceRevision: z.number().optional(),
    mutationGeneration: z.number().int().nonnegative().optional(),
    operationId: z.string().min(1).optional(),
    blocked: z.boolean().optional(),
});

const persistedPendingServerTakeAckSchema = z.object({
    target: persistedMessageQueueTargetSchema,
    operationId: z.string().min(1),
    generation: z.number().int().nonnegative().optional(),
    messageIds: z.array(z.string().min(1)).optional(),
});

const persistedMessageQueueStateSchema = z.object({
    queuedMessages: z.record(z.string(), z.unknown()).optional(),
    quarantinedLegacyMessages: z.record(z.string(), z.unknown()).optional(),
    pendingLegacyMessages: z.record(z.string(), z.unknown()).optional(),
    followUpBehavior: z.string().optional(),
    queueModeEnabled: z.boolean().optional(),
    queueDeletionGenerations: z.record(z.string(), z.unknown()).optional(),
    pendingServerRestores: z.record(z.string(), z.unknown()).optional(),
    pendingServerTakes: z.record(z.string(), z.unknown()).optional(),
    pendingServerTakeAcks: z.record(z.string(), z.unknown()).optional(),
    pendingServerEnqueues: z.record(z.string(), z.unknown()).optional(),
    takenServerOperations: z.record(z.string(), z.record(z.string(), z.string())).optional(),
});

type PersistedQueuedMessage = z.infer<typeof persistedQueuedMessageSchema>;

const toPersistedQueuedMessage = (message: PersistedQueuedMessage): QueuedMessage => {
    const toPart = (part: {
        text: string;
        attachments?: ServerQueueAttachment[];
        synthetic?: boolean;
        metadata?: ContextPartMetadata;
    }): QueuedMessagePart => {
        const normalizedPart: QueuedMessagePart = { text: part.text };
        if (part.attachments && part.attachments.length > 0) normalizedPart.attachments = part.attachments.map(toAttachedFile);
        if (part.synthetic !== undefined) normalizedPart.synthetic = part.synthetic;
        if (part.metadata !== undefined) normalizedPart.metadata = part.metadata;
        return normalizedPart;
    };
    const normalized: QueuedMessage = {
        id: message.id,
        content: message.content,
        text: message.text ?? message.content,
        createdAt: message.createdAt,
    };
    if (message.agentMention) normalized.agentMention = message.agentMention;
    if (message.attachments && message.attachments.length > 0) normalized.attachments = message.attachments.map(toAttachedFile);
    if (message.additionalParts && message.additionalParts.length > 0) {
        normalized.additionalParts = message.additionalParts.map(toPart);
    }
    if (message.capturedContext && message.capturedContext.length > 0) {
        normalized.capturedContext = message.capturedContext.map(toPart);
    }
    if (message.contextClaimed !== undefined) normalized.contextClaimed = message.contextClaimed;
    if (message.context && message.context.length > 0) normalized.context = message.context;
    if (message.sendConfig) normalized.sendConfig = { ...message.sendConfig };
    return normalized;
};

/** Parse each item independently so one malformed entry cannot erase siblings. */
const validPersistedMessages = <T,>(value: readonly T[]): QueuedMessage[] => value.flatMap((candidate) => {
    const parsed = persistedQueuedMessageSchema.safeParse(candidate);
    return parsed.success ? [toPersistedQueuedMessage(parsed.data)] : [];
});

const trimQueue = (messages: QueuedMessage[], protectedIds: ReadonlySet<string> = new Set()): QueuedMessage[] => {
    if (messages.length <= MAX_MESSAGES_PER_QUEUE) return messages;
    let overflow = messages.length - MAX_MESSAGES_PER_QUEUE;
    const dropped = new Set<string>();
    for (const message of messages) {
        if (overflow === 0) break;
        if (protectedIds.has(message.id)) continue;
        dropped.add(message.id);
        overflow -= 1;
    }
    return messages.filter((message) => !dropped.has(message.id));
};

const trimQueueTargets = (
    queuedMessages: MessageQueueState['queuedMessages'],
    sendingIds: MessageQueueState['sendingIds'] = {},
    retryPendingIds: MessageQueueState['retryPendingIds'] = {},
    preferredKey?: string,
): MessageQueueState['queuedMessages'] => {
    const keys = Object.keys(queuedMessages);
    if (keys.length <= MAX_QUEUE_TARGETS) return queuedMessages;
    keys.sort((left, right) => (queuedMessages[left]?.[0]?.createdAt ?? 0) - (queuedMessages[right]?.[0]?.createdAt ?? 0));
    const trimmed = { ...queuedMessages };
    let overflow = keys.length - MAX_QUEUE_TARGETS;
    for (const key of keys) {
        if (overflow === 0) break;
        if (key === preferredKey || (sendingIds[key] ?? []).length > 0 || (retryPendingIds[key] ?? []).length > 0) continue;
        delete trimmed[key];
        overflow -= 1;
    }
    return trimmed;
};

export const migrateMessageQueueState = <T,>(persistedState: T, version: number): Partial<MessageQueueStore> => {
    const parsedState = persistedMessageQueueStateSchema.safeParse(persistedState);
    const state = parsedState.success ? parsedState.data : {};
    const queuedMessages: Record<string, QueuedMessage[]> = {};
    const quarantinedLegacyMessages: Record<string, QueuedMessage[]> = {};
    const pendingLegacyMessages: Record<string, QueuedMessage[]> = {};

    const append = (record: Record<string, QueuedMessage[]>, key: string, messages: QueuedMessage[]) => {
        if (messages.length === 0) return;
        record[key] = [...(record[key] ?? []), ...messages];
    };

    const quarantine = (key: string, messages: QueuedMessage[]) => {
        const target = parseMessageQueueKey(key);
        append(quarantinedLegacyMessages, target ? getMessageQueueKey(target) : key, messages);
    };

    if (state.quarantinedLegacyMessages) {
        for (const [key, value] of Object.entries(state.quarantinedLegacyMessages)) {
            const messages = Array.isArray(value) ? validPersistedMessages(value) : [];
            if (messages.length === 0) continue;
            const target = parseMessageQueueKey(key);
            append(quarantinedLegacyMessages, target ? getMessageQueueKey(target) : key, messages);
        }
    }

    if (state.pendingLegacyMessages) {
        for (const [key, value] of Object.entries(state.pendingLegacyMessages)) {
            const messages = Array.isArray(value) ? validPersistedMessages(value) : [];
            if (messages.length === 0) continue;
            const target = parseMessageQueueKey(key);
            append(pendingLegacyMessages, target ? getMessageQueueKey(target) : key, messages);
        }
    }

    if (state.queuedMessages) {
        for (const [key, value] of Object.entries(state.queuedMessages)) {
            const messages = Array.isArray(value) ? validPersistedMessages(value) : [];
            if (messages.length === 0) continue;
            const target = version >= 2 ? parseMessageQueueKey(key) : null;
            if (!target) {
                quarantine(key, messages);
                continue;
            }
            append(queuedMessages, getMessageQueueKey(target), messages);
        }
    }

    for (const [key, messages] of Object.entries(queuedMessages)) {
        queuedMessages[key] = trimQueue(messages);
    }
    const pendingServerEnqueues: Record<string, PendingServerEnqueue> = {};
    for (const [key, value] of Object.entries(state.pendingServerEnqueues ?? {})) {
        const parsed = persistedPendingServerEnqueueSchema.safeParse(value);
        if (!parsed.success) continue;
        const target = createMessageQueueTarget(
            parsed.data.target.sessionId,
            parsed.data.target.directory,
            parsed.data.target.runtimeKey,
        );
        if (!target) continue;
        const enqueueKey = queueItemEphemeralKey(getMessageQueueKey(target), parsed.data.message.id);
        const pending = {
            ...parsed.data,
            target,
            message: toPersistedQueuedMessage(parsed.data.message),
            idempotencyKey: parsed.data.idempotencyKey ?? key,
        };
        const previous = pendingServerEnqueues[enqueueKey];
        if (!previous || (!previous.removed && pending.removed)) pendingServerEnqueues[enqueueKey] = pending;
    }

    const pendingServerTakes: Record<string, PendingServerTake> = {};
    for (const value of Object.values(state.pendingServerTakes ?? {})) {
        const parsed = persistedPendingServerTakeSchema.safeParse(value);
        if (!parsed.success) continue;
        const target = createMessageQueueTarget(
            parsed.data.target.sessionId,
            parsed.data.target.directory,
            parsed.data.target.runtimeKey,
        );
        if (!target) continue;
        const key = getMessageQueueKey(target);
        if (!pendingServerTakes[key]) pendingServerTakes[key] = { ...parsed.data, target };
    }

    const pendingServerTakeAcks: Record<string, PendingServerTakeAck> = {};
    for (const value of Object.values(state.pendingServerTakeAcks ?? {})) {
        const parsed = persistedPendingServerTakeAckSchema.safeParse(value);
        if (!parsed.success) continue;
        const target = createMessageQueueTarget(
            parsed.data.target.sessionId,
            parsed.data.target.directory,
            parsed.data.target.runtimeKey,
        );
        if (!target) continue;
        const ackKey = `${getMessageQueueKey(target)}\n${parsed.data.operationId}`;
        if (!pendingServerTakeAcks[ackKey]) pendingServerTakeAcks[ackKey] = { ...parsed.data, target };
    }

    const pendingServerRestores: Record<string, PendingServerRestore> = {};
    for (const value of Object.values(state.pendingServerRestores ?? {})) {
        const parsed = persistedPendingServerRestoreSchema.safeParse(value);
        if (!parsed.success) continue;
        const target = createMessageQueueTarget(
            parsed.data.target.sessionId,
            parsed.data.target.directory,
            parsed.data.target.runtimeKey,
        );
        if (!target) continue;
        const key = getMessageQueueKey(target);
        if (!pendingServerRestores[key]) {
            pendingServerRestores[key] = {
                ...parsed.data,
                target,
                messages: parsed.data.messages.map(toPersistedQueuedMessage),
            };
        }
    }

    const queueDeletionGenerations: Record<string, number> = {};
    for (const [key, value] of Object.entries(state.queueDeletionGenerations ?? {})) {
        const parsedValue = z.number().int().nonnegative().safeParse(value);
        if (!parsedValue.success) continue;
        const target = parseMessageQueueKey(key);
        const canonicalKey = target ? getMessageQueueKey(target) : key;
        queueDeletionGenerations[canonicalKey] = Math.max(queueDeletionGenerations[canonicalKey] ?? 0, parsedValue.data);
    }
    return {
        queuedMessages,
        quarantinedLegacyMessages,
        pendingLegacyMessages,
        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
        queueDeletionGenerations,
        pendingServerRestores,
        pendingServerTakes,
        pendingServerTakeAcks,
        pendingServerEnqueues,
        takenServerOperations: state.takenServerOperations ?? {},
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
    for (const key of new Set([
        ...Object.keys(queuedMessages),
        ...Object.keys(sendingIds),
        ...Object.keys(state.queuedMessages),
        ...Object.keys(state.sendingIds),
    ])) {
        const parsed = parseMessageQueueKey(key);
        if (parsed?.runtimeKey !== runtimeKey || parsed.sessionId !== sessionId) continue;
        if ((appliedRevisions.get(key) ?? -1) > revision) continue;
        appliedRevisions.set(key, revision);
        clearLocalQueueContexts(key);
        queuedMessages = withoutKey(queuedMessages, key);
        sendingIds = withoutKey(sendingIds, key);
    }
    return { queuedMessages, sendingIds };
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => {
                const applyServerLifecycle = (
                    sessionId: string,
                    lifecycle: z.infer<typeof serverSessionLifecycleSchema>,
                    revision: number,
                    expectedRuntimeKey: string,
                ): boolean => {
                    if (expectedRuntimeKey !== getRuntimeKey()) return false;
                    const serverSessionKey = getServerSessionKey(expectedRuntimeKey, sessionId);
                    const previousSessionRevision = appliedSessionRevisions.get(serverSessionKey) ?? -1;
                    if (revision < previousSessionRevision) return false;

                    const previousGeneration = serverSessionLifecycleGenerations.get(serverSessionKey);
                    const previousDirectory = serverSessionDirectories.get(serverSessionKey);
                    const wasDeleted = serverSessionDeleted.has(serverSessionKey);
                    if (previousGeneration === undefined || lifecycle.generation >= previousGeneration) {
                        serverSessionLifecycleGenerations.set(serverSessionKey, lifecycle.generation);
                    }
                    const nextGeneration = serverSessionLifecycleGenerations.get(serverSessionKey);
                    if (lifecycle.directory) {
                        const directory = normalizePath(lifecycle.directory);
                        if (directory) serverSessionDirectories.set(serverSessionKey, directory);
                    }
                    const nextDirectory = serverSessionDirectories.get(serverSessionKey);
                    if (lifecycle.deleted) serverSessionDeleted.add(serverSessionKey);
                    else serverSessionDeleted.delete(serverSessionKey);
                    if (lifecycle.restoreRequiresReceipt === true) serverSessionRestoreRequirements.add(serverSessionKey);
                    if (lifecycle.restoreRequiresReceipt === false) serverSessionRestoreRequirements.delete(serverSessionKey);
                    appliedSessionRevisions.set(serverSessionKey, revision);
                    if (
                        previousGeneration !== nextGeneration
                        || previousDirectory !== nextDirectory
                        || wasDeleted !== Boolean(lifecycle.deleted)
                    ) {
                        set((state) => ({ serverSessionIdentityVersion: state.serverSessionIdentityVersion + 1 }));
                    }

                    if (lifecycle.deleted) {
                        set((state) => {
                            const keys = new Set([
                                ...Object.keys(state.queuedMessages),
                                ...Object.keys(state.pendingLegacyMessages),
                                ...Object.keys(state.sendingIds),
                                ...Object.keys(state.pendingServerEnqueues),
                                ...Object.keys(state.pendingServerRestores),
                                ...Object.keys(state.pendingServerTakes),
                            ]);
                            const queueDeletionGenerations = { ...state.queueDeletionGenerations };
                            let pendingServerEnqueues = state.pendingServerEnqueues;
                            let pendingServerRestores = state.pendingServerRestores;
                            let pendingServerTakes = state.pendingServerTakes;
                            let pendingLegacyMessages = state.pendingLegacyMessages;
                            let pendingServerTakeAcks = state.pendingServerTakeAcks;
                            let takenServerOperations = state.takenServerOperations;
                            for (const key of keys) {
                                const target = parseMessageQueueKey(key);
                                if (target?.runtimeKey !== expectedRuntimeKey || target.sessionId !== sessionId) continue;
                                queueDeletionGenerations[key] = (queueDeletionGenerations[key] ?? 0) + 1;
                                pendingLegacyMessages = withoutKey(pendingLegacyMessages, key);
                                pendingServerEnqueues = markPendingServerEnqueuesRemoved(pendingServerEnqueues, key);
                                pendingServerRestores = withoutKey(pendingServerRestores, key);
                                pendingServerTakes = withoutKey(pendingServerTakes, key);
                                pendingServerTakeAcks = Object.fromEntries(Object.entries(pendingServerTakeAcks).filter(([ackKey]) => !ackKey.startsWith(`${key}\n`)));
                            }
                                takenServerOperations = withoutKey(takenServerOperations, serverSessionKey);
                            pendingServerTakeAcks = Object.fromEntries(Object.entries(pendingServerTakeAcks).filter(([, pending]) => (
                                pending.target.runtimeKey !== expectedRuntimeKey || pending.target.sessionId !== sessionId
                            )));
                            return {
                                ...clearSessionProjection(state, expectedRuntimeKey, sessionId, revision),
                                queueDeletionGenerations,
                                pendingServerEnqueues,
                                pendingServerRestores,
                                pendingServerTakes,
                                pendingLegacyMessages,
                                pendingServerTakeAcks,
                                takenServerOperations,
                            };
                        });
                    }
                    return true;
                };

                const applyServerSession = (
                    session: ServerQueueSession,
                    revision: number,
                    expectedRuntimeKey: string,
                    invalidatePending = false,
                    preserveOperationId?: string,
                ) => {
                    if (expectedRuntimeKey !== getRuntimeKey()) return;
                    if ((snapshotRevisions.get(expectedRuntimeKey) ?? -1) > revision) return;
                    const serverSessionKey = getServerSessionKey(expectedRuntimeKey, session.sessionId);
                    const previousSessionRevision = appliedSessionRevisions.get(serverSessionKey) ?? -1;
                    if (revision < previousSessionRevision) return;

                    const previousGeneration = serverSessionLifecycleGenerations.get(serverSessionKey);
                    const previousDirectory = serverSessionDirectories.get(serverSessionKey);
                    const wasDeleted = serverSessionDeleted.has(serverSessionKey);
                    if (session.generation !== undefined) {
                        if (previousGeneration === undefined || session.generation >= previousGeneration) {
                            serverSessionLifecycleGenerations.set(serverSessionKey, session.generation);
                        }
                    }
                    if (session.directory) {
                        const directory = normalizePath(session.directory);
                        if (directory) serverSessionDirectories.set(serverSessionKey, directory);
                    }
                    const nextGeneration = serverSessionLifecycleGenerations.get(serverSessionKey);
                    const nextDirectory = serverSessionDirectories.get(serverSessionKey);
                    if (session.deleted) {
                        if (previousGeneration !== nextGeneration || previousDirectory !== nextDirectory) {
                            set((state) => ({ serverSessionIdentityVersion: state.serverSessionIdentityVersion + 1 }));
                        }
                        applyServerLifecycle(session.sessionId, {
                            generation: session.generation ?? serverSessionLifecycleGenerations.get(serverSessionKey) ?? 0,
                            deleted: true,
                            directory: session.directory,
                        }, revision, expectedRuntimeKey);
                        return;
                    }
                    serverSessionDeleted.delete(serverSessionKey);
                    if (
                        previousGeneration !== nextGeneration
                        || previousDirectory !== nextDirectory
                        || wasDeleted
                    ) {
                        set((state) => ({ serverSessionIdentityVersion: state.serverSessionIdentityVersion + 1 }));
                    }
                    const authoritativeDirectory = session.directory || serverSessionDirectories.get(serverSessionKey) || '';
                    const target = createMessageQueueTarget(session.sessionId, authoritativeDirectory, expectedRuntimeKey);
                    if (!target) {
                        // Servers before 1.22.2 drop a session's directory once its
                        // queue is empty. A session id is unique across directories,
                        // so an empty session still says which projection is done.
                        if (session.items.length > 0) return;
                        appliedSessionRevisions.set(serverSessionKey, revision);
                        set((state) => clearSessionProjection(state, expectedRuntimeKey, session.sessionId, revision));
                        return;
                    }
                    const key = getMessageQueueKey(target);
                    if ((appliedRevisions.get(key) ?? -1) > revision) return;
                    if (previousDirectory !== undefined && previousDirectory !== target.directory) {
                        serverSessionDirectoryRevisions.set(serverSessionKey, revision);
                    }
                    serverSessionDirectories.set(serverSessionKey, target.directory);
                    appliedSessionRevisions.set(serverSessionKey, revision);
                    appliedRevisions.set(key, revision);
                    reconcileLocalQueueContexts(key, session.items);
                    set((state) => {
                        const queuedMessages = { ...state.queuedMessages };
                        const sendingIds = { ...state.sendingIds };
                        for (const existingKey of new Set([
                            ...Object.keys(queuedMessages),
                            ...Object.keys(state.pendingLegacyMessages),
                            ...Object.keys(sendingIds),
                        ])) {
                            const parsed = parseMessageQueueKey(existingKey);
                            if (parsed?.runtimeKey === expectedRuntimeKey && parsed.sessionId === session.sessionId && existingKey !== key && (appliedRevisions.get(existingKey) ?? -1) <= revision) {
                                appliedRevisions.set(existingKey, revision);
                                delete queuedMessages[existingKey];
                                delete sendingIds[existingKey];
                                clearLocalQueueContexts(existingKey);
                            }
                        }
                        let pendingServerEnqueues = state.pendingServerEnqueues;
                        let pendingServerRestores = state.pendingServerRestores;
                        let pendingServerTakes = state.pendingServerTakes;
                        let pendingLegacyMessages = state.pendingLegacyMessages;
                         // An empty update caused by a directory move is not
                         // proof that a take was delivered. The take and any
                         // restore it may need still belong to the same
                         // session incarnation, just under the new owner.
                         const directoryMoved = previousDirectory !== undefined && previousDirectory !== target.directory;
                         if (invalidatePending && session.items.length === 0) {
                             pendingServerEnqueues = markPendingServerEnqueuesRemoved(pendingServerEnqueues, key);
                             if (!directoryMoved) {
                                 const pendingRestore = pendingServerRestores[key];
                                 if (pendingRestore && pendingRestore.operationId !== preserveOperationId) {
                                     pendingServerRestores = {
                                         ...pendingServerRestores,
                                         [key]: { ...pendingRestore, blocked: true },
                                     };
                                 }
                                 const pendingTake = pendingServerTakes[key];
                                 if (pendingTake && pendingTake.operationId !== preserveOperationId) {
                                     pendingServerTakes = {
                                         ...pendingServerTakes,
                                         [key]: { ...pendingTake, invalidated: true, invalidateAll: true },
                                     };
                                 }
                                 pendingLegacyMessages = withoutKey(pendingLegacyMessages, key);
                             }
                         }
                        const queue = [
                            ...session.items.map(toQueuedMessage),
                            ...(pendingLegacyMessages[key] ?? []),
                        ];
                        if (queue.length > 0) queuedMessages[key] = queue;
                        else delete queuedMessages[key];
                        if (session.sendingId) sendingIds[key] = [session.sendingId];
                        else delete sendingIds[key];
                        return {
                            queuedMessages,
                            sendingIds,
                            pendingServerEnqueues,
                            pendingServerRestores,
                            pendingServerTakes,
                            pendingLegacyMessages,
                        };
                    });
                };

                const applyServerSnapshot = (snapshot: ServerQueueSnapshot, expectedRuntimeKey: string): boolean => {
                    if (expectedRuntimeKey !== getRuntimeKey() || snapshot.complete === false) return false;
                    if ((snapshotRevisions.get(expectedRuntimeKey) ?? -1) > snapshot.revision) return false;
                    for (const [sessionId, lifecycle] of Object.entries(snapshot.sessionLifecycles ?? {})) {
                        applyServerLifecycle(sessionId, lifecycle, snapshot.revision, expectedRuntimeKey);
                    }
                    for (const session of snapshot.sessions) {
                        applyServerSession(session, snapshot.revision, expectedRuntimeKey);
                    }
                    snapshotRevisions.set(expectedRuntimeKey, snapshot.revision);

                    // The GET endpoint is a complete snapshot. Only this path is
                    // allowed to infer that a previously projected session was
                    // omitted; live updates remain entity-scoped.
                    const presentSessionIds = new Set(snapshot.sessions.map((session) => session.sessionId));
                    set((state) => {
                        let next = state;
                        const keys = new Set([
                            ...Object.keys(state.queuedMessages),
                            ...Object.keys(state.pendingLegacyMessages),
                            ...Object.keys(state.sendingIds),
                        ]);
                        for (const key of keys) {
                            const target = parseMessageQueueKey(key);
                            if (target?.runtimeKey !== expectedRuntimeKey || presentSessionIds.has(target.sessionId)) continue;
                            if (state.pendingLegacyMessages[key]?.length) continue;
                            if ((appliedRevisions.get(key) ?? -1) > snapshot.revision) continue;
                            appliedRevisions.set(key, snapshot.revision);
                            clearLocalQueueContexts(key);
                            next = {
                                ...next,
                                queuedMessages: withoutKey(next.queuedMessages, key),
                                sendingIds: withoutKey(next.sendingIds, key),
                            };
                        }
                        return next === state ? state : next;
                    });
                    return true;
                };

                const getQueueDeletionGeneration = (runtimeKey: string, sessionId: string, directory?: string): number => {
                    if (directory !== undefined) return get().queueDeletionGenerations[getMessageQueueKey({ runtimeKey, directory, sessionId })] ?? 0;
                    return Object.entries(get().queueDeletionGenerations).reduce((max, [key, value]) => {
                        const parsed = parseMessageQueueKey(key);
                        return parsed?.runtimeKey === runtimeKey && parsed.sessionId === sessionId ? Math.max(max, value) : max;
                    }, 0);
                };

                const enqueueChainedMutation = <T,>(chains: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> => {
                    const previous = chains.get(key);
                    const current = previous === undefined ? operation() : previous.catch(() => undefined).then(operation);
                    const settled = current.then(() => undefined, () => undefined);
                    chains.set(key, settled);
                    void settled.then(() => {
                        if (chains.get(key) === settled) chains.delete(key);
                    });
                    return current;
                };

                const prepareServerMutation = <T,>(target: MessageQueueTarget | MessageQueueHoldTarget, operation: () => Promise<T>, options: MessageQueueHoldOptions): (() => Promise<T>) => {
                    const deletionGeneration = getQueueDeletionGeneration(target.runtimeKey, target.sessionId, 'directory' in target ? target.directory : undefined);
                    const key = getServerSessionKey(target.runtimeKey, target.sessionId);
                    return () => {
                        if (!options.releaseForRuntimeSwitch) assertTargetRuntime(target);
                        if (!options.releaseObsoleteTarget && serverSessionDeleted.has(key)) throw staleSessionError();
                        if ('directory' in target && !options.releaseObsoleteTarget) {
                            const authoritativeDirectory = serverSessionDirectories.get(key);
                            if (authoritativeDirectory !== undefined && authoritativeDirectory !== target.directory) throw staleSessionError();
                        }
                        if (
                            !options.releaseObsoleteTarget
                            && getQueueDeletionGeneration(target.runtimeKey, target.sessionId, 'directory' in target ? target.directory : undefined) !== deletionGeneration
                        ) throw staleSessionError();
                        return operation();
                    };
                };

                const enqueueServerMutation = <T,>(target: MessageQueueTarget | MessageQueueHoldTarget, operation: () => Promise<T>, options: MessageQueueHoldOptions = {}): Promise<T> => {
                    const key = getServerSessionKey(target.runtimeKey, target.sessionId);
                    return enqueueChainedMutation(serverMutationChains, key, prepareServerMutation(target, operation, options));
                };

                // Runtime-switch cleanup must not wait behind an assertion that
                // is still awaiting the old runtime. It has its own ordered
                // lane so retries remain serialized with one another without
                // delaying the first release until the old request times out.
                const enqueueServerHoldRelease = <T,>(target: MessageQueueHoldTarget, operation: () => Promise<T>, options: MessageQueueHoldOptions = {}): Promise<T> => {
                    const key = getServerSessionKey(target.runtimeKey, target.sessionId);
                    return enqueueChainedMutation(
                        serverHoldReleaseChains,
                        key,
                         prepareServerMutation(target, operation, { ...options, releaseForRuntimeSwitch: true }),
                    );
                };

                const clearPendingServerHoldRelease = (target: MessageQueueHoldTarget, sequence?: number): void => {
                    const key = getServerSessionKey(target.runtimeKey, target.sessionId);
                    const pending = pendingServerHoldReleases.get(key);
                    if (!pending) return;
                    // A late response from an older assertion must not cancel
                    // the release it predates. A newer sequence may supersede
                    // that release, but only that newer mutation can clear it.
                    if (sequence !== undefined && pending.sequence > sequence) return;
                    if (pending.timer !== undefined) clearTimeout(pending.timer);
                    pendingServerHoldReleases.delete(key);
                };

                const scheduleServerHoldReleaseRetry = (pending: PendingServerHoldRelease): void => {
                    const key = getServerSessionKey(pending.target.runtimeKey, pending.target.sessionId);
                    if (pendingServerHoldReleases.get(key) !== pending) return;
                    const delay = HOLD_RELEASE_RETRY_DELAYS_MS[pending.retryIndex];
                    if (delay === undefined) {
                        pendingServerHoldReleases.delete(key);
                        console.warn('[queue] giving up on a failed queue-hold release after bounded retries');
                        return;
                    }
                    pending.retryIndex += 1;
                    pending.timer = setTimeout(() => {
                        pending.timer = undefined;
                        if (pendingServerHoldReleases.get(key) !== pending) return;
                        void convergeServerHoldMutation(pending.target, false, pending.sequence, {
                            releaseForRuntimeSwitch: true,
                        }).then(() => {
                            if (pendingServerHoldReleases.get(key) === pending) pendingServerHoldReleases.delete(key);
                        }).catch((error) => {
                            if (pendingServerHoldReleases.get(key) !== pending || !(error instanceof Error) || !shouldRetryServerHoldRelease(error)) {
                                if (pendingServerHoldReleases.get(key) === pending) pendingServerHoldReleases.delete(key);
                                return;
                            }
                            scheduleServerHoldReleaseRetry(pending);
                        });
                    }, delay);
                };

                const sendServerHoldMutation = async (
                    target: MessageQueueHoldTarget,
                    held: boolean,
                    sequence: number,
                    options: MessageQueueHoldOptions,
                ): Promise<ServerHoldResponse> => {
                    const init = queueMutationInit(target, 'PUT', {
                        held,
                        generation: target.generation,
                        sequence,
                        clientToken: target.clientToken,
                    }, target.generation);
                    if (options.releaseForRuntimeSwitch && target.runtimeTarget) init.runtimeTarget = target.runtimeTarget;
                    const send = () => requestJson(serverHoldResponseSchema, `${sessionPath(target.sessionId)}/hold`, init);
                    const result = await (options.releaseForRuntimeSwitch
                        ? enqueueServerHoldRelease(target, send, options)
                        : enqueueServerMutation(target, send));
                    observeServerHoldMutationSequence(target, result.sequence);
                    return result;
                };

                /**
                 * The server refuses a mutation it does not apply and echoes the
                 * sequence it currently holds: a stale same-token sequence, or a
                 * different active owner. Follow that echo with a fresh sequence
                 * so an assert or release converges instead of being abandoned.
                 * Bounded here; releases that still fail land in the pending
                 * release lane, which owns the longer backoff.
                 */
                const convergeServerHoldMutation = async (
                    target: MessageQueueHoldTarget,
                    held: boolean,
                    sequence: number,
                    options: MessageQueueHoldOptions,
                ): Promise<number> => {
                    let attemptSequence = sequence;
                    for (let attempt = 0; ; attempt += 1) {
                        const result = await sendServerHoldMutation(target, held, attemptSequence, options);
                        const settled = held
                            ? result.held && (result.sequence === undefined || result.sequence === attemptSequence)
                            : !result.held;
                        if (settled) return attemptSequence;
                        const echoed = result.sequence;
                        if (echoed === undefined || echoed === attemptSequence || attempt >= MAX_HOLD_MUTATION_ECHO_RETRIES) {
                            // A held session owned by another token satisfies an
                            // assertion: the queue stays held while that owner
                            // lasts, and the next re-assert tries again. Only a
                            // release that keeps being refused is an error.
                            if (held && result.held) return attemptSequence;
                            throw new Error(held ? 'Queue hold was not accepted' : 'Queue hold release was not accepted');
                        }
                        attemptSequence = echoed + 1;
                    }
                };

                /** Server state wins; a failed round-trip re-reads it instead of guessing. */
                const refreshSession = async (target: MessageQueueTarget) => {
                    try {
                        const snapshot = await requestJson(serverSnapshotSchema, '/api/message-queue');
                        applyServerSnapshot(snapshot, target.runtimeKey);
                    } catch {
                        // Offline: keep the optimistic projection; the next broadcast or hydration corrects it.
                    }
                };

                 const serverMutation = async (
                     target: MessageQueueTarget,
                     path: string,
                     init: RequestInit,
                 ): Promise<boolean> => {
                    try {
                        const result = await enqueueServerMutation(target, () => requestJson(serverSessionResponseSchema, path, init));
                        applyServerSession(result.session, result.revision, target.runtimeKey);
                        return true;
                    } catch (error) {
                        console.warn('[queue] server update failed:', error);
                        await refreshSession(target);
                         return false;
                     }
                 };

                 type ServerEnqueueResult = z.infer<typeof serverEnqueueResponseSchema>;
                 type ServerEnqueueMutationResult = {
                     result: ServerEnqueueResult;
                     acceptedItemId?: string;
                     removedFromServer: boolean;
                 };

                 /**
                  * Keep an enqueue and its compensating delete in one chain
                  * callback. Calling serverMutation for the delete here would
                  * wait on this callback's own keyed chain.
                  */
                 const enqueueServerEnqueueMutation = async (
                     target: MessageQueueTarget,
                     enqueueKey: string,
                     message: QueuedMessage,
                     sendConfig: QueuedMessageSendConfig,
                     operation: () => Promise<ServerEnqueueResult>,
                 ): Promise<ServerEnqueueMutationResult> => {
                     let acceptedItemId: string | undefined;
                     let removedFromServer = false;
                     const result = await enqueueServerMutation(target, async () => {
                         const accepted = await operation();
                         serverOwnedRuntimeKeys.add(target.runtimeKey);
                         acceptedItemId = accepted.itemId ?? findAcceptedQueueItemId(accepted.session, message, sendConfig);
                         if (acceptedItemId) {
                             set((state) => {
                                 const current = state.pendingServerEnqueues[enqueueKey];
                                 if (!current) return state;
                                 return {
                                     pendingServerEnqueues: {
                                         ...state.pendingServerEnqueues,
                                         [enqueueKey]: { ...current, acceptedItemId },
                                     },
                                 };
                             });
                         }

                         const pending = get().pendingServerEnqueues[enqueueKey];
                         if (!pending?.removed || !acceptedItemId) return accepted;
                         try {
                             const removed = await requestJson(
                                 serverSessionResponseSchema,
                                 `${sessionPath(target.sessionId)}/items/${encodeURIComponent(acceptedItemId)}`,
                                 queueMutationInit(target, 'DELETE'),
                             );
                             applyServerSession(removed.session, removed.revision, target.runtimeKey);
                             removedFromServer = true;
                         } catch (error) {
                             await refreshSession(target);
                             throw error;
                         }
                         return accepted;
                     });
                     return { result, acceptedItemId, removedFromServer };
                 };

                const clearTakenOperation = (target: MessageQueueTarget, operationId: string, messages: readonly QueuedMessage[]): void => {
                    const sessionKey = getServerSessionKey(target.runtimeKey, target.sessionId);
                    set((state) => ({
                        pendingServerTakes: Object.fromEntries(
                            Object.entries(state.pendingServerTakes).filter(([, pending]) => pending.operationId !== operationId),
                        ),
                        pendingServerTakeAcks: Object.fromEntries(
                            Object.entries(state.pendingServerTakeAcks).filter(([, pending]) => pending.operationId !== operationId),
                        ),
                        takenServerOperations: messages.length > 0
                            ? clearTakenServerOperations(state.takenServerOperations, target, messages)
                            : withoutKey(state.takenServerOperations, sessionKey),
                    }));
                    clearTakenServerTracking(target, messages.map((message) => message.id));
                };

                const clearPendingServerTakeAck = (target: MessageQueueTarget, operationId: string): void => {
                    const key = `${getMessageQueueKey(target)}\n${operationId}`;
                    set((state) => ({ pendingServerTakeAcks: withoutKey(state.pendingServerTakeAcks, key) }));
                };

                const acknowledgeServerTake = async (
                    target: MessageQueueTarget,
                    operationId: string,
                    generation: number | undefined,
                ): Promise<void> => {
                    await enqueueServerMutation(target, () => requestJson(
                        z.object({ acknowledged: z.boolean() }),
                        `${sessionPath(target.sessionId)}/take-receipts/${encodeURIComponent(operationId)}/ack`,
                        queueMutationInit(target, 'POST', { generation }, generation),
                    ));
                };

                const isPendingTakeCurrent = (target: MessageQueueTarget, pending: PendingServerTake): boolean => {
                    const key = getMessageQueueKey(target);
                    const current = get().pendingServerTakes[key];
                    return current?.operationId === pending.operationId
                        && current.deletionGeneration === (get().queueDeletionGenerations[key] ?? 0)
                        && !current.invalidated
                        && !serverSessionDeleted.has(getServerSessionKey(target.runtimeKey, target.sessionId))
                        && target.runtimeKey === getRuntimeKey();
                };

                const finishTakenServerBatch = async (
                    target: MessageQueueTarget,
                    pending: PendingServerTake,
                    result: z.infer<typeof serverTakeResponseSchema> | z.infer<typeof serverTakeAllResponseSchema>,
                    messages: QueuedMessage[],
                ): Promise<QueuedMessage[]> => {
                    const current = get().pendingServerTakes[getMessageQueueKey(target)];
                    if (!isPendingTakeCurrent(target, pending)) {
                        if (current?.operationId === pending.operationId && !serverSessionDeleted.has(getServerSessionKey(target.runtimeKey, target.sessionId))) {
                            try {
                                await acknowledgeServerTake(
                                    current.target,
                                    pending.operationId,
                                    current.serverGeneration ?? current.takeGeneration,
                                );
                                clearTakenOperation(current.target, pending.operationId, messages);
                            } catch {
                                // Keep the invalidated receipt durable. Hydration
                                // retries its acknowledgement without sending it.
                            }
                        }
                        return [];
                    }

                    if (messages.length === 0) {
                        applyServerSession(result.session, result.revision, target.runtimeKey, false, pending.operationId);
                        const generation = result.generation ?? pending.takeGeneration;
                        const ack: PendingServerTakeAck = {
                            target: { ...target },
                            operationId: pending.operationId,
                        };
                        if (generation !== undefined) ack.generation = generation;
                        set((state) => ({
                            pendingServerTakes: withoutKey(state.pendingServerTakes, getMessageQueueKey(target)),
                            pendingServerTakeAcks: {
                                ...state.pendingServerTakeAcks,
                                [`${getMessageQueueKey(target)}\n${pending.operationId}`]: ack,
                            },
                        }));
                        try {
                            await acknowledgeServerTake(target, pending.operationId, generation);
                            clearPendingServerTakeAck(target, pending.operationId);
                        } catch (error) {
                            if (error instanceof Error && isTerminalPendingOperationError(error)) clearPendingServerTakeAck(target, pending.operationId);
                        }
                        return [];
                    }

                    const serverGeneration = result.generation ?? pending.takeGeneration;
                    for (const item of messages) {
                        setTakenServerGeneration(getMessageQueueKey(target), item.id, serverGeneration ?? 0);
                        setTakenServerRevision(getMessageQueueKey(target), item.id, result.revision);
                    }
                    set((state) => ({
                        pendingServerTakes: {
                            ...state.pendingServerTakes,
                            [getMessageQueueKey(target)]: {
                                ...pending,
                                serverGeneration,
                            },
                        },
                        takenServerOperations: messages.reduce(
                            (operations, message) => setTakenServerOperation(operations, target, message.id, pending.operationId),
                            state.takenServerOperations,
                        ),
                    }));
                    applyServerSession(result.session, result.revision, target.runtimeKey, false, pending.operationId);
                    return messages;
                };

                const recoverPendingServerTakes = async (runtimeKey: string, expectedHydrationGeneration: number): Promise<void> => {
                    for (const [ackKey, pendingAck] of Object.entries(get().pendingServerTakeAcks)) {
                        if (pendingAck.target.runtimeKey !== runtimeKey) continue;
                        if (expectedHydrationGeneration !== hydrationGeneration || runtimeKey !== getRuntimeKey()) return;
                        try {
                            await acknowledgeServerTake(pendingAck.target, pendingAck.operationId, pendingAck.generation);
                            set((state) => ({
                                pendingServerTakeAcks: withoutKey(state.pendingServerTakeAcks, ackKey),
                                takenServerOperations: pendingAck.messageIds
                                    ? clearTakenServerOperationIds(state.takenServerOperations, pendingAck.target, pendingAck.messageIds)
                                    : state.takenServerOperations,
                            }));
                            if (pendingAck.messageIds) clearTakenServerTracking(pendingAck.target, pendingAck.messageIds);
                        } catch (error) {
                            if (error instanceof Error && isTerminalPendingOperationError(error)) {
                                set((state) => ({ pendingServerTakeAcks: withoutKey(state.pendingServerTakeAcks, ackKey) }));
                            }
                        }
                    }
                    const pendingTakes = Object.values(get().pendingServerTakes)
                        .filter((pending) => pending.target.runtimeKey === runtimeKey);
                    for (const pending of pendingTakes) {
                        if (expectedHydrationGeneration !== hydrationGeneration || runtimeKey !== getRuntimeKey()) return;
                        const key = getMessageQueueKey(pending.target);
                        const current = get().pendingServerTakes[key];
                        if (!current || current.operationId !== pending.operationId) continue;

                        const lifecycleGeneration = getServerSessionLifecycleGeneration(pending.target);
                        if (
                            pending.takeGeneration !== undefined
                            && lifecycleGeneration !== undefined
                            && pending.takeGeneration !== lifecycleGeneration
                        ) {
                            set((state) => ({
                                pendingServerTakes: withoutKey(state.pendingServerTakes, key),
                                takenServerOperations: withoutKey(
                                    state.takenServerOperations,
                                    getServerSessionKey(pending.target.runtimeKey, pending.target.sessionId),
                                ),
                            }));
                            continue;
                        }

                        if (current.invalidated) {
                            if (serverSessionDeleted.has(getServerSessionKey(runtimeKey, pending.target.sessionId))) {
                                set((state) => ({ pendingServerTakes: withoutKey(state.pendingServerTakes, key) }));
                                continue;
                            }
                            try {
                                await acknowledgeServerTake(
                                    pending.target,
                                    pending.operationId,
                                    current.serverGeneration ?? current.takeGeneration,
                                );
                                clearTakenOperation(pending.target, pending.operationId, []);
                            } catch (error) {
                                // The invalidated receipt stays durable and is
                                // retried by the next hydration.
                                if (error instanceof Error && isTerminalPendingOperationError(error)) {
                                    set((state) => ({ pendingServerTakes: withoutKey(state.pendingServerTakes, key) }));
                                }
                            }
                            continue;
                        }

                        let result: z.infer<typeof serverTakeResponseSchema> | z.infer<typeof serverTakeAllResponseSchema>;
                        try {
                            if (pending.messageId) {
                                result = await enqueueServerMutation(pending.target, () => requestJson(
                                    serverTakeResponseSchema,
                                    `${sessionPath(pending.target.sessionId)}/items/${encodeURIComponent(pending.messageId ?? '')}/take`,
                                    queueMutationInit(pending.target, 'POST', {
                                        operationId: pending.operationId,
                                        requireHead: pending.requireHead === true,
                                        generation: pending.takeGeneration,
                                    }, pending.takeGeneration),
                                ));
                            } else {
                                result = await enqueueServerMutation(pending.target, () => requestJson(
                                    serverTakeAllResponseSchema,
                                    `${sessionPath(pending.target.sessionId)}/take`,
                                    queueMutationInit(pending.target, 'POST', {
                                        operationId: pending.operationId,
                                        generation: pending.takeGeneration,
                                    }, pending.takeGeneration),
                                ));
                            }
                        } catch (error) {
                            // A receipt may still be in flight at the server. Do
                            // not clear its only durable recovery handle.
                                if (error instanceof Error && isTerminalPendingOperationError(error)) {
                                set((state) => ({ pendingServerTakes: withoutKey(state.pendingServerTakes, key) }));
                            }
                            continue;
                        }
                        if (expectedHydrationGeneration !== hydrationGeneration || runtimeKey !== getRuntimeKey()) return;

                        const messages = 'item' in result
                            ? [toQueuedMessage(result.item)]
                            : result.items.map(toQueuedMessage);
                        const taken = await finishTakenServerBatch(pending.target, pending, result, messages);
                        if (taken.length === 0) continue;

                        const guard = get().getQueueRestorationGuard(pending.target);
                        guard.operationId = pending.operationId;
                        guard.mutationGeneration = result.generation ?? pending.takeGeneration;
                        await get().restoreQueue(pending.target, taken, guard);
                    }
                };

                return {
                    queuedMessages: {},
                    quarantinedLegacyMessages: {},
                    pendingLegacyMessages: {},
                    followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
                    queueDeletionGenerations: {},
                    sendingIds: {},
                    pendingServerRestores: {},
                    pendingServerTakes: {},
                    pendingServerTakeAcks: {},
                     pendingServerEnqueues: {},
                     takenServerOperations: {},
                     retryPendingIds: {},
                     serverSessionIdentityVersion: 0,

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
                        if (message.additionalParts && message.additionalParts.length > 0) queuedMessage.additionalParts = message.additionalParts;
                        if (message.capturedContext && message.capturedContext.length > 0) queuedMessage.capturedContext = message.capturedContext;
                        if (message.contextClaimed !== undefined) queuedMessage.contextClaimed = message.contextClaimed;
                        if (message.context && message.context.length > 0) queuedMessage.context = message.context;

                        const serverOwned = isServerOwnedMessageQueue();
                        if (serverOwned && !message.sendConfig) {
                            throw new Error('A queued message needs a provider and model to be delivered later.');
                        }
                        const enqueueKey = queueItemEphemeralKey(key, id);
                        const pendingEnqueue: PendingServerEnqueue | undefined = serverOwned
                            ? {
                                target: { ...target },
                                message: queuedMessage,
                                removed: false,
                                generation: getServerSessionLifecycleGeneration(target),
                                idempotencyKey: enqueueKey,
                            }
                            : undefined;

                        // Register ownership and the stable idempotency key in the
                        // same transaction as the optimistic projection. A page
                        // freeze between this point and POST must not leave a
                        // queue item with no durable removal barrier.
                        set((state) => {
                            const currentQueue = state.queuedMessages[key] ?? [];
                            const protectedIds = new Set(state.sendingIds[key] ?? []);
                            const queuedMessages = trimQueueTargets({
                                ...state.queuedMessages,
                                [key]: trimQueue([...currentQueue, queuedMessage], protectedIds),
                            }, state.sendingIds, state.retryPendingIds, key);
                            return pendingEnqueue
                                ? {
                                    queuedMessages,
                                    pendingServerEnqueues: {
                                        ...state.pendingServerEnqueues,
                                        [enqueueKey]: pendingEnqueue,
                                    },
                                }
                                : { queuedMessages };
                        });

                        if (!serverOwned) return id;
                        if (message.context && message.context.length > 0) {
                            setLocalQueueContext(key, id, message.context);
                        }
                        if (!pendingEnqueue) return id;
                        if (!message.sendConfig) return id;
                        const sendConfig = message.sendConfig;
                        const historyIdentity = createInputHistoryIdentity(target.runtimeKey, target.directory, target.sessionId);
                        const historySubmission = createInputHistorySubmission(message.content, message.attachments ?? []);
                        try {
                            const { result, acceptedItemId, removedFromServer } = await enqueueServerEnqueueMutation(target, enqueueKey, queuedMessage, sendConfig, () => requestJson(serverEnqueueResponseSchema, `${sessionPath(target.sessionId)}/items`, jsonInit('POST', {
                                 directory: target.directory,
                                 item: toServerItemInput(message, sendConfig),
                                 idempotencyKey: enqueueKey,
                                 generation: pendingEnqueue.generation,
                             })));
                            // The server accepted this item. Mark the runtime
                            // authoritative before replacing the optimistic
                            // projection, so a hydration already in flight
                            // cannot persist that projection and upload it
                             // again after a restart under a new key.
                             serverOwnedRuntimeKeys.add(target.runtimeKey);
                              const pending = get().pendingServerEnqueues[enqueueKey];
                              if (pending?.removed) {
                                // The remove happened before the server had an
                                // id for this item. Do not apply the POST's
                                // projection; remove the accepted server item
                                // instead, then let that response reconcile the
                                // remaining queue authoritatively.
                                if (acceptedItemId) moveLocalQueueContext(key, id, acceptedItemId);
                                 set((state) => removeMessageLocally(state, key, id));
                                  if (acceptedItemId) {
                                      if (removedFromServer) {
                                          set((state) => ({ pendingServerEnqueues: withoutKey(state.pendingServerEnqueues, enqueueKey) }));
                                      } else if (await serverMutation(
                                          target,
                                          `${sessionPath(target.sessionId)}/items/${encodeURIComponent(acceptedItemId)}`,
                                          queueMutationInit(target, 'DELETE'),
                                      )) {
                                          set((state) => ({ pendingServerEnqueues: withoutKey(state.pendingServerEnqueues, enqueueKey) }));
                                      }
                                  } else {
                                     await refreshSession(target);
                                 }
                                 return id;
                             }
                             if (acceptedItemId) moveLocalQueueContext(key, id, acceptedItemId);
                             else deleteLocalQueueContext(key, id);
                             // The optimistic entry is replaced by the server's copy of the queue.
                             set((state) => removeMessageLocally(state, key, id));
                             applyServerSession(result.session, result.revision, target.runtimeKey);
                             set((state) => ({ pendingServerEnqueues: withoutKey(state.pendingServerEnqueues, enqueueKey) }));
                             if (historyIdentity) {
                                useInputHistoryStore.getState().appendSubmissions(historyIdentity, [historySubmission]);
                            }
                          } catch (error) {
                              const pending = get().pendingServerEnqueues[enqueueKey];
                              if (pending?.removed) {
                                      if (error instanceof Error && isTerminalPendingOperationError(error)) {
                                      set((state) => ({ pendingServerEnqueues: withoutKey(state.pendingServerEnqueues, enqueueKey) }));
                                      deleteLocalQueueContext(key, id);
                                      set((state) => removeMessageLocally(state, key, id));
                                  }
                               } else if (pending && error instanceof Error && isTerminalPendingOperationError(error)) {
                                  set((state) => ({
                                      pendingServerEnqueues: {
                                          ...state.pendingServerEnqueues,
                                          [enqueueKey]: { ...pending, blocked: true },
                                      },
                                  }));
                              }
                             throw error;
                        }
                        return id;
                    },

                    removeFromQueue: (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        const state = get();
                        if (isQueueMessageInFlight(state.sendingIds[key] ?? [], messageId)) return null;
                        const removed = (state.queuedMessages[key] ?? []).find((message) => message.id === messageId) ?? null;
                        if (!removed) return null;
                        const isPendingCompatibility = (state.pendingLegacyMessages[key] ?? []).some((message) => message.id === messageId);
                        set((currentState) => removeMessageLocally(currentState, key, messageId));
                        let pendingServerEnqueue = false;
                        if (isServerOwnedMessageQueue()) {
                            set((currentState) => {
                                const marked = markPendingServerEnqueueRemoved(currentState.pendingServerEnqueues, key, messageId);
                                pendingServerEnqueue = marked.found;
                                const pendingTake = currentState.pendingServerTakes[key];
                                const invalidatedTake = pendingTake && (
                                    pendingTake.messageId === messageId || pendingTake.messageId === undefined
                                )
                                    ? {
                                        ...pendingTake,
                                        invalidated: true,
                                        invalidatedMessageIds: pendingTake.messageId === undefined
                                            ? [...new Set([...(pendingTake.invalidatedMessageIds ?? []), messageId])]
                                            : pendingTake.invalidatedMessageIds,
                                    }
                                    : pendingTake;
                                return {
                                    pendingServerEnqueues: marked.pendingEnqueues,
                                    pendingLegacyMessages: isPendingCompatibility
                                        ? ((currentState.pendingLegacyMessages[key] ?? []).filter((message) => message.id !== messageId).length > 0
                                            ? {
                                                ...currentState.pendingLegacyMessages,
                                                [key]: (currentState.pendingLegacyMessages[key] ?? []).filter((message) => message.id !== messageId),
                                            }
                                            : withoutKey(currentState.pendingLegacyMessages, key))
                                        : currentState.pendingLegacyMessages,
                                    pendingServerTakes: invalidatedTake
                                        ? { ...currentState.pendingServerTakes, [key]: invalidatedTake }
                                        : currentState.pendingServerTakes,
                                };
                            });
                        }
                        const localContext = getLocalQueueContext(key, messageId);
                        const removedWithContext = !removed.context && localContext
                            ? { ...removed, context: localContext }
                            : removed;
                        if (!isServerOwnedMessageQueue()) deleteLocalQueueContext(key, messageId);
                        if (isServerOwnedMessageQueue() && !pendingServerEnqueue && !isPendingCompatibility) {
                            void serverMutation(target, `${sessionPath(target.sessionId)}/items/${encodeURIComponent(messageId)}`, queueMutationInit(target, 'DELETE'));
                        }
                        return removedWithContext;
                    },

                    reorderQueue: (target, fromId, toId) => {
                        if (fromId === toId) return;
                        const key = getMessageQueueKey(target);
                        const currentQueue = get().queuedMessages[key];
                        if (!currentQueue) return;
                        const fromIndex = currentQueue.findIndex((m) => m.id === fromId);
                        const toIndex = currentQueue.findIndex((m) => m.id === toId);
                         if ((get().sendingIds[key] ?? []).length > 0 || fromIndex === -1 || toIndex === -1) return;

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
                            void serverMutation(target, `${sessionPath(target.sessionId)}/order`, queueMutationInit(target, 'PUT', { itemIds }));
                        }
                    },

                    popToInput: (target, messageId) => {
                        if (isServerOwnedMessageQueue()) {
                            const key = getMessageQueueKey(target);
                            const compatibilityMessage = get().pendingLegacyMessages[key]?.find((message) => message.id === messageId);
                            if (compatibilityMessage) {
                                set((state) => ({
                                    queuedMessages: removeMessageLocally(state, key, messageId).queuedMessages,
                                    pendingLegacyMessages: (state.pendingLegacyMessages[key] ?? []).filter((message) => message.id !== messageId).length > 0
                                        ? {
                                            ...state.pendingLegacyMessages,
                                            [key]: (state.pendingLegacyMessages[key] ?? []).filter((message) => message.id !== messageId),
                                        }
                                        : withoutKey(state.pendingLegacyMessages, key),
                                }));
                                return compatibilityMessage;
                            }
                            return get().takeForSend(target, messageId).then(([message]) => message ?? null);
                        }
                        const key = getMessageQueueKey(target);
                        const state = get();
                        const sending = state.sendingIds[key] ?? [];
                        const message = (state.queuedMessages[key] ?? []).find((item) => item.id === messageId);
                        if (!message || sending.includes(message.id)) return null;
                        set((currentState) => removeMessageLocally(currentState, key, messageId));
                        return message;
                    },

                      takeForSend: async (target, messageId, options = {}) => {
                          const key = getMessageQueueKey(target);
                          if (isServerOwnedMessageQueue()) {
                              const existingPendingTake = get().pendingServerTakes[key];
                              const localCompatibilityMessage = messageId
                                  ? get().pendingLegacyMessages[key]?.find((message) => message.id === messageId)
                                  : undefined;
                              if (localCompatibilityMessage && messageId) {
                                  set((state) => ({
                                      queuedMessages: removeMessageLocally(state, key, messageId).queuedMessages,
                                      pendingLegacyMessages: (state.pendingLegacyMessages[key] ?? []).filter((message) => message.id !== messageId).length > 0
                                          ? {
                                              ...state.pendingLegacyMessages,
                                              [key]: (state.pendingLegacyMessages[key] ?? []).filter((message) => message.id !== messageId),
                                          }
                                          : withoutKey(state.pendingLegacyMessages, key),
                                  }));
                                  return [localCompatibilityMessage];
                              }
                              if (existingPendingTake && !existingPendingTake.invalidated) return [];
                             const operationId = `take-${getMessageQueueClientToken(target.runtimeKey)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                             const pendingTake: PendingServerTake = {
                                 target: { ...target },
                                 operationId,
                                 deletionGeneration: get().queueDeletionGenerations[key] ?? 0,
                                 takeGeneration: getServerSessionLifecycleGeneration(target),
                             };
                            if (messageId) pendingTake.messageId = messageId;
                            if (options.requireHead) pendingTake.requireHead = true;
                            set((state) => ({
                                pendingServerTakes: { ...state.pendingServerTakes, [key]: pendingTake },
                            }));
                            if (messageId) {
                                let result: z.infer<typeof serverTakeResponseSchema>;
                                 try {
                                     result = await enqueueServerMutation(target, () => requestJson(
                                         serverTakeResponseSchema,
                                         `${sessionPath(target.sessionId)}/items/${encodeURIComponent(messageId)}/take`,
                                         queueMutationInit(target, 'POST', { operationId, requireHead: options.requireHead === true, generation: pendingTake.takeGeneration }, pendingTake.takeGeneration),
                                     ));
                                 } catch (error) {
                                     await refreshSession(target);
                                     throw error;
                                 }
                                 return finishTakenServerBatch(target, pendingTake, result, [toQueuedMessage(result.item)]);
                             }
                            let result: z.infer<typeof serverTakeAllResponseSchema>;
                             try {
                                 result = await enqueueServerMutation(target, () => requestJson(serverTakeAllResponseSchema, `${sessionPath(target.sessionId)}/take`, queueMutationInit(target, 'POST', { operationId, generation: pendingTake.takeGeneration }, pendingTake.takeGeneration)));
                             } catch (error) {
                                 await refreshSession(target);
                                 throw error;
                             }
                             return finishTakenServerBatch(target, pendingTake, result, result.items.map(toQueuedMessage));
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

                     acknowledgeTakenServerBatch: async (target, messages) => {
                         if (!isServerOwnedMessageQueue() || messages.length === 0) return;
                         const pendingTakes = Object.values(get().pendingServerTakes);
                         const operationTargets = new Map<string, { target: MessageQueueTarget; generation?: number }>();
                         for (const message of messages) {
                             const operationId = getTakenServerOperation(get().takenServerOperations, target, message.id)
                                 ?? pendingTakes.find((pending) => pending.target.runtimeKey === target.runtimeKey
                                     && pending.target.sessionId === target.sessionId
                                     && (pending.messageId === message.id || pending.messageId === undefined))?.operationId;
                             if (!operationId) continue;
                             const pending = pendingTakes.find((candidate) => candidate.operationId === operationId);
                             operationTargets.set(operationId, {
                                 target: pending?.target ?? target,
                                 generation: pending?.serverGeneration ?? pending?.takeGeneration,
                             });
                         }
                          const operationIds = new Set(operationTargets.keys());
                          for (const operationId of operationIds) {
                              const operation = operationTargets.get(operationId);
                              if (!operation) continue;
                              const operationMessages = messages.filter((message) => getTakenServerOperation(get().takenServerOperations, operation.target, message.id) === operationId);
                              try {
                                  await acknowledgeServerTake(operation.target, operationId, operation.generation);
                                  clearTakenOperation(operation.target, operationId, operationMessages);
                              } catch (error) {
                                  if (error instanceof Error && isTerminalPendingOperationError(error)) {
                                      clearTakenOperation(operation.target, operationId, operationMessages);
                                  } else {
                                      const pendingAck: PendingServerTakeAck = {
                                          target: { ...operation.target },
                                          operationId,
                                      };
                                      if (operation.generation !== undefined) pendingAck.generation = operation.generation;
                                      if (operationMessages.length > 0) pendingAck.messageIds = operationMessages.map((message) => message.id);
                                      set((state) => ({
                                          pendingServerTakes: Object.fromEntries(
                                              Object.entries(state.pendingServerTakes).filter(([, pending]) => pending.operationId !== operationId),
                                          ),
                                          pendingServerTakeAcks: {
                                              ...state.pendingServerTakeAcks,
                                              [`${getMessageQueueKey(operation.target)}\n${operationId}`]: pendingAck,
                                          },
                                      }));
                                  }
                                  throw error;
                              }
                          }
                     },

                      clearQueue: (target) => {
                          const key = getMessageQueueKey(target);
                          const sessionKey = getServerSessionKey(target.runtimeKey, target.sessionId);
                          const authoritativeDirectory = serverSessionDirectories.get(sessionKey);
                          const matchesTargetIdentity = (candidate: MessageQueueTarget): boolean => (
                              candidate.runtimeKey === target.runtimeKey
                              && candidate.sessionId === target.sessionId
                              && (getMessageQueueKey(candidate) === key || authoritativeDirectory === target.directory)
                          );
                          let removed: QueuedMessage[] = [];
                          set((state) => {
                            // Clearing drops what is still queued, never a message
                            // already handed to the server: that send will resolve
                            // and must find its entry to remove or restore.
                            const sending = state.sendingIds[key] ?? [];
                            const currentQueue = state.queuedMessages[key] ?? [];
                            removed = currentQueue.filter((message) => !sending.includes(message.id));
                            const retained = currentQueue.filter((m) => sending.includes(m.id));
                            const pendingLegacyMessages = withoutKey(state.pendingLegacyMessages, key);
                              let pendingServerTakes = state.pendingServerTakes;
                              for (const [pendingKey, pendingTake] of Object.entries(state.pendingServerTakes)) {
                                  if (!matchesTargetIdentity(pendingTake.target)) continue;
                                  pendingServerTakes = {
                                      ...pendingServerTakes,
                                      [pendingKey]: { ...pendingTake, invalidated: true, invalidateAll: true },
                                  };
                              }
                              let pendingServerRestores = state.pendingServerRestores;
                              for (const [pendingKey, pendingRestore] of Object.entries(state.pendingServerRestores)) {
                                  if (!matchesTargetIdentity(pendingRestore.target)) continue;
                                  pendingServerRestores = {
                                      ...pendingServerRestores,
                                      [pendingKey]: { ...pendingRestore, blocked: true },
                                  };
                              }
                             if (retained.length > 0) {
                                 return {
                                     queuedMessages: { ...state.queuedMessages, [key]: retained },
                                     pendingLegacyMessages,
                                     pendingServerTakes,
                                     pendingServerRestores,
                                 };
                             }
                             return {
                                 queuedMessages: withoutKey(state.queuedMessages, key),
                                 pendingLegacyMessages,
                                 pendingServerTakes,
                                 pendingServerRestores,
                             };
                         });
                        if (isServerOwnedMessageQueue()) {
                            set((state) => {
                                let pendingEnqueues = state.pendingServerEnqueues;
                                for (const message of removed) {
                                    pendingEnqueues = markPendingServerEnqueueRemoved(pendingEnqueues, key, message.id).pendingEnqueues;
                                }
                                return { pendingServerEnqueues: pendingEnqueues };
                            });
                        }
                        if (isServerOwnedMessageQueue()) {
                            void serverMutation(target, sessionPath(target.sessionId), queueMutationInit(target, 'DELETE'));
                        }
                        return removed;
                    },

                    forgetQueue: (target) => {
                        const key = getMessageQueueKey(target);
                        const sessionKey = getServerSessionKey(target.runtimeKey, target.sessionId);
                        appliedRevisions.delete(key);
                        appliedSessionRevisions.delete(sessionKey);
                        serverSessionLifecycleGenerations.delete(sessionKey);
                        serverSessionDirectories.delete(sessionKey);
                        serverSessionDirectoryRevisions.delete(sessionKey);
                        serverSessionDeleted.delete(sessionKey);
                        serverSessionRestoreRequirements.delete(sessionKey);
                        serverHoldMutationSequences.delete(sessionKey);
                        prunePersistedHoldMutationSequence(target.runtimeKey, target.sessionId);
                        clearLocalQueueContexts(key);
                        set((state) => ({
                            queuedMessages: withoutKey(state.queuedMessages, key),
                            pendingLegacyMessages: withoutKey(state.pendingLegacyMessages, key),
                            sendingIds: withoutKey(state.sendingIds, key),
                            queueDeletionGenerations: withoutKey(state.queueDeletionGenerations, key),
                            pendingServerRestores: withoutKey(state.pendingServerRestores, key),
                            pendingServerTakes: withoutKey(state.pendingServerTakes, key),
                            pendingServerTakeAcks: Object.fromEntries(Object.entries(state.pendingServerTakeAcks).filter(([ackKey]) => !ackKey.startsWith(`${key}\n`))),
                            takenServerOperations: withoutKey(state.takenServerOperations, sessionKey),
                            pendingServerEnqueues: Object.fromEntries(Object.entries(state.pendingServerEnqueues).filter(([pendingKey]) => !pendingKey.startsWith(`${JSON.stringify([key]).slice(0, -1)},`))),
                            retryPendingIds: withoutKey(state.retryPendingIds, key),
                        }));
                    },

                     clearAllQueues: () => {
                         set((state) => {
                             const queuedMessages: Record<string, QueuedMessage[]> = {};
                             let pendingEnqueues = state.pendingServerEnqueues;
                             const pendingServerTakes = { ...state.pendingServerTakes };
                             const pendingServerRestores = { ...state.pendingServerRestores };
                             const keys = new Set([
                             ...Object.keys(state.queuedMessages),
                                 ...Object.keys(state.pendingLegacyMessages),
                                 ...Object.keys(state.pendingServerEnqueues),
                                ...Object.keys(state.pendingServerTakes),
                                ...Object.keys(state.pendingServerRestores),
                            ]);
                            for (const key of keys) {
                                const queue = state.queuedMessages[key] ?? [];
                                const sending = new Set(state.sendingIds[key] ?? []);
                                const retained = queue.filter((message) => sending.has(message.id));
                                if (retained.length > 0) queuedMessages[key] = retained;
                                if (isServerOwnedMessageQueue()) pendingEnqueues = markPendingServerEnqueuesRemoved(pendingEnqueues, key);
                                 const pendingTake = pendingServerTakes[key];
                                 if (pendingTake) pendingServerTakes[key] = { ...pendingTake, invalidated: true, invalidateAll: true };
                                 const pendingRestore = pendingServerRestores[key];
                                 if (pendingRestore) pendingServerRestores[key] = { ...pendingRestore, blocked: true };
                             }
                              return {
                                 queuedMessages,
                                 pendingLegacyMessages: {},
                                  pendingServerEnqueues: pendingEnqueues,
                                  pendingServerTakes,
                                  pendingServerRestores,
                              };
                        });
                    },

                     markSending: (target, messageId) => {
                         const key = getMessageQueueKey(target);
                         let claimed = false;
                        set((state) => {
                            const current = state.sendingIds[key] ?? [];
                            const queue = state.queuedMessages[key] ?? [];
                            if (current.length > 0 || (!isServerOwnedMessageQueue() && !isQueueMessageDispatchable(queue, current, messageId))) {
                                return state;
                            }
                            claimed = true;
                            return { sendingIds: { ...state.sendingIds, [key]: [...current, messageId] } };
                         });
                         return claimed;
                     },

                     claimLocalSend: (target, messageId) => {
                         const key = getMessageQueueKey(target);
                         let claimed: QueuedMessage | null = null;
                         set((state) => {
                             if (isServerOwnedMessageQueue()) return state;
                             const current = state.sendingIds[key] ?? [];
                             const head = state.queuedMessages[key]?.[0];
                             if (current.length > 0 || !head || head.id !== messageId) return state;
                             claimed = head;
                             return { sendingIds: { ...state.sendingIds, [key]: [messageId] } };
                         });
                         return claimed;
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

                    completeSending: (target, messageId) => {
                        const key = getMessageQueueKey(target);
                        set((state) => {
                            const currentSending = state.sendingIds[key] ?? [];
                            if (!isQueueMessageInFlight(currentSending, messageId)) return state;
                            const queuedMessages = (state.queuedMessages[key] ?? []).filter((message) => message.id !== messageId);
                            const sendingIds = currentSending.filter((id) => id !== messageId);
                            return {
                                queuedMessages: queuedMessages.length > 0
                                    ? { ...state.queuedMessages, [key]: queuedMessages }
                                    : withoutKey(state.queuedMessages, key),
                                sendingIds: sendingIds.length > 0
                                    ? { ...state.sendingIds, [key]: sendingIds }
                                    : withoutKey(state.sendingIds, key),
                            };
                        });
                    },

                    getSendableQueue: (target) => {
                        const key = getMessageQueueKey(target);
                        const state = get();
                        const queue = state.queuedMessages[key] ?? [];
                        if (isServerOwnedMessageQueue()) return [];
                        const sending = state.sendingIds[key];
                        if (!sending || sending.length === 0) return queue;
                        return [];
                    },

                    getQueueDispatchState: (target) => {
                        const key = getMessageQueueKey(target);
                        const state = get();
                        return {
                            head: (state.queuedMessages[key] ?? [])[0] ?? null,
                            sendingIds: state.sendingIds[key] ?? [],
                        };
                    },

                     getQueueRestorationGuard: (target) => {
                        const key = getMessageQueueKey(target);
                        const sessionKey = getServerSessionKey(target.runtimeKey, target.sessionId);
                        const pendingTake = get().pendingServerTakes[key];
                         return {
                             target: { ...target },
                             serverOwned: isServerOwnedMessageQueue(),
                             deletionGeneration: get().queueDeletionGenerations[key] ?? 0,
                            mutationGeneration: getServerSessionLifecycleGeneration(target),
                            authoritativeDirectory: serverSessionDirectories.get(sessionKey) ?? target.directory,
                            authoritativeDirectoryRevision: serverSessionDirectoryRevisions.get(sessionKey) ?? -1,
                            requiresReceipt: serverSessionRestoreRequirements.has(sessionKey),
                            operationId: pendingTake?.operationId,
                        };
                    },

                    isQueueRestorationGuardCurrent: (target, guard) => {
                        const key = getMessageQueueKey(target);
                        return target.runtimeKey === getRuntimeKey()
                            && guard.target.runtimeKey === target.runtimeKey
                            && guard.target.sessionId === target.sessionId
                            && getMessageQueueKey(guard.target) === key
                            && (get().queueDeletionGenerations[key] ?? 0) === guard.deletionGeneration
                            && guard.authoritativeDirectory === (serverSessionDirectories.get(getServerSessionKey(target.runtimeKey, target.sessionId)) ?? target.directory)
                            && guard.authoritativeDirectoryRevision === (serverSessionDirectoryRevisions.get(getServerSessionKey(target.runtimeKey, target.sessionId)) ?? -1)
                            && guard.requiresReceipt === serverSessionRestoreRequirements.has(getServerSessionKey(target.runtimeKey, target.sessionId))
                            && !get().pendingServerTakes[key]?.invalidated
                            && (guard.mutationGeneration === undefined || guard.mutationGeneration === getServerSessionLifecycleGeneration(target));
                    },

                     restoreQueue: async (target, messages, guard) => {
                         if (messages.length === 0) return true;
                         const key = getMessageQueueKey(target);
                         const serverOwned = guard.serverOwned ?? isServerOwnedMessageQueue();
                         const restoreLocally = (): boolean => {
                             let restoredAny = false;
                             set((state) => {
                                 if (!get().isQueueRestorationGuardCurrent(target, guard) || target.runtimeKey !== getRuntimeKey()) return state;
                                const currentQueue = state.queuedMessages[key] ?? [];
                                const existingIds = new Set(currentQueue.map((message) => message.id));
                                const restoredMessages = messages.filter((message) => !existingIds.has(message.id));
                                if (restoredMessages.length === 0) return state;
                                restoredAny = true;
                                const sending = new Set(state.sendingIds[key] ?? []);
                                const inFlight = currentQueue.filter((message) => sending.has(message.id));
                                const later = currentQueue.filter((message) => !sending.has(message.id));
                                const combined = [...inFlight, ...restoredMessages, ...later];
                                const overflow = Math.max(0, combined.length - MAX_MESSAGES_PER_QUEUE);
                                const dropped = new Set(
                                    combined.filter((message) => !sending.has(message.id)).slice(0, overflow).map((message) => message.id),
                                );
                                return { queuedMessages: { ...state.queuedMessages, [key]: combined.filter((message) => !dropped.has(message.id)) } };
                            });
                             return restoredAny;
                         };
                         if (!serverOwned) {
                             if (!get().isQueueRestorationGuardCurrent(target, guard) || target.runtimeKey !== getRuntimeKey()) return false;
                             return restoreLocally();
                         }
                         const state = get();
                         const sessionKey = getServerSessionKey(target.runtimeKey, target.sessionId);
                         const pendingTake = state.pendingServerTakes[key];
                         const capturedOperationId = guard.operationId
                             ?? messages.map((message) => getTakenServerOperation(state.takenServerOperations, target, message.id)).find((value): value is string => Boolean(value))
                         const requiresReceipt = guard.requiresReceipt || serverSessionRestoreRequirements.has(sessionKey);
                         if (requiresReceipt && !capturedOperationId) {
                             return false;
                         }
                         const operationId = capturedOperationId
                             ?? `restore-${getMessageQueueClientToken(target.runtimeKey)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                         const takenGeneration = pendingTake?.operationId === operationId
                             ? pendingTake.serverGeneration ?? pendingTake.takeGeneration
                             : messages.map((message) => takenServerGenerations.get(key)?.get(message.id)).find((value): value is number => value !== undefined);
                         const mutationGeneration = guard.mutationGeneration ?? takenGeneration;
                         const currentLifecycleGeneration = getServerSessionLifecycleGeneration(target);
                         const guardMutationGeneration = guard.mutationGeneration ?? (
                             currentLifecycleGeneration === undefined ? undefined : mutationGeneration
                         );
                         const authoritativeDirectory = serverSessionDirectories.get(sessionKey) ?? target.directory;
                         const authoritativeDirectoryRevision = serverSessionDirectoryRevisions.get(sessionKey) ?? -1;
                         const guardTargetMatches = guard.target.runtimeKey === target.runtimeKey
                             && guard.target.sessionId === target.sessionId
                             && getMessageQueueKey(guard.target) === key;
                          const identityChanged = guard.authoritativeDirectory !== authoritativeDirectory
                              || guard.authoritativeDirectoryRevision !== authoritativeDirectoryRevision;
                           const hardInvalidated = !guardTargetMatches
                               || (state.queueDeletionGenerations[key] ?? 0) !== guard.deletionGeneration
                               || serverSessionDeleted.has(sessionKey)
                               || pendingTake?.invalidated === true
                               || (guardMutationGeneration !== undefined && guardMutationGeneration !== currentLifecycleGeneration);
                          const effectiveGuard: MessageQueueRestorationGuard = {
                              ...guard,
                              requiresReceipt,
                              mutationGeneration: guardMutationGeneration,
                          };
                         const pending: PendingServerRestore = {
                             target: { ...target },
                             messages: messages.map((message) => ({ ...message })),
                             deletionGeneration: guard.deletionGeneration,
                             operationId,
                              sourceRevision: appliedRevisions.get(key),
                              mutationGeneration,
                          };
                           // Directory/identity changes are recoverable: keep
                           // the full take payload durable, but do not send it
                           // until retry can resolve the current owner.
                           if (hardInvalidated) return false;
                           set((state) => ({ pendingServerRestores: { ...state.pendingServerRestores, [key]: pending } }));
                           if (identityChanged) return false;
                         // The pending record is the recovery boundary. A
                         // captured operation may have completed against its
                         // original server just before the runtime switched,
                         // so retain it before rejecting the stale request.
                         if (!get().isQueueRestorationGuardCurrent(target, effectiveGuard) || target.runtimeKey !== getRuntimeKey()) return false;
                         try {
                              const requestTarget = authoritativeDirectory === target.directory
                                  ? target
                                  : { ...target, directory: authoritativeDirectory };
                              const result = await enqueueServerMutation(requestTarget, () => requestJson(serverSessionResponseSchema, `${sessionPath(requestTarget.sessionId)}/restore`, queueMutationInit(requestTarget, 'POST', {
                                  directory: requestTarget.directory,
                                  items: messages.map(toServerRestoreItemInput),
                                  operationId,
                                  generation: mutationGeneration,
                              }, mutationGeneration)));
                             set((state) => ({ pendingServerRestores: withoutKey(state.pendingServerRestores, key), retryPendingIds: withoutKey(state.retryPendingIds, key) }));
                             applyServerSession(result.session, result.revision, target.runtimeKey);
                             clearTakenOperation(target, operationId, messages);
                            return true;
                         } catch (error) {
                              console.warn('[queue] failed to restore queued messages on the server:', error);
                               if (!(error instanceof Error && isTerminalPendingOperationError(error))) {
                                  restoreLocally();
                              }
                              const invalidatedAfterRequest = get().pendingServerRestores[key]?.blocked === true;
                              set((state) => ({
                                  pendingServerRestores: {
                                      ...state.pendingServerRestores,
                                   [key]: { ...pending, blocked: invalidatedAfterRequest || (error instanceof Error && isTerminalPendingOperationError(error)) },
                                  },
                              retryPendingIds: error instanceof Error && isTerminalPendingOperationError(error)
                                     ? state.retryPendingIds
                                     : { ...state.retryPendingIds, [key]: messages.map((message) => message.id) },
                             }));
                             return false;
                        }
                    },

                    retryPendingServerRestores: async () => {
                        for (const pending of Object.values(get().pendingServerRestores)) {
                            if (pending.target.runtimeKey !== getRuntimeKey() || pending.blocked) continue;
                            const guard = get().getQueueRestorationGuard(pending.target);
                            guard.operationId = pending.operationId;
                            await get().restoreQueue(pending.target, pending.messages, guard);
                        }
                    },

                     clearQueueForSessionDeletion: (target) => {
                          const targetKey = getMessageQueueKey(target);
                          const sessionKey = getServerSessionKey(target.runtimeKey, target.sessionId);
                          const authoritativeDirectory = serverSessionDirectories.get(sessionKey);
                          const matchesTargetIdentity = (candidate: MessageQueueTarget | null): boolean => candidate !== null
                              && candidate.runtimeKey === target.runtimeKey
                              && candidate.sessionId === target.sessionId
                              && (getMessageQueueKey(candidate) === targetKey || authoritativeDirectory === target.directory);
                          clearLocalQueueContexts(targetKey);
                         serverHoldMutationSequences.delete(sessionKey);
                         prunePersistedHoldMutationSequence(target.runtimeKey, target.sessionId);
                         set((state) => {
                             // This is the scoped cleanup path used by a
                             // directory/session deletion identity. Explicit
                             // server tombstones use applyServerLifecycle when
                             // the server declares that a session id is gone
                             // across directory aliases; local cleanup must not
                             // erase a colliding session in another directory.
                              const keys = new Set([
                                  targetKey,
                                  ...Object.keys(state.queuedMessages),
                                  ...Object.keys(state.pendingServerEnqueues),
                                  ...Object.keys(state.pendingServerRestores),
                                  ...Object.keys(state.pendingServerTakes),
                              ].filter((key) => matchesTargetIdentity(parseMessageQueueKey(key))));
                             const queueDeletionGenerations = { ...state.queueDeletionGenerations };
                              const queuedMessages = { ...state.queuedMessages };
                              const sendingIds = { ...state.sendingIds };
                             let pendingServerEnqueues = state.pendingServerEnqueues;
                             let pendingServerRestores = state.pendingServerRestores;
                             let pendingServerTakes = state.pendingServerTakes;
                             for (const key of keys) {
                                 const parsed = parseMessageQueueKey(key);
                                 if (parsed?.runtimeKey !== target.runtimeKey || parsed.sessionId !== target.sessionId) continue;
                                 queueDeletionGenerations[key] = (queueDeletionGenerations[key] ?? 0) + 1;
                                 const sending = sendingIds[key] ?? [];
                                 const retained = (queuedMessages[key] ?? []).filter((message) => sending.includes(message.id));
                                 if (retained.length > 0) queuedMessages[key] = retained;
                                 else delete queuedMessages[key];
                                 if (sending.length > 0 && retained.length > 0) sendingIds[key] = sending;
                                 else delete sendingIds[key];
                                 clearLocalQueueContexts(key);
                                  pendingServerEnqueues = markPendingServerEnqueuesRemoved(pendingServerEnqueues, key);
                                 pendingServerRestores = withoutKey(pendingServerRestores, key);
                                 pendingServerTakes = withoutKey(pendingServerTakes, key);
                             }
                              return {
                                  queuedMessages,
                                  pendingLegacyMessages: withoutKey(state.pendingLegacyMessages, targetKey),
                                  sendingIds,
                                  queueDeletionGenerations,
                                  pendingServerRestores,
                                  pendingServerTakes,
                                   pendingServerTakeAcks: Object.fromEntries(Object.entries(state.pendingServerTakeAcks).filter(([ackKey, pending]) => !matchesTargetIdentity(pending.target) && !ackKey.startsWith(`${targetKey}\n`))),
                                 takenServerOperations: withoutKey(state.takenServerOperations, getServerSessionKey(target.runtimeKey, target.sessionId)),
                                 pendingServerEnqueues: isServerOwnedMessageQueue()
                                     ? pendingServerEnqueues
                                     : state.pendingServerEnqueues,
                                 retryPendingIds: Object.fromEntries(Object.entries(state.retryPendingIds).filter(([key]) => {
                                     const parsed = parseMessageQueueKey(key);
                                     return parsed?.runtimeKey !== target.runtimeKey || parsed.sessionId !== target.sessionId;
                                 })),
                             };
                         });
                    },

                    setFollowUpBehavior: (behavior) => {
                        const normalized = normalizeFollowUpBehavior(behavior);
                        set({ followUpBehavior: normalized });
                        void updateDesktopSettings({ followUpBehavior: normalized });
                    },

                    getQueueForTarget: (target) => {
                        return get().queuedMessages[getMessageQueueKey(target)] ?? [];
                    },

                      hydrate: () => {
                         if (!isServerOwnedMessageQueue()) return Promise.resolve();
                         const runtimeKey = getRuntimeKey();
                         if (hydrationInFlight?.runtimeKey === runtimeKey) return hydrationInFlight.promise;
                         const generation = ++hydrationGeneration;
                         const isCurrent = () => generation === hydrationGeneration && runtimeKey === getRuntimeKey();
                          const hydrateOnce = async (): Promise<void> => {
                              // Read authority before migrating a legacy projection.
                              // A failed read preserves the local and pending records.
                              const snapshot = await requestJson(serverSnapshotSchema, '/api/message-queue', { signal: AbortSignal.timeout(15_000) });
                             if (!isCurrent()) return;

                             const migrationEntries = new Map<string, { target: MessageQueueTarget; message: QueuedMessage }>();
                             const legacyEntries = Object.entries(get().queuedMessages)
                                 .map(([queueKey, queue]) => ({ target: parseMessageQueueKey(queueKey), queue }))
                                 .filter((entry): entry is { target: MessageQueueTarget; queue: QueuedMessage[] } => (
                                     entry.target !== null && entry.target.runtimeKey === runtimeKey && !serverOwnedRuntimeKeys.has(runtimeKey)
                                 ));

                             // Register every legacy operation before applying the
                             // snapshot. This keeps both valid migrations and
                             // missing-model compatibility work durable when the
                             // snapshot omits their session.
                             set((state) => {
                                 let pendingServerEnqueues = state.pendingServerEnqueues;
                                 let pendingLegacyMessages = state.pendingLegacyMessages;
                                 const registerLegacy = (target: MessageQueueTarget, message: QueuedMessage) => {
                                     const key = getMessageQueueKey(target);
                                     if (!message.sendConfig) {
                                         const current = pendingLegacyMessages[key] ?? [];
                                         if (!current.some((candidate) => candidate.id === message.id)) {
                                             pendingLegacyMessages = { ...pendingLegacyMessages, [key]: [...current, message] };
                                         }
                                         return;
                                     }
                                     const enqueueKey = queueItemEphemeralKey(key, message.id);
                                     migrationEntries.set(enqueueKey, { target, message });
                                     if (!pendingServerEnqueues[enqueueKey]) {
                                         pendingServerEnqueues = {
                                             ...pendingServerEnqueues,
                                             [enqueueKey]: {
                                                 target: { ...target },
                                                 message,
                                                 removed: false,
                                                 generation: getServerSessionLifecycleGeneration(target),
                                                 idempotencyKey: enqueueKey,
                                             },
                                         };
                                     }
                                 };
                                 for (const { target, queue } of legacyEntries) {
                                     for (const message of queue) registerLegacy(target, message);
                                 }
                                 for (const pending of Object.values(state.pendingServerEnqueues)) {
                                     if (pending.target.runtimeKey !== runtimeKey || pending.removed || pending.message.sendConfig) continue;
                                     registerLegacy(pending.target, pending.message);
                                 }
                                 for (const [key, messages] of Object.entries(pendingLegacyMessages)) {
                                     const target = parseMessageQueueKey(key);
                                     if (!target || target.runtimeKey !== runtimeKey) continue;
                                     for (const message of messages) registerLegacy(target, message);
                                 }
                              for (const pending of Object.values(state.pendingServerEnqueues)) {
                                  if (pending.target.runtimeKey !== runtimeKey || pending.blocked) continue;
                                     if (pending.message.sendConfig) {
                                         migrationEntries.set(
                                             queueItemEphemeralKey(getMessageQueueKey(pending.target), pending.message.id),
                                             { target: pending.target, message: pending.message },
                                         );
                                     }
                                 }
                                 return { pendingServerEnqueues, pendingLegacyMessages };
                             });

                             serverOwnedRuntimeKeys.add(runtimeKey);
                              const applied = applyServerSnapshot(snapshot, runtimeKey);
                              if (!applied && snapshot.complete === false) return;

                             // Resolve missing configuration only after the
                             // snapshot has established the current runtime's
                             // authority. An unresolved item stays visible and
                             // durable for explicit edit/requeue.
                             const resolvedLegacyEntries: Array<{ key: string; target: MessageQueueTarget; message: QueuedMessage }> = [];
                             for (const [key, messages] of Object.entries(get().pendingLegacyMessages)) {
                                 const target = parseMessageQueueKey(key);
                                 if (!target || target.runtimeKey !== runtimeKey) continue;
                                 const sendConfig = await resolveLegacySendConfig(target);
                                 if (!sendConfig) continue;
                                 for (const message of messages) {
                                     resolvedLegacyEntries.push({ key, target, message: { ...message, sendConfig } });
                                 }
                             }
                             set((state) => {
                                 let pendingLegacyMessages = state.pendingLegacyMessages;
                                 let pendingServerEnqueues = state.pendingServerEnqueues;
                                 let queuedMessages = state.queuedMessages;
                                 for (const { key, target, message: resolvedMessage } of resolvedLegacyEntries) {
                                      const enqueueKey = queueItemEphemeralKey(key, resolvedMessage.id);
                                         pendingServerEnqueues = {
                                             ...pendingServerEnqueues,
                                             [enqueueKey]: pendingServerEnqueues[enqueueKey] ?? {
                                                 target: { ...target },
                                                 message: resolvedMessage,
                                                 removed: false,
                                                 generation: getServerSessionLifecycleGeneration(target),
                                                 idempotencyKey: enqueueKey,
                                             },
                                         };
                                         migrationEntries.set(enqueueKey, { target, message: resolvedMessage });
                                         const queue = queuedMessages[key] ?? [];
                                         queuedMessages = {
                                             ...queuedMessages,
                                              [key]: queue.map((candidate) => candidate.id === resolvedMessage.id ? resolvedMessage : candidate),
                                          };
                                          const remaining = pendingLegacyMessages[key]?.filter((candidate) => candidate.id !== resolvedMessage.id) ?? [];
                                         pendingLegacyMessages = remaining.length > 0
                                             ? { ...pendingLegacyMessages, [key]: remaining }
                                             : withoutKey(pendingLegacyMessages, key);
                                 }
                                 return { queuedMessages, pendingLegacyMessages, pendingServerEnqueues };
                             });

                             // Pending records are the durable source for local
                             // projections while their request is unresolved.
                             set((state) => {
                                 let queuedMessages = state.queuedMessages;
                                 for (const pending of Object.values(state.pendingServerEnqueues)) {
                                     if (pending.target.runtimeKey !== runtimeKey || pending.removed || pending.blocked) continue;
                                     const key = getMessageQueueKey(pending.target);
                                     const queue = queuedMessages[key] ?? [];
                                     if (queue.some((message) => message.id === pending.message.id)) continue;
                                     queuedMessages = { ...queuedMessages, [key]: [...queue, pending.message] };
                                 }
                                 return { queuedMessages };
                             });

                              for (const [enqueueKey, { target, message }] of migrationEntries) {
                                 if (!isCurrent()) return;
                                 const pending = get().pendingServerEnqueues[enqueueKey];
                                 if (!pending || pending.blocked || !message.sendConfig) continue;
                                 if (pending.removed && !pending.acceptedItemId) {
                                     set((state) => ({
                                         queuedMessages: removeMessageLocally(state, getMessageQueueKey(target), message.id).queuedMessages,
                                         pendingServerEnqueues: withoutKey(state.pendingServerEnqueues, enqueueKey),
                                     }));
                                     continue;
                                 }
                                 if (pending.removed && pending.acceptedItemId) {
                                     const removedFromServer = await serverMutation(
                                         target,
                                         `${sessionPath(target.sessionId)}/items/${encodeURIComponent(pending.acceptedItemId)}`,
                                         queueMutationInit(target, 'DELETE'),
                                     );
                                     if (removedFromServer) {
                                         set((state) => ({ pendingServerEnqueues: withoutKey(state.pendingServerEnqueues, enqueueKey) }));
                                     }
                                     continue;
                                 }
                                 const sendConfig = message.sendConfig;
                                 const generationToSend = pending.generation ?? getServerSessionLifecycleGeneration(target);
                                 if (pending.generation === undefined && generationToSend !== undefined) {
                                     set((state) => ({
                                         pendingServerEnqueues: {
                                             ...state.pendingServerEnqueues,
                                             [enqueueKey]: { ...pending, generation: generationToSend },
                                         },
                                     }));
                                 }
                                 try {
                                      const { result, acceptedItemId, removedFromServer } = await enqueueServerEnqueueMutation(target, enqueueKey, message, sendConfig, () => requestJson(serverEnqueueResponseSchema, `${sessionPath(target.sessionId)}/items`, queueMutationInit(target, 'POST', {
                                          directory: target.directory,
                                          item: toServerItemInput(message, sendConfig),
                                          idempotencyKey: pending.idempotencyKey ?? enqueueKey,
                                          generation: generationToSend,
                                      }, generationToSend)));
                                      if (!isCurrent()) return;
                                      const latest = get().pendingServerEnqueues[enqueueKey];
                                      if (latest?.removed) {
                                          set((state) => removeMessageLocally(state, getMessageQueueKey(target), message.id));
                                          if (acceptedItemId) {
                                              if (removedFromServer) {
                                                  set((state) => ({ pendingServerEnqueues: withoutKey(state.pendingServerEnqueues, enqueueKey) }));
                                              }
                                          } else {
                                             set((state) => ({ pendingServerEnqueues: withoutKey(state.pendingServerEnqueues, enqueueKey) }));
                                         }
                                     } else {
                                         set((state) => removeMessageLocally(state, getMessageQueueKey(target), message.id));
                                         applyServerSession(result.session, result.revision, runtimeKey);
                                         set((state) => ({ pendingServerEnqueues: withoutKey(state.pendingServerEnqueues, enqueueKey) }));
                                     }
                                 } catch (error) {
                                     const latest = get().pendingServerEnqueues[enqueueKey];
                                     if (latest) {
                                         set((state) => ({
                                             pendingServerEnqueues: {
                                                 ...state.pendingServerEnqueues,
                                                  [enqueueKey]: { ...latest, blocked: error instanceof Error && isTerminalPendingOperationError(error) },
                                             },
                                         }));
                                         console.warn('[queue] failed to migrate a locally queued message to the server:', error);
                                     }
                                 }
                             }

                              await get().retryPendingServerRestores();
                              await recoverPendingServerTakes(runtimeKey, generation);
                          };
                          const promise = (async () => {
                              do {
                                  resyncRequested = false;
                                  try {
                                      await hydrateOnce();
                                  } catch (error) {
                                      if (!isCurrent()) return;
                                      if (resyncRequested) continue;
                                      throw error;
                                  }
                              } while (resyncRequested && isCurrent());
                          })();
                         hydrationInFlight = { runtimeKey, promise };
                          void promise.then(
                              () => {
                                  if (hydrationInFlight?.promise === promise) hydrationInFlight = null;
                              },
                              () => {
                                  if (hydrationInFlight?.promise === promise) hydrationInFlight = null;
                              },
                          );
                         return promise;
                     },

                     resync: () => {
                         if (hydrationInFlight?.runtimeKey === getRuntimeKey()) resyncRequested = true;
                         return get().hydrate();
                     },

                     applyServerSession,

                     getServerHoldTarget: (sessionId, directoryInput) => {
                         const runtimeKey = getRuntimeKey();
                         const sessionKey = getServerSessionKey(runtimeKey, sessionId);
                         const fallbackTarget = Object.keys(get().queuedMessages)
                             .map(parseMessageQueueKey)
                             .find((candidate) => candidate?.runtimeKey === runtimeKey && candidate.sessionId === sessionId);
                          return {
                              runtimeKey,
                              directory: serverSessionDirectories.get(sessionKey) ?? directoryInput ?? fallbackTarget?.directory ?? '',
                              sessionId,
                              generation: serverSessionLifecycleGenerations.get(sessionKey) ?? 0,
                              clientToken: getMessageQueueClientToken(runtimeKey),
                              deleted: serverSessionDeleted.has(sessionKey),
                              runtimeTarget: captureRuntimeFetchTarget(),
                          };
                     },

                    setServerHold: async (target, held, options = {}) => {
                         if (!isServerOwnedMessageQueue()) return;
                         const mutationVersion = nextServerHoldMutationVersion(target);
                         const releaseForRuntimeSwitch = !held && (
                             options.releaseForRuntimeSwitch === true
                             || target.runtimeKey !== getRuntimeKey()
                             || target.runtimeTarget !== undefined
                         );
                          if (releaseForRuntimeSwitch && target.runtimeKey !== getRuntimeKey() && !target.runtimeTarget) {
                              throw staleRuntimeError();
                          }
                          if (!held) clearPendingServerHoldRelease(target);
                          const sequence = nextServerHoldMutationSequence(target);
                          if (held) clearPendingServerHoldRelease(target, sequence);
                          try {
                              const settledSequence = await convergeServerHoldMutation(target, held, sequence, {
                                  ...options,
                                  releaseForRuntimeSwitch,
                              });
                              if (held) clearPendingServerHoldRelease(target, settledSequence);
                              return;
                         } catch (error) {
                             if (
                                 !held
                                 && error instanceof Error
                                 && shouldRetryServerHoldRelease(error)
                                 && getServerHoldMutationVersion(target) === mutationVersion
                             ) {
                                const pending: PendingServerHoldRelease = {
                                    target: { ...target },
                                    sequence,
                                    retryIndex: 0,
                                };
                                 pendingServerHoldReleases.set(getServerSessionKey(target.runtimeKey, target.sessionId), pending);
                                 scheduleServerHoldReleaseRetry(pending);
                             }
                             throw error;
                         }
                    },

                     resetForRuntimeSwitch: (previousRuntimeKey) => {
                         hydrationGeneration += 1;
                         hydrationInFlight = null;
                         resyncRequested = false;
                         // The hold owner token is per runtime and persisted: a
                         // switch must not rotate it, or the previous runtime's
                         // captured targets could never release their hold and
                         // switching back would look like a foreign owner.
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
                version: 6,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    queuedMessages: Object.fromEntries(
                        Object.entries(state.queuedMessages).filter(([key]) => {
                            const runtimeKey = parseMessageQueueKey(key)?.runtimeKey;
                            return !runtimeKey || !serverOwnedRuntimeKeys.has(runtimeKey);
                        }),
                    ),
                     quarantinedLegacyMessages: state.quarantinedLegacyMessages,
                     pendingLegacyMessages: state.pendingLegacyMessages,
                     followUpBehavior: state.followUpBehavior,
                     pendingServerRestores: state.pendingServerRestores,
                     pendingServerTakes: state.pendingServerTakes,
                     pendingServerTakeAcks: state.pendingServerTakeAcks,
                    pendingServerEnqueues: state.pendingServerEnqueues,
                    takenServerOperations: state.takenServerOperations,
                    queueDeletionGenerations: state.queueDeletionGenerations,
                }),
                migrate: migrateMessageQueueState,
            },
        ),
        {
            name: 'message-queue-store',
        },
    ),
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
    useMessageQueueStore.getState().applyServerSession(session, revision, expectedRuntimeKey, true);
};
