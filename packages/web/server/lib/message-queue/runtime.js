// Server-owned message queue: messages the user queued while a session was
// busy, delivered by the web server the moment the session goes idle. The
// queue lives here, not in the browser, so closing the tab, locking the phone,
// or losing the connection no longer strands what was queued. Structural
// template: permission-auto-accept (server-authoritative state, UI as a
// projection, VS Code keeps its own foreground implementation).
//
// Event-driven like session-goal: the shared upstream hub delivers
// `session.status`, and an idle transition arms a short per-session timer. The
// tick re-verifies idleness against OpenCode (status map + message tail) before
// it sends, because a queued prompt sent into a running turn would be steered
// into it instead of starting the next one.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const QUEUE_FILE_NAME = 'message-queue.json';
const QUEUE_FILE_VERSION = 2;

const MAX_SESSIONS = 50;
const MAX_ITEMS_PER_SESSION = 20;
const CONTENT_CHAR_LIMIT = 200_000;

// Idle events arrive in bursts around a turn boundary; a short quiet window
// coalesces them before the tick verifies idleness against OpenCode.
const DISPATCH_QUIET_MS = 500;
// After a user abort the UI held the queue for two seconds so the stop is not
// immediately followed by the next prompt; the server keeps that window.
const ABORT_HOLD_MS = 2_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
// A hold is asserted by a UI-driven process (auto-review) that dies with the
// UI; it expires unless the UI keeps re-asserting it.
const HOLD_DEFAULT_TTL_MS = 5 * 60 * 1000;
const HOLD_MAX_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_TAIL_LIMIT = 2;
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;
const TAKE_OPERATION_ID_MAX_LENGTH = 256;
const HOLD_CLIENT_TOKEN_MAX_LENGTH = 256;
const LIFECYCLE_TOMBSTONE_LIMIT = MAX_SESSIONS * 4;
const LIFECYCLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OPERATION_HISTORY_LIMIT = MAX_SESSIONS * MAX_ITEMS_PER_SESSION * 2;
const OPERATION_HISTORY_RETENTION_MS = LIFECYCLE_RETENTION_MS;
const TAKE_RECEIPT_PAYLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

const ATTACHMENT_SOURCES = new Set(['local', 'server', 'vscode']);
// Context captured with a queued message (see QueuedContextPart in the UI
// store): attached context items carry metadata the timeline renders back;
// the other kinds are plain synthetic text.
const CONTEXT_PART_KINDS = new Set(['context', 'instruction', 'synthetic']);
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const getQueuedSendRetryDelayMs = (failures) =>
  Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

// Boundary readers: the only place raw JSON (client bodies, the queue file,
// OpenCode responses, hub events) is inspected. Everything below them
// branches on the domain values they return.
const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const asText = (value) => (typeof value === 'string' ? value : '');
const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const asList = (value) => (Array.isArray(value) ? value : null);
const asCount = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
const asPersistedCount = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const asBoolean = (value) => (value === true || value === false ? value : null);

const isValidSessionId = (value) => SESSION_ID_PATTERN.test(asNonEmptyString(value));

const parseIdempotencyKey = (value) => {
  if (value === undefined) return null;
  const key = asNonEmptyString(value);
  if (!key || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new TypeError('idempotencyKey must be a non-empty string of at most 256 characters');
  return key;
};

const parseTakeOperationId = (value) => {
  if (value === undefined) return null;
  const operationId = asNonEmptyString(value);
  if (!operationId || operationId.length > TAKE_OPERATION_ID_MAX_LENGTH) throw new TypeError('operationId must be a non-empty string of at most 256 characters');
  return operationId;
};

const parseExpectedGeneration = (value) => {
  if (value === undefined) return null;
  const generation = asCount(value);
  if (generation === null) throw new TypeError('generation must be a non-negative integer');
  return generation;
};

const parseHoldClientToken = (value) => {
  if (value === undefined) return 'legacy';
  const token = asNonEmptyString(value);
  if (!token || token.length > HOLD_CLIENT_TOKEN_MAX_LENGTH) throw new TypeError('clientToken must be a non-empty string of at most 256 characters');
  return token;
};

const httpError = (message, status) => Object.assign(new Error(message), { status });

const parseSendConfig = (value) => {
  const raw = asRecord(value);
  if (!raw) return null;
  const providerID = asNonEmptyString(raw.providerID);
  const modelID = asNonEmptyString(raw.modelID);
  if (!providerID || !modelID) return null;
  const sendConfig = { providerID, modelID };
  const agent = asNonEmptyString(raw.agent);
  if (agent) sendConfig.agent = agent;
  const variant = asNonEmptyString(raw.variant);
  if (variant) sendConfig.variant = variant;
  return sendConfig;
};

const parseAttachment = (value) => {
  const raw = asRecord(value);
  if (!raw) return null;
  const filename = asNonEmptyString(raw.filename);
  const mimeType = asNonEmptyString(raw.mimeType);
  const dataUrl = asText(raw.dataUrl);
  if (!filename || !mimeType || !dataUrl) return null;
  const attachment = {
    id: asNonEmptyString(raw.id) || `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    filename,
    mimeType,
    size: asCount(raw.size) ?? 0,
    source: ATTACHMENT_SOURCES.has(raw.source) ? raw.source : 'local',
  };
  const serverPath = asNonEmptyString(raw.serverPath);
  if (serverPath) attachment.serverPath = serverPath;
  attachment.dataUrl = dataUrl;
  return attachment;
};

const parseContextPart = (value) => {
  const raw = asRecord(value);
  if (!raw || !CONTEXT_PART_KINDS.has(raw.kind)) return null;
  const text = asText(raw.text);
  if (raw.kind !== 'context') return { kind: raw.kind, text };
  // The metadata is the UI's structured payload; the server only carries it
  // to the prompt, so its shape is the UI's to validate on the way back.
  const metadata = asRecord(raw.metadata);
  if (!metadata) return null;
  const part = { kind: 'context', text, metadata };
  const instructions = asNonEmptyString(raw.instructions);
  if (instructions) part.instructions = instructions;
  return part;
};

/**
 * Validates a queued item posted by a client. Throws a TypeError (→ 400) for
 * anything that could not be delivered later: a queue must never hold an item
 * the server cannot send.
 */
export const parseQueuedItemInput = (value) => {
  const raw = asRecord(value);
  if (!raw) throw new TypeError('item is required');
  const content = asText(raw.content).replace(/^\n+|\n+$/g, '');
  if (content.length > CONTENT_CHAR_LIMIT) throw new TypeError('item content is too long');
  const text = raw.text === undefined ? content : asText(raw.text);
  const attachments = (asList(raw.attachments) ?? []).map(parseAttachment);
  if (attachments.some((attachment) => attachment === null)) throw new TypeError('invalid attachment');
  const context = (asList(raw.context) ?? []).map(parseContextPart);
  if (context.some((part) => part === null)) throw new TypeError('invalid context part');
  if (!text.trim() && attachments.length === 0 && context.length === 0) {
    throw new TypeError('item needs text, attachments, or context');
  }
  const sendConfig = parseSendConfig(raw.sendConfig);
  if (!sendConfig) throw new TypeError('item sendConfig with providerID and modelID is required');
  const item = { content, text };
  const agentMention = asNonEmptyString(raw.agentMention);
  if (agentMention) item.agentMention = agentMention;
  item.attachments = attachments;
  item.context = context;
  const contextPreview = asNonEmptyString(raw.contextPreview).slice(0, 103);
  if (contextPreview) item.contextPreview = contextPreview;
  item.sendConfig = sendConfig;
  return item;
};

const parseStoredItem = (value) => {
  const raw = asRecord(value);
  const id = raw ? asNonEmptyString(raw.id) : '';
  const createdAt = raw ? asPersistedCount(raw.createdAt) : null;
  if (!id || createdAt === null) return null;
  try {
    const idempotencyKey = raw.idempotencyKey === undefined ? null : parseIdempotencyKey(raw.idempotencyKey);
    return {
      id,
      createdAt,
      ...parseQueuedItemInput(raw),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  } catch {
    return null;
  }
};

const parseStoredLifecycle = (value) => {
  const raw = asRecord(value);
  const generation = raw ? asPersistedCount(raw.generation) : null;
  const deleted = raw ? asBoolean(raw.deleted) : null;
  const restoreRequiresReceipt = raw?.restoreRequiresReceipt === undefined ? null : asBoolean(raw.restoreRequiresReceipt);
  const directory = asNonEmptyString(raw?.directory);
  if (!raw || generation === null || deleted === null || (raw.restoreRequiresReceipt !== undefined && restoreRequiresReceipt === null) || (raw.directory !== undefined && !directory)) return null;
  if (raw.deletedAt !== undefined && asPersistedCount(raw.deletedAt) === null) return null;
  const deletedAt = asPersistedCount(raw.deletedAt);
  return {
    generation,
    deleted,
    ...(raw.restoreRequiresReceipt === true ? { restoreRequiresReceipt: true } : {}),
    ...(directory ? { directory } : {}),
    ...(deletedAt === null ? {} : { deletedAt }),
  };
};

const parseRestoredItem = (value) => {
  const raw = asRecord(value);
  const id = raw ? asNonEmptyString(raw.id) : '';
  const createdAt = raw ? asCount(raw.createdAt) : null;
  if (!id || createdAt === null) throw new TypeError('restore item id and createdAt are required');
  return { id, createdAt, ...parseQueuedItemInput(raw) };
};

const parseStoredTakeReceipt = (value) => {
  const raw = asRecord(value);
  const operationId = raw ? asNonEmptyString(raw.operationId) : '';
  const sessionId = raw ? asNonEmptyString(raw.sessionId) : '';
  const directory = raw ? asNonEmptyString(raw.directory) : '';
  const kind = raw?.kind === 'item' || raw?.kind === 'all' ? raw.kind : null;
  const revision = raw ? asPersistedCount(raw.revision) : null;
  const generation = raw ? asPersistedCount(raw.generation) : null;
  const createdAt = raw ? asPersistedCount(raw.createdAt) : null;
  const storedItems = asList(raw?.items);
  if (!raw || (raw.directory !== undefined && !directory) || !storedItems || operationId.length > TAKE_OPERATION_ID_MAX_LENGTH) return null;
  const items = storedItems.map(parseStoredItem);
  if (items.some((item) => item === null)) return null;
  const itemId = asNonEmptyString(raw.itemId);
  if (raw.itemId !== undefined && raw.itemId !== null && !itemId) return null;
  if (!operationId || !isValidSessionId(sessionId) || (!directory && kind !== 'all') || !kind || revision === null || generation === null || createdAt === null) return null;
  if (kind === 'item' && (!itemId || items.length !== 1 || items[0].id !== itemId)) return null;
  if (kind === 'all' && itemId) return null;
  return { operationId, sessionId, directory, kind, itemId: itemId || null, revision, generation, createdAt, items };
};

const parseStoredEnqueueIdempotency = (value) => {
  const raw = asRecord(value);
  const operationId = raw ? asNonEmptyString(raw.operationId) : '';
  const sessionId = raw ? asNonEmptyString(raw.sessionId) : '';
  const idempotencyKey = raw ? asNonEmptyString(raw.idempotencyKey) : '';
  const itemId = raw ? asNonEmptyString(raw.itemId) : '';
  const fingerprint = raw ? asNonEmptyString(raw.fingerprint) : '';
  const generation = raw ? asPersistedCount(raw.generation) : null;
  const createdAt = raw ? asPersistedCount(raw.createdAt) : null;
  if (!operationId || !isValidSessionId(sessionId) || !idempotencyKey || idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH || !itemId || !fingerprint || generation === null || createdAt === null) return null;
  return { operationId, sessionId, idempotencyKey, itemId, fingerprint, generation, createdAt };
};

const parseStoredRestoreOperation = (value) => {
  const raw = asRecord(value);
  const operationId = raw ? asNonEmptyString(raw.operationId) : '';
  const sessionId = raw ? asNonEmptyString(raw.sessionId) : '';
  const directory = raw ? asNonEmptyString(raw.directory) : '';
  const revision = raw ? asPersistedCount(raw.revision) : null;
  const generation = raw ? asPersistedCount(raw.generation) : null;
  const createdAt = raw ? asPersistedCount(raw.createdAt) : null;
  const fingerprint = raw ? asNonEmptyString(raw.fingerprint) : '';
  const itemIds = (asList(raw?.itemIds) ?? []).map(asNonEmptyString);
  if (!raw || !operationId || operationId.length > TAKE_OPERATION_ID_MAX_LENGTH || !isValidSessionId(sessionId) || !directory || revision === null || generation === null || createdAt === null || !fingerprint) return null;
  if (itemIds.length === 0 || itemIds.some((itemId) => !itemId) || new Set(itemIds).size !== itemIds.length) return null;
  return { operationId, sessionId, directory, revision, generation, createdAt, itemIds, fingerprint };
};

const toPublicAttachment = ({ dataUrl: _dataUrl, ...attachment }) => attachment;

// What clients see: everything except the payloads — attachment data URLs
// (megabytes of base64) and captured context (a PR diff, say) — which would
// otherwise ride every broadcast. A take hands the full item back.
const toPublicItem = (item) => {
  const publicItem = { id: item.id, createdAt: item.createdAt, content: item.content, text: item.text };
  if (item.agentMention) publicItem.agentMention = item.agentMention;
  publicItem.attachments = item.attachments.map(toPublicAttachment);
  // Older persisted items have no UI summary. Prefer their attached comment
  // before falling back to the model-facing context text.
  const contextPreview = item.contextPreview || item.context
    .filter((part) => part.kind !== 'instruction')
    .map((part) => asNonEmptyString(asRecord(part.metadata?.openchamberContext)?.text) || part.text.trim())
    .find(Boolean);
  if (contextPreview) {
    const firstLine = contextPreview.split('\n', 1)[0];
    publicItem.contextPreview = firstLine.slice(0, 100)
      + (contextPreview.length > firstLine.length || firstLine.length > 100 ? '...' : '');
  }
  publicItem.sendConfig = { ...item.sendConfig };
  return publicItem;
};

const extractSessionStatus = (payload) => {
  if (payload.type !== 'session.status') return null;
  const properties = asRecord(payload.properties) ?? {};
  const status = asRecord(properties.status) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(properties.sessionID);
  const type = asNonEmptyString(status.type) || asNonEmptyString(info.type);
  if (!sessionId || !type) return null;
  return { sessionId, type };
};

const extractAssistantMessageUpdate = (payload) => {
  if (payload.type !== 'message.updated') return null;
  const info = asRecord(asRecord(payload.properties)?.info);
  if (!info || info.role !== 'assistant') return null;
  const sessionId = asNonEmptyString(info.sessionID);
  if (!sessionId) return null;
  return {
    sessionId,
    aborted: asRecord(info.error)?.name === 'MessageAbortedError',
    completed: asCount(asRecord(info.time)?.completed) !== null,
  };
};

const extractDeletedSessionId = (payload) => {
  if (payload.type !== 'session.deleted') return null;
  const properties = asRecord(payload.properties) ?? {};
  return asNonEmptyString(asRecord(properties.info)?.id) || asNonEmptyString(properties.sessionID) || null;
};

const extractCreatedSession = (payload) => {
  if (payload.type !== 'session.created') return null;
  const properties = asRecord(payload.properties) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(info.id) || asNonEmptyString(properties.sessionID);
  if (!sessionId) return null;
  return { sessionId, directory: asNonEmptyString(info.directory) };
};

const extractUpdatedSession = (payload) => {
  if (payload.type !== 'session.updated') return null;
  const properties = asRecord(payload.properties) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(info.id) || asNonEmptyString(properties.sessionID);
  const directory = asNonEmptyString(info.directory) || asNonEmptyString(properties.directory);
  if (!sessionId || !directory) return null;
  return { sessionId, directory };
};

export function createMessageQueueRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime = null,
  broadcastGlobalUiEvent,
  onPromptSent,
  dataDir,
  fetchImpl = fetch,
  now = Date.now,
  dispatchQuietMs = DISPATCH_QUIET_MS,
  abortHoldMs = ABORT_HOLD_MS,
  retryDelayMs = getQueuedSendRetryDelayMs,
  takeReceiptPayloadLimitBytes = TAKE_RECEIPT_PAYLOAD_LIMIT_BYTES,
}) {
  const filePath = path.join(dataDir, QUEUE_FILE_NAME);

  /** sessionId → { directory, items } */
  const queues = new Map();
  const sessionLifecycles = new Map();
  const takeReceipts = new Map();
  const completedRestoreOperations = new Map();
  const enqueueIdempotency = new Map();
  let lifecyclePruned = false;
  let revision = 0;
  let loadPromise = null;
  let loaded = false;
  let writePromise = Promise.resolve();
  let lastWritePromise = writePromise;
  const mutationQueue = [];
  let mutationRunning = false;
  let stopped = false;
  let drainPromise = null;
  const pendingPayloads = [];

  /** In-memory only — a restart has no in-flight sends. */
  const sending = new Map(); // sessionId → itemId
  const inFlightSends = new Set();
  const timers = new Map(); // sessionId → timeout
  const failures = new Map(); // sessionId → { itemId, failures, nextAttemptAt }
  const abortedAt = new Map(); // sessionId → timestamp
  const holds = new Map(); // sessionId → { expiresAt, generation, directory, clientToken, sequence }
  const observedQueueMutations = new Set();
  // The latest accepted owner mutation remains after expiry/release so stale
  // requests cannot be mistaken for a new owner's first assertion.
  const holdMutationSequences = new Map(); // sessionId → { clientToken, sequence, generation, directory }
  // A generation-zero hold can be captured before the first enqueue creates
  // the session lifecycle. Keep one narrow bridge for its captured cleanup;
  // all other generation mismatches remain rejected.
  const holdGenerationTransitions = new Map(); // sessionId → { fromGeneration, toGeneration, directory, clientToken }
  // sessionId → directory, kept after the queue empties: the UI keys its
  // projection by directory, so the broadcast that removes the last item must
  // still name it or the client cannot tell which queue just finished.
  const directories = new Map();

  const cloneQueue = (queue) => ({ directory: queue.directory, items: [...queue.items] });
  const cloneLifecycle = (lifecycle) => ({ ...lifecycle });
  const cloneReceipt = (receipt) => ({ ...receipt, items: [...receipt.items] });
  const cloneRestoreOperation = (operation) => ({ ...operation, itemIds: [...operation.itemIds] });
  const cloneEnqueueOperation = (operation) => ({ ...operation });

  // Persistence failures roll back the durable queue transaction, not the
  // independent in-memory hold ownership state. Send bookkeeping remains part
  // of the transaction so a failed removal can be retried safely.
  const captureState = () => ({
    revision,
    lifecyclePruned,
    queues: new Map(Array.from(queues.entries()).map(([sessionId, queue]) => [sessionId, cloneQueue(queue)])),
    sessionLifecycles: new Map(Array.from(sessionLifecycles.entries()).map(([sessionId, lifecycle]) => [sessionId, cloneLifecycle(lifecycle)])),
    takeReceipts: new Map(Array.from(takeReceipts.entries()).map(([operationId, receipt]) => [operationId, cloneReceipt(receipt)])),
    completedRestoreOperations: new Map(Array.from(completedRestoreOperations.entries()).map(([operationId, operation]) => [operationId, cloneRestoreOperation(operation)])),
    enqueueIdempotency: new Map(Array.from(enqueueIdempotency.entries()).map(([operationId, operation]) => [operationId, cloneEnqueueOperation(operation)])),
    directories: new Map(directories),
    sending: new Map(sending),
    failures: new Map(Array.from(failures.entries()).map(([sessionId, failure]) => [sessionId, { ...failure }])),
    abortedAt: new Map(abortedAt),
    observedQueueMutations: new Set(observedQueueMutations),
  });

  const reconcileDispatchTimers = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    const currentTime = now();
    for (const [sessionId, queue] of queues) {
      const hold = holds.get(sessionId);
      const lifecycle = sessionLifecycles.get(sessionId);
      const authoritativeDirectory = queue.directory ?? directories.get(sessionId) ?? lifecycle?.directory;
      const holdIsActive = hold
        && hold.expiresAt > currentTime
        && hold.generation === sessionGeneration(sessionId)
        && (!authoritativeDirectory || hold.directory === authoritativeDirectory);
      armDispatch(sessionId, holdIsActive ? hold.expiresAt - currentTime : dispatchQuietMs);
    }
  };

  const restoreState = (state) => {
    queues.clear();
    for (const [sessionId, queue] of state.queues) queues.set(sessionId, cloneQueue(queue));
    sessionLifecycles.clear();
    for (const [sessionId, lifecycle] of state.sessionLifecycles) sessionLifecycles.set(sessionId, cloneLifecycle(lifecycle));
    takeReceipts.clear();
    for (const [operationId, receipt] of state.takeReceipts) takeReceipts.set(operationId, cloneReceipt(receipt));
    completedRestoreOperations.clear();
    for (const [operationId, operation] of state.completedRestoreOperations) completedRestoreOperations.set(operationId, cloneRestoreOperation(operation));
    enqueueIdempotency.clear();
    for (const [operationId, operation] of state.enqueueIdempotency) enqueueIdempotency.set(operationId, cloneEnqueueOperation(operation));
    directories.clear();
    for (const [sessionId, directory] of state.directories) directories.set(sessionId, directory);
    sending.clear();
    for (const [sessionId, itemId] of state.sending) sending.set(sessionId, itemId);
    failures.clear();
    for (const [sessionId, failure] of state.failures) failures.set(sessionId, { ...failure });
    abortedAt.clear();
    for (const [sessionId, timestamp] of state.abortedAt) abortedAt.set(sessionId, timestamp);
    observedQueueMutations.clear();
    for (const sessionId of state.observedQueueMutations) observedQueueMutations.add(sessionId);
    revision = state.revision;
    lifecyclePruned = state.lifecyclePruned;
    reconcileDispatchTimers();
  };

  // Public routes and post-load hub events share this FIFO. Start the head
  // synchronously so callers that previously observed in-memory event state
  // before the first await keep that behavior, while the next operation waits
  // for its complete durable commit.
  const drainMutations = () => {
    if (mutationRunning) return;
    const next = mutationQueue.shift();
    if (!next) return;
    mutationRunning = true;
    let result;
    try {
      result = next.operation();
    } catch (error) {
      next.reject(error);
      mutationRunning = false;
      drainMutations();
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        next.resolve(value);
        mutationRunning = false;
        drainMutations();
      },
      (error) => {
        next.reject(error);
        mutationRunning = false;
        drainMutations();
      },
    );
  };

  const runMutation = (operation) => new Promise((resolve, reject) => {
    mutationQueue.push({ operation, resolve, reject });
    drainMutations();
  });

  // --- persistence ---------------------------------------------------------

  const emptyStoredState = () => ({
    sessions: {},
    sessionLifecycles: {},
    takeReceipts: {},
    completedRestores: {},
    enqueueIdempotency: {},
    lifecyclePruned: false,
    revision: 0,
  });

  const parseStoredEnvelope = (value) => {
    const stored = asRecord(value);
    if (!stored) throw new Error('message queue file has an invalid envelope');
    if (stored.version !== QUEUE_FILE_VERSION) throw new Error(`message queue file version ${String(stored.version)} is unsupported`);
    const storedRevision = asPersistedCount(stored.revision);
    if (storedRevision === null) throw new Error('message queue file has an invalid revision');
    for (const field of ['sessions', 'sessionLifecycles', 'takeReceipts', 'completedRestores', 'enqueueIdempotency']) {
      if (!asRecord(stored[field])) throw new Error(`message queue file has an invalid ${field} map`);
    }
    const storedLifecyclePruned = stored.lifecyclePruned === undefined ? false : asBoolean(stored.lifecyclePruned);
    if (storedLifecyclePruned === null) {
      throw new Error('message queue file has an invalid lifecyclePruned flag');
    }
    return { stored, revision: storedRevision, lifecyclePruned: storedLifecyclePruned };
  };

  const quarantineInvalidFile = async (kind, error) => {
    const backup = `${filePath}.corrupt-${now()}`;
    try {
      await fs.promises.rename(filePath, backup);
    } catch (quarantineError) {
      throw new Error(`[message-queue] ${kind} queue file could not be quarantined: ${quarantineError?.message ?? quarantineError}`);
    }
    console.warn(`[message-queue] queue file was ${kind} and moved to ${backup}: ${error?.message ?? error}`);
    return emptyStoredState();
  };

  const serialize = () => ({
    version: QUEUE_FILE_VERSION,
    revision,
    sessions: Object.fromEntries(
      Array.from(queues.entries()).map(([sessionId, queue]) => [sessionId, { directory: queue.directory, items: queue.items }]),
    ),
    sessionLifecycles: Object.fromEntries(sessionLifecycles.entries()),
    takeReceipts: Object.fromEntries(takeReceipts.entries()),
    completedRestores: Object.fromEntries(completedRestoreOperations.entries()),
    enqueueIdempotency: Object.fromEntries(enqueueIdempotency.entries()),
    lifecyclePruned,
  });

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') return emptyStoredState();
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Malformed is a failure, not an empty queue: keep the bytes for the
      // user and start over rather than overwriting them on the next write.
      return quarantineInvalidFile('malformed', error);
    }
    let stored;
    let storedRevision;
    let storedLifecyclePruned;
    try {
      ({ stored, revision: storedRevision, lifecyclePruned: storedLifecyclePruned } = parseStoredEnvelope(parsed));
    } catch (error) {
      return quarantineInvalidFile('structurally invalid', error);
    }
    const sessions = {};
    for (const [sessionId, value] of Object.entries(asRecord(stored.sessions) ?? {})) {
      const entry = asRecord(value);
      if (!entry || !isValidSessionId(sessionId)) continue;
      const directory = asNonEmptyString(entry.directory);
      const storedItems = asList(entry.items);
      if (!directory || !storedItems) continue;
      const items = storedItems.map(parseStoredItem).filter(Boolean);
      if (items.length === 0) continue;
      sessions[sessionId] = { directory, items };
    }
    const sessionLifecycles = {};
    for (const [sessionId, value] of Object.entries(asRecord(stored.sessionLifecycles) ?? {})) {
      if (!isValidSessionId(sessionId)) continue;
      const lifecycle = parseStoredLifecycle(value);
      if (lifecycle) sessionLifecycles[sessionId] = lifecycle;
    }
    const takeReceipts = {};
    for (const [operationId, value] of Object.entries(asRecord(stored.takeReceipts) ?? {})) {
      const receipt = parseStoredTakeReceipt(value);
      if (receipt && receipt.operationId === operationId) takeReceipts[operationId] = receipt;
    }
    const completedRestores = {};
    for (const [operationId, value] of Object.entries(asRecord(stored.completedRestores) ?? {})) {
      const operation = parseStoredRestoreOperation(value);
      if (operation && operation.operationId === operationId) completedRestores[operationId] = operation;
    }
    const enqueueIdempotency = {};
    for (const [operationId, value] of Object.entries(asRecord(stored.enqueueIdempotency) ?? {})) {
      const operation = parseStoredEnqueueIdempotency(value);
      if (operation && operation.operationId === operationId) enqueueIdempotency[operationId] = operation;
    }
    return { sessions, sessionLifecycles, takeReceipts, completedRestores, enqueueIdempotency, lifecyclePruned: storedLifecyclePruned, revision: storedRevision };
  };

  const load = () => {
    if (loaded) return Promise.resolve();
    if (!loadPromise) {
      const baseline = captureState();
      loadPromise = (async () => {
        const stored = await readFile();
        queues.clear();
        sessionLifecycles.clear();
        takeReceipts.clear();
        completedRestoreOperations.clear();
        enqueueIdempotency.clear();
        directories.clear();
        revision = 0;
        lifecyclePruned = false;
        {
          for (const [sessionId, lifecycle] of Object.entries(stored.sessionLifecycles)) {
            sessionLifecycles.set(sessionId, lifecycle);
            if (!lifecycle.deleted && lifecycle.directory) directories.set(sessionId, lifecycle.directory);
          }
          lifecyclePruned = stored.lifecyclePruned === true;
          for (const [operationId, receipt] of Object.entries(stored.takeReceipts)) takeReceipts.set(operationId, receipt);
          for (const [operationId, operation] of Object.entries(stored.completedRestores)) completedRestoreOperations.set(operationId, operation);
          for (const [operationId, operation] of Object.entries(stored.enqueueIdempotency)) enqueueIdempotency.set(operationId, operation);
          for (const [sessionId, entry] of Object.entries(stored.sessions)) {
            if (sessionLifecycles.get(sessionId)?.deleted) continue;
            queues.set(sessionId, entry);
          }
          revision = stored.revision;
        }
        const evictedSessionIds = enforceSessionLimit();
        const lifecycleWasPruned = pruneSessionLifecycles();
        const operationHistoryWasPruned = pruneOperationHistory();
        if (evictedSessionIds.length > 0 || lifecycleWasPruned || operationHistoryWasPruned) {
          await persist();
          for (const sessionId of evictedSessionIds) directories.delete(sessionId);
        }
        let replayIndex = 0;
        while (replayIndex < pendingPayloads.length) {
          const payload = pendingPayloads[replayIndex];
          try {
            await processPayloadNow(payload);
            replayIndex += 1;
          } catch (error) {
            pendingPayloads.splice(0, replayIndex);
            throw error;
          }
        }
        pendingPayloads.length = 0;
        loaded = true;
      })().catch((error) => {
        // A read or initial normalization failure leaves the in-memory queue
        // empty and keeps buffered events available for the next load attempt.
        loaded = false;
        restoreState(baseline);
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify(serialize());
    const nextWrite = writePromise
      .then(async () => {
        await fs.promises.mkdir(dataDir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
      });
    writePromise = nextWrite.catch(() => undefined);
    lastWritePromise = nextWrite;
    return nextWrite;
  };

  // --- snapshots -----------------------------------------------------------

  const sessionSnapshot = (sessionId) => {
    const queue = queues.get(sessionId);
    const lifecycle = sessionLifecycles.get(sessionId);
    return {
      sessionId,
      directory: queue?.directory ?? directories.get(sessionId) ?? lifecycle?.directory ?? '',
      items: (queue?.items ?? []).map(toPublicItem),
      sendingId: sending.get(sessionId) ?? null,
      generation: sessionGeneration(sessionId),
      ...(lifecycle?.deleted ? { deleted: true } : {}),
    };
  };

  const snapshot = () => ({
    revision,
    // Empty active sessions remain authoritative: their directory and
    // generation are needed to clear/re-key a UI projection after the last
    // item is removed. Deleted incarnations stay in the lifecycle map below.
    sessions: Array.from(new Set([...queues.keys(), ...directories.keys()]))
      .filter((sessionId) => !sessionLifecycles.get(sessionId)?.deleted)
      .map(sessionSnapshot),
    sessionLifecycles: Object.fromEntries(sessionLifecycles.entries()),
  });

  const broadcast = (sessionId) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:message-queue.updated',
      properties: { revision, session: sessionSnapshot(sessionId) },
    });
  };

  /** Every durable mutation goes through here: bump, persist, broadcast. */
  const commit = async (sessionId, before, broadcastSessionIds = [sessionId]) => {
    revision += 1;
    try {
      await persist();
    } catch (error) {
      if (before) restoreState(before);
      throw error;
    }
    for (const broadcastSessionId of new Set(broadcastSessionIds)) broadcast(broadcastSessionId);
    return { revision, session: sessionSnapshot(sessionId) };
  };

  const setQueueItems = (sessionId, directory, items) => {
    directories.set(sessionId, directory);
    if (items.length === 0) {
      queues.delete(sessionId);
      return;
    }
    queues.set(sessionId, { directory, items });
  };

  const sessionGeneration = (sessionId) => sessionLifecycles.get(sessionId)?.generation ?? 0;

  const promoteGenerationZeroHold = (sessionId, directory, generation) => {
    const hold = holds.get(sessionId);
    if (!hold || hold.generation !== 0 || generation === 0) return false;
    if (directory && hold.directory !== directory) {
      holds.delete(sessionId);
      holdMutationSequences.delete(sessionId);
      holdGenerationTransitions.delete(sessionId);
      return false;
    }
    const promotedDirectory = directory || hold.directory;
    holds.set(sessionId, { ...hold, generation, directory: promotedDirectory });
    const previous = holdMutationSequences.get(sessionId);
    if (previous?.generation === 0) holdMutationSequences.set(sessionId, { ...previous, generation, directory: promotedDirectory });
    holdGenerationTransitions.set(sessionId, {
      fromGeneration: 0,
      toGeneration: generation,
      directory: promotedDirectory,
      clientToken: hold.clientToken,
    });
    return true;
  };

  const trimSessionItems = (items, protectedItemIds = new Set()) => {
    if (items.length <= MAX_ITEMS_PER_SESSION) return items;
    let overflow = items.length - MAX_ITEMS_PER_SESSION;
    const dropped = new Set();
    for (const item of items) {
      if (overflow === 0) break;
      if (protectedItemIds.has(item.id)) continue;
      dropped.add(item.id);
      overflow -= 1;
    }
    return items.filter((item) => !dropped.has(item.id));
  };

  const planSessionEvictions = (protectedSessionIds = new Set()) => {
    if (queues.size <= MAX_SESSIONS) return [];
    const oldest = Array.from(queues.entries())
      .filter(([sessionId]) => !protectedSessionIds.has(sessionId) && !sending.has(sessionId) && !failures.has(sessionId) && !Array.from(takeReceipts.values()).some((receipt) => receipt.sessionId === sessionId))
      .sort((left, right) => (left[1].items[0]?.createdAt ?? 0) - (right[1].items[0]?.createdAt ?? 0))
      .slice(0, queues.size - MAX_SESSIONS);
    return oldest.map(([sessionId]) => sessionId);
  };

  const applySessionEvictions = (sessionIds) => {
    for (const sessionId of sessionIds) {
      queues.delete(sessionId);
      clearTimer(sessionId);
      failures.delete(sessionId);
      abortedAt.delete(sessionId);
      holds.delete(sessionId);
    }
  };

  const enforceSessionLimit = (protectedSessionId) => {
    const protectedSessionIds = new Set(protectedSessionId ? [protectedSessionId] : []);
    const evicted = planSessionEvictions(protectedSessionIds);
    applySessionEvictions(evicted);
    return evicted;
  };

  const enforceSessionLimitOrThrow = (protectedSessionId) => {
    const protectedSessionIds = new Set(protectedSessionId ? [protectedSessionId] : []);
    const evicted = planSessionEvictions(protectedSessionIds);
    const required = Math.max(0, queues.size - MAX_SESSIONS);
    if (evicted.length < required) throw httpError('queue session limit has no safely evictable session', 409);
    applySessionEvictions(evicted);
    return evicted;
  };

  const pruneSessionLifecycles = () => {
    const protectedSessionIds = new Set(Array.from(takeReceipts.values()).map((receipt) => receipt.sessionId));
    const candidates = Array.from(sessionLifecycles.entries())
      .filter(([sessionId, lifecycle]) => lifecycle.deleted && !queues.has(sessionId) && !protectedSessionIds.has(sessionId) && Number.isFinite(lifecycle.deletedAt))
      .sort((left, right) => (left[1].deletedAt ?? 0) - (right[1].deletedAt ?? 0));
    const nowValue = now();
    const keepAfterAge = candidates.filter(([, lifecycle]) => nowValue - (lifecycle.deletedAt ?? nowValue) < LIFECYCLE_RETENTION_MS);
    const keep = new Set(keepAfterAge.slice(-LIFECYCLE_TOMBSTONE_LIMIT).map(([sessionId]) => sessionId));
    let pruned = false;
    for (const [sessionId] of candidates) {
      if (keep.has(sessionId)) continue;
      sessionLifecycles.delete(sessionId);
      pruned = true;
    }
    if (pruned) lifecyclePruned = true;
    return pruned;
  };

  const receiptForOperation = (operationId, sessionId, kind, itemId = null) => {
    const receipt = takeReceipts.get(operationId);
    if (!receipt) return null;
    if (receipt.sessionId !== sessionId || receipt.kind !== kind || (kind === 'item' && receipt.itemId !== itemId)) throw httpError('operationId was already used for a different take', 409);
    if (receipt.generation !== sessionGeneration(sessionId)) throw httpError('operationId belongs to a different session incarnation', 409);
    return receipt;
  };

  const responseForReceipt = (receipt) => {
    const response = { revision: receipt.revision, session: sessionSnapshot(receipt.sessionId), generation: receipt.generation };
    if (receipt.kind === 'item') response.item = receipt.items[0];
    else response.items = receipt.items;
    return response;
  };

  const removeTakeReceipt = (sessionId, operationId) => {
    const receipt = takeReceipts.get(operationId);
    if (!receipt) return false;
    if (receipt.sessionId !== sessionId || receipt.generation !== sessionGeneration(sessionId)) throw httpError('take receipt belongs to a different session incarnation', 409);
    takeReceipts.delete(operationId);
    return true;
  };

  const assertSessionMutationGeneration = (sessionId, expectedGenerationInput, allowNewLifecycle = false, directoryInput) => {
    const expectedGeneration = parseExpectedGeneration(expectedGenerationInput);
    const generation = sessionGeneration(sessionId);
    const lifecycle = sessionLifecycles.get(sessionId);
    if (lifecycle?.deleted || (!allowNewLifecycle && expectedGeneration === null && generation > 0) || (expectedGeneration !== null && expectedGeneration !== generation)) {
      const error = httpError('session lifecycle changed; queue mutation was not applied', 409);
      error.generation = generation;
      error.deleted = lifecycle?.deleted === true;
      const directory = directories.get(sessionId);
      if (directory) error.directory = directory;
      throw error;
    }
    assertSessionDirectory(sessionId, directoryInput);
    observedQueueMutations.add(sessionId);
    return generation;
  };

  const canEstablishSessionLifecycleForEnqueue = (sessionId) => {
    if (sessionLifecycles.has(sessionId)) return false;
    if (!lifecyclePruned && (queues.has(sessionId) || observedQueueMutations.has(sessionId))) return false;
    return true;
  };

  // --- OpenCode access -----------------------------------------------------

  const openCodeFetch = async (fetchPath, { directory, method = 'GET', body, query } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(search ? `${base}?${search}` : base, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    return response.json().catch(() => null);
  };

  /**
   * Live idleness, or null when it could not be established. Unknown is never
   * idle: a fetch failure re-arms instead of sending into a running turn.
   */
  const isSessionIdle = async (sessionId, directory) => {
    const statuses = asRecord(await openCodeFetch('/session/status', { directory }).catch(() => null));
    if (!statuses) return null;
    const type = asRecord(statuses[sessionId])?.type;
    if (type === 'busy' || type === 'retry') return false;
    // The status map lists only busy sessions, so a missed busy event leaves
    // no entry while a turn still streams. The trailing unfinished assistant
    // message is the live evidence of that turn (mirrors the UI gate).
    const messages = asList(await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_TAIL_LIMIT) },
    }).catch(() => null));
    if (!messages) return null;
    const last = asRecord(asRecord(messages[messages.length - 1])?.info);
    if (last?.role === 'assistant' && asCount(asRecord(last.time)?.completed) === null) return false;
    return true;
  };

  const resolveSlashCommand = async (text, directory) => {
    if (!text.startsWith('/')) return null;
    const [head, ...tail] = text.split(' ');
    const name = head.slice(1);
    if (!name) return null;
    const commands = asList(await openCodeFetch('/command', { directory })) ?? [];
    const match = commands.map(asRecord).find((command) => command?.name === name);
    if (!match) return null;
    return {
      name,
      arguments: tail.join(' '),
      isSkill: match.source === 'skill',
      template: asNonEmptyString(match.template),
    };
  };

  /**
   * The prompt a slash command stands for, expanded the way OpenCode expands
   * it: `$ARGUMENTS` takes the whole argument string, `$1..$N` take quoted or
   * bare words with the last position absorbing the rest, and a template with
   * no placeholder gets the arguments appended. Twin of the UI's
   * `expandSlashCommandGoalObjective` in `packages/ui/src/sync/session-ui-store.ts`.
   */
  const expandCommandTemplate = (template, argumentsText) => {
    if (template.includes('$ARGUMENTS')) return template.replaceAll('$ARGUMENTS', argumentsText);
    const positions = [...template.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    if (positions.length > 0) {
      const parsed = [...argumentsText.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
        .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
      const last = Math.max(...positions);
      return template.replace(/\$(\d+)/g, (_match, value) => {
        const position = Number(value);
        return position === last ? parsed.slice(position - 1).join(' ') : (parsed[position - 1] ?? '');
      });
    }
    return argumentsText ? `${template}\n\n${argumentsText}` : template;
  };

  const toFilePart = (attachment) => ({
    type: 'file',
    mime: attachment.mimeType,
    filename: attachment.filename,
    url: attachment.dataUrl,
  });

  // Captured context is delivered the way the composer delivers it: one
  // synthetic text part per entry, an attached item's metadata riding along
  // and its reading instructions (a linked PR) going first.
  const toContextParts = (part) => {
    const synthetic = { type: 'text', text: part.text, synthetic: true };
    if (part.kind !== 'context') return [synthetic];
    synthetic.metadata = part.metadata;
    return part.instructions
      ? [{ type: 'text', text: part.instructions, synthetic: true }, synthetic]
      : [synthetic];
  };

  const sendItem = async (sessionId, directory, item) => {
    const { providerID, modelID, agent, variant } = item.sendConfig;
    const fileParts = item.attachments.map(toFilePart);
    const contextParts = item.context.flatMap(toContextParts);
    // OpenCode's command route takes file parts only, so a command queued
    // with captured context cannot go through it. Same rule as the composer:
    // without context the command route keeps its semantics; with context the
    // prompt route carries the expanded template (or the skill invocation as an
    // explicit instruction) together with the context.
    const command = await resolveSlashCommand(item.text, directory);
    if (command && contextParts.length === 0) {
      const body = { command: command.name, arguments: command.arguments, model: `${providerID}/${modelID}` };
      if (agent) body.agent = agent;
      if (variant) body.variant = variant;
      if (fileParts.length > 0) body.parts = fileParts;
      await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/command`, { directory, method: 'POST', body });
      return;
    }
    let text = item.text;
    const commandParts = [];
    if (command?.isSkill) {
      commandParts.push({
        type: 'text',
        text: `The user explicitly invoked the ${command.name} skill. Use the corresponding skill tool to handle this request.`,
        synthetic: true,
      });
    } else if (command?.template) {
      text = expandCommandTemplate(command.template, command.arguments);
    }

    // Standing project context rides the prompt exactly as a UI send would
    // attach it; a failed lookup sends without it rather than not at all.
    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime.resolvePendingForSession(sessionId, directory)
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };
    // Same order as a UI send: the user's text and files, the context queued
    // with them, then the standing context, then the mentioned agent.
    const parts = [];
    if (text.trim()) parts.push({ type: 'text', text });
    parts.push(...fileParts);
    parts.push(...contextParts);
    parts.push(...commandParts);
    if (knowledge.text) parts.push({ type: 'text', text: knowledge.text, synthetic: true });
    if (item.agentMention) parts.push({ type: 'agent', name: item.agentMention });
    const body = { model: { providerID, modelID } };
    if (agent) body.agent = agent;
    if (variant) body.variant = variant;
    body.parts = parts;
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, { directory, method: 'POST', body });
    if (knowledge.text && sessionKnowledgeRuntime) {
      // After the prompt is accepted, so a rejected dispatch carries it again.
      await sessionKnowledgeRuntime.recordDelivered(sessionId, directory, knowledge.signature).catch(() => undefined);
    }
  };

  const queuedItemPayload = (item) => ({
    content: item.content,
    text: item.text,
    agentMention: item.agentMention,
    attachments: item.attachments,
    context: item.context,
    sendConfig: item.sendConfig,
  });

  const queuedItemsMatch = (left, right) => JSON.stringify(queuedItemPayload(left)) === JSON.stringify(queuedItemPayload(right));
  const enqueueOperationKey = (sessionId, idempotencyKey) => JSON.stringify([sessionId, idempotencyKey]);
  const itemFingerprint = (item) => createHash('sha256').update(JSON.stringify(queuedItemPayload(item))).digest('hex');
  const restoredItemsFingerprint = (items) => createHash('sha256')
    .update(JSON.stringify(items.map(({ id, createdAt, ...item }) => ({ id, createdAt, ...queuedItemPayload(item) }))))
    .digest('hex');

  const pruneOperationHistory = () => {
    const nowValue = now();
    let pruned = false;
    for (const operations of [enqueueIdempotency, completedRestoreOperations, takeReceipts]) {
      for (const [operationId, operation] of operations) {
        if (nowValue - operation.createdAt >= OPERATION_HISTORY_RETENTION_MS) {
          operations.delete(operationId);
          pruned = true;
        }
      }
    }
    const pruneOldest = (operations) => {
      if (operations.size <= OPERATION_HISTORY_LIMIT) return false;
      const oldest = Array.from(operations.entries())
        .sort((left, right) => left[1].createdAt - right[1].createdAt)
        .slice(0, operations.size - OPERATION_HISTORY_LIMIT);
      for (const [operationId] of oldest) operations.delete(operationId);
      return oldest.length > 0;
    };
    pruned = pruneOldest(enqueueIdempotency) || pruneOldest(completedRestoreOperations) || pruned;
    const receiptEntries = Array.from(takeReceipts.entries()).sort((left, right) => left[1].createdAt - right[1].createdAt);
    let receiptBytes = receiptEntries.reduce((total, [, receipt]) => total + Buffer.byteLength(JSON.stringify(receipt), 'utf8'), 0);
    while (receiptEntries.length > OPERATION_HISTORY_LIMIT || receiptBytes > takeReceiptPayloadLimitBytes) {
      const oldest = receiptEntries.shift();
      if (!oldest) break;
      const [operationId, receipt] = oldest;
      takeReceipts.delete(operationId);
      receiptBytes -= Buffer.byteLength(JSON.stringify(receipt), 'utf8');
      pruned = true;
    }
    return pruned;
  };

  const assertTakeReceiptPayloadFits = (receipt) => {
    if (takeReceiptPayloadLimitBytes > 0 && Buffer.byteLength(JSON.stringify(receipt), 'utf8') > takeReceiptPayloadLimitBytes) {
      throw httpError('taken message payload is too large to retain for recovery', 413);
    }
  };

  const responseForCompletedRestore = (operation) => ({ revision: operation.revision, session: sessionSnapshot(operation.sessionId) });

  // --- dispatch loop -------------------------------------------------------

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(sessionId);
    }
  };

  const armDispatch = (sessionId, delayMs = dispatchQuietMs) => {
    if (stopped || !queues.has(sessionId)) return;
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      tick(sessionId).catch((error) => {
        console.warn('[message-queue] dispatch tick failed:', error?.message ?? error);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const isHeld = (sessionId) => {
    const hold = holds.get(sessionId);
    if (!hold) return false;
    const queue = queues.get(sessionId);
    const lifecycle = sessionLifecycles.get(sessionId);
    const authoritativeDirectory = queue?.directory ?? directories.get(sessionId) ?? lifecycle?.directory;
    if (hold.generation !== sessionGeneration(sessionId) || (authoritativeDirectory && hold.directory !== authoritativeDirectory)) return false;
    if (hold.expiresAt > now()) {
      // A queue can be enqueued after the hold was asserted, so make sure an
      // active hold always has a wake-up even if the enqueue's quiet timer was
      // the first timer to observe it.
      armDispatch(sessionId, hold.expiresAt - now());
      return true;
    }
    holds.delete(sessionId);
    // Expiry is a dispatch boundary, not a reason to leave an idle queue
    // waiting for another status event. Defer one quiet tick so the normal
    // abort/retry gates still get to run before delivery.
    armDispatch(sessionId);
    return true;
  };

  async function tick(sessionId) {
    if (stopped) return;
    const queue = queues.get(sessionId);
    if (!queue || queue.items.length === 0 || sending.has(sessionId) || isHeld(sessionId)) return;

    const abortHoldUntil = (abortedAt.get(sessionId) ?? 0) + abortHoldMs;
    if (abortHoldUntil > now()) {
      armDispatch(sessionId, abortHoldUntil - now());
      return;
    }

    const head = queue.items[0];
    const dispatchGeneration = sessionGeneration(sessionId);
    const dispatchDirectory = queue.directory;
    const failure = failures.get(sessionId);
    if (failure && failure.itemId !== head.id) failures.delete(sessionId);
    else if (failure && failure.nextAttemptAt > now()) {
      armDispatch(sessionId, failure.nextAttemptAt - now());
      return;
    }

    const idle = await isSessionIdle(sessionId, dispatchDirectory);
    if (stopped) return;
    // The hold may have been asserted while either live-idle request was
    // awaiting OpenCode. The authoritative in-memory hold state wins over the
    // result captured before that assertion.
    if (isHeld(sessionId)) return;
    if (idle === null) {
      armDispatch(sessionId, retryDelayMs(1));
      return;
    }
    // Busy: the next idle status event re-arms the loop.
    if (!idle) return;

    // Re-read after the awaits — the user may have edited the queue meanwhile.
    if (isHeld(sessionId)) return;
    const current = queues.get(sessionId);
    const item = current?.items[0];
    if (!item || item.id !== head.id || current.directory !== dispatchDirectory || sessionGeneration(sessionId) !== dispatchGeneration || sending.has(sessionId)) return;

    // Do not let a hold asserted between the final queue read and the send
    // claim cross the dispatch boundary.
    if (isHeld(sessionId)) return;
    sending.set(sessionId, item.id);
    broadcast(sessionId);
    const sendPromise = sendItem(sessionId, dispatchDirectory, item);
    inFlightSends.add(sendPromise);
    try {
      await sendPromise;
      let removed = false;
      try {
        removed = await runMutation(async () => {
          const after = queues.get(sessionId);
          if (!after || sessionGeneration(sessionId) !== dispatchGeneration || sending.get(sessionId) !== item.id) return false;
          const before = captureState();
          setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id));
          failures.delete(sessionId);
          sending.delete(sessionId);
          await commit(sessionId, before);
          return true;
        });
      } catch (error) {
        // OpenCode accepted the prompt, but the destructive removal did not
        // become durable. Keep the item queued and make it retryable rather
        // than claiming a removal the queue file does not contain.
        if (sessionGeneration(sessionId) === dispatchGeneration && sending.get(sessionId) === item.id) {
          sending.delete(sessionId);
          const count = (failure?.itemId === item.id ? failure.failures : 0) + 1;
          const nextAttemptAt = now() + retryDelayMs(count);
          failures.set(sessionId, { itemId: item.id, failures: count, nextAttemptAt });
          console.warn(`[message-queue] sent queued message to ${sessionId}, but removal was not persisted (attempt ${count}):`, error?.message ?? error);
          armDispatch(sessionId, nextAttemptAt - now());
        }
        return;
      }
      if (!removed) return;
      try {
        onPromptSent?.(sessionId);
      } catch {
        // bookkeeping only
      }
      console.log(`[message-queue] sent queued message to ${sessionId}`);
    } catch (error) {
      if (sessionGeneration(sessionId) !== dispatchGeneration || sending.get(sessionId) !== item.id) return;
      sending.delete(sessionId);
      const count = (failure?.itemId === item.id ? failure.failures : 0) + 1;
      const nextAttemptAt = now() + retryDelayMs(count);
      failures.set(sessionId, { itemId: item.id, failures: count, nextAttemptAt });
      const before = captureState();
      const evictedIds = enforceSessionLimit(sessionId);
      if (evictedIds.length > 0) {
        try {
          await commit(sessionId, before, [...evictedIds, sessionId]);
          for (const evictedId of evictedIds) directories.delete(evictedId);
        } catch (persistError) {
          restoreState(before);
          console.warn('[message-queue] failed to persist queue eviction after send failure:', persistError?.message ?? persistError);
          evictedIds.length = 0;
        }
      }
      console.warn(`[message-queue] send to ${sessionId} failed (attempt ${count}):`, error?.message ?? error);
      if (evictedIds.length === 0) broadcast(sessionId);
      armDispatch(sessionId, nextAttemptAt - now());
    } finally {
      inFlightSends.delete(sendPromise);
    }
  }

  const reconcileAll = () => {
    for (const sessionId of queues.keys()) {
      if (!timers.has(sessionId)) armDispatch(sessionId, dispatchQuietMs);
    }
  };

  // --- public mutations ----------------------------------------------------

  const requireSessionId = (sessionId) => {
    if (!isValidSessionId(sessionId)) throw new TypeError('sessionId is invalid');
    return sessionId;
  };

  const assertSessionDirectory = (sessionId, directory, receiptDirectory = '') => {
    const requestedDirectory = asNonEmptyString(directory);
    if (!requestedDirectory) throw new TypeError('directory is required');
    const lifecycle = sessionLifecycles.get(sessionId);
    const authoritative = queues.get(sessionId)?.directory
      ?? directories.get(sessionId)
      ?? lifecycle?.directory
      ?? receiptDirectory;
    if (authoritative && authoritative !== requestedDirectory) {
      const error = httpError('session directory changed; queue mutation was not applied', 409);
      error.directory = authoritative;
      throw error;
    }
    return authoritative || requestedDirectory;
  };

  const enqueue = (sessionIdInput, directoryInput, itemInput, idempotencyKeyInput, expectedGenerationInput) => runMutation(async () => {
    const sessionId = requireSessionId(sessionIdInput);
    const directory = asNonEmptyString(directoryInput);
    if (!directory) throw new TypeError('directory is required');
    const parsed = parseQueuedItemInput(itemInput);
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyInput);
    await load();
    const before = captureState();
    const lifecycleEstablished = canEstablishSessionLifecycleForEnqueue(sessionId);
    assertSessionMutationGeneration(sessionId, expectedGenerationInput, lifecycleEstablished, directory);
    if (lifecycleEstablished) {
      sessionLifecycles.set(sessionId, { generation: 1, deleted: false, restoreRequiresReceipt: true, directory });
      if (!promoteGenerationZeroHold(sessionId, directory, 1)) {
        holdMutationSequences.delete(sessionId);
        holdGenerationTransitions.delete(sessionId);
      }
    } else if (sessionLifecycles.get(sessionId) && !sessionLifecycles.get(sessionId).directory) {
      sessionLifecycles.set(sessionId, { ...sessionLifecycles.get(sessionId), directory });
    }
    const generation = sessionGeneration(sessionId);
    const fingerprint = itemFingerprint(parsed);
    const existingQueue = queues.get(sessionId);
    if (idempotencyKey) {
      const operationId = enqueueOperationKey(sessionId, idempotencyKey);
      const accepted = enqueueIdempotency.get(operationId);
      if (accepted && accepted.generation === generation) {
        if (accepted.fingerprint !== fingerprint) throw httpError('idempotencyKey was already used for a different queued message', 409);
        return { revision, session: sessionSnapshot(sessionId), itemId: accepted.itemId };
      }
      if (accepted) enqueueIdempotency.delete(operationId);
      const duplicate = existingQueue?.items.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (duplicate) {
        if (!queuedItemsMatch(duplicate, parsed)) throw httpError('idempotencyKey was already used for a different queued message', 409);
        return { revision, session: sessionSnapshot(sessionId), itemId: duplicate.id };
      }
    }
    const item = {
      id: `queued-${now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now(),
      ...parsed,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    const existing = queues.get(sessionId);
    const protectedItemIds = new Set(sending.has(sessionId) ? [sending.get(sessionId)] : []);
    const items = trimSessionItems([...(existing?.items ?? []), item], protectedItemIds);
    queues.set(sessionId, { directory, items });
    directories.set(sessionId, directory);
    if (idempotencyKey) {
      const operationId = enqueueOperationKey(sessionId, idempotencyKey);
      enqueueIdempotency.set(operationId, { operationId, sessionId, idempotencyKey, itemId: item.id, fingerprint, generation, createdAt: now() });
      pruneOperationHistory();
    }
    try {
      const evictedIds = enforceSessionLimitOrThrow(sessionId);
      const result = await commit(sessionId, before, [...evictedIds, sessionId]);
      for (const evictedId of evictedIds) directories.delete(evictedId);
      // The session may already be idle (queued from a busy-looking composer
      // right as the turn ended); the tick verifies before sending.
      armDispatch(sessionId);
      return { ...result, itemId: item.id };
    } catch (error) {
      restoreState(before);
      throw error;
    }
  });

  const remove = (sessionIdInput, directoryInput, itemId, expectedGenerationInput) => runMutation(async () => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    assertSessionMutationGeneration(sessionId, expectedGenerationInput, false, directoryInput);
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    if (!queue || !queue.items.some((item) => item.id === itemId)) {
      return { revision, session: sessionSnapshot(sessionId) };
    }
    const before = captureState();
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id !== itemId));
    return commit(sessionId, before);
  });

  /** Removes the item and hands its full payload (attachments included) back. */
  const take = (sessionIdInput, directoryInput, itemId, requireHead = false, operationIdInput, expectedGenerationInput) => runMutation(async () => {
    const sessionId = requireSessionId(sessionIdInput);
    if (typeof requireHead !== 'boolean') throw new TypeError('requireHead must be a boolean');
    const operationId = parseTakeOperationId(operationIdInput);
    await load();
    assertSessionMutationGeneration(sessionId, expectedGenerationInput, false, directoryInput);
    const previousReceipt = operationId && receiptForOperation(operationId, sessionId, 'item', itemId);
    if (previousReceipt) return responseForReceipt(previousReceipt);
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!queue || !item) throw httpError('queued message not found', 404);
    if (requireHead && queue.items[0]?.id !== itemId) throw httpError('queued message is no longer the queue head', 409);
    const receipt = operationId
      ? { operationId, sessionId, directory: queue.directory, kind: 'item', itemId, revision: revision + 1, generation: sessionGeneration(sessionId), createdAt: now(), items: [item] }
      : null;
    if (receipt) assertTakeReceiptPayloadFits(receipt);
    const before = captureState();
    setQueueItems(sessionId, queue.directory, queue.items.filter((entry) => entry.id !== itemId));
    if (receipt) {
      takeReceipts.set(operationId, receipt);
      pruneOperationHistory();
    }
    const result = await commit(sessionId, before);
    return { ...result, generation: sessionGeneration(sessionId), item };
  });

  /** Removes every item not currently being sent and hands them back in order. */
  const takeAll = (sessionIdInput, directoryInput, operationIdInput, expectedGenerationInput) => runMutation(async () => {
    const sessionId = requireSessionId(sessionIdInput);
    const operationId = parseTakeOperationId(operationIdInput);
    await load();
    assertSessionMutationGeneration(sessionId, expectedGenerationInput, false, directoryInput);
    const previousReceipt = operationId && receiptForOperation(operationId, sessionId, 'all');
    if (previousReceipt) return responseForReceipt(previousReceipt);
    const queue = queues.get(sessionId);
    if (!queue) {
      const result = { revision, session: sessionSnapshot(sessionId), items: [] };
      if (operationId) {
        const before = captureState();
        const receipt = { operationId, sessionId, directory: directories.get(sessionId) ?? '', kind: 'all', itemId: null, revision: revision + 1, generation: sessionGeneration(sessionId), createdAt: now(), items: [] };
        assertTakeReceiptPayloadFits(receipt);
        takeReceipts.set(operationId, receipt);
        pruneOperationHistory();
        const committed = await commit(sessionId, before);
        return { ...committed, items: [] };
      }
      return result;
    }
    const sendingId = sending.get(sessionId) ?? null;
    const items = queue.items.filter((item) => item.id !== sendingId);
    if (items.length === 0) {
      const result = { revision, session: sessionSnapshot(sessionId), items: [] };
      if (operationId) {
        const before = captureState();
        const receipt = { operationId, sessionId, directory: queue.directory, kind: 'all', itemId: null, revision: revision + 1, generation: sessionGeneration(sessionId), createdAt: now(), items: [] };
        assertTakeReceiptPayloadFits(receipt);
        takeReceipts.set(operationId, receipt);
        pruneOperationHistory();
        const committed = await commit(sessionId, before);
        return { ...committed, items: [] };
      }
      return result;
    }
    const receipt = operationId
      ? { operationId, sessionId, directory: queue.directory, kind: 'all', itemId: null, revision: revision + 1, generation: sessionGeneration(sessionId), createdAt: now(), items }
      : null;
    const before = captureState();
    if (receipt) {
      assertTakeReceiptPayloadFits(receipt);
      // The payload check must happen before removing any item from the queue.
      setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId));
      takeReceipts.set(operationId, receipt);
      pruneOperationHistory();
    } else {
      setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId));
    }
    const result = await commit(sessionId, before);
    return { ...result, generation: sessionGeneration(sessionId), items };
  });

  const restore = (sessionIdInput, directoryInput, itemInputs, expectedGenerationInput, operationIdInput) => runMutation(async () => {
    const sessionId = requireSessionId(sessionIdInput);
    const directory = asNonEmptyString(directoryInput);
    if (!directory) throw new TypeError('directory is required');
    if (!asList(itemInputs)) throw new TypeError('items must be a list');
    const expectedGeneration = parseExpectedGeneration(expectedGenerationInput);
    const operationId = parseTakeOperationId(operationIdInput);
    await load();
    const lifecycle = sessionLifecycles.get(sessionId);
    const receipt = operationId ? takeReceipts.get(operationId) : null;
    if (receipt && receipt.sessionId !== sessionId) throw httpError('take receipt belongs to a different session', 409);
    const restorationDirectory = assertSessionDirectory(sessionId, directory, receipt?.directory ?? '');
    const parsedInputItems = itemInputs.map(parseRestoredItem);
    const parsedItems = Array.from(new Map(parsedInputItems.map((item) => [item.id, item])).values());
    const completed = operationId ? completedRestoreOperations.get(operationId) : null;
    if (completed) {
      if (completed.sessionId !== sessionId || completed.itemIds.length !== parsedItems.length || completed.itemIds.some((itemId, index) => itemId !== parsedItems[index]?.id) || completed.fingerprint !== restoredItemsFingerprint(parsedItems)) throw httpError('operationId was already used for a different restore', 409);
      return responseForCompletedRestore(completed);
    }
    if (receipt && (parsedInputItems.length !== parsedItems.length || receipt.items.length !== parsedItems.length || receipt.items.some((candidate, index) => candidate.id !== parsedItems[index]?.id) || restoredItemsFingerprint(receipt.items) !== restoredItemsFingerprint(parsedItems))) throw httpError('take receipt does not match the restored batch', 409);
    if (parsedItems.length === 0) return { revision, session: sessionSnapshot(sessionId) };
    if (operationId && !receipt && lifecyclePruned && !lifecycle) throw httpError('take receipt expired; queued messages were not restored', 409);
    if (lifecyclePruned && !lifecycle && !operationId) throw httpError('take receipt is required after lifecycle metadata pruning', 409);
    if (lifecycle?.deleted || (lifecycle?.restoreRequiresReceipt && !receipt) || (receipt && receipt.generation !== sessionGeneration(sessionId)) || (expectedGeneration === null && sessionGeneration(sessionId) > 0) || (expectedGeneration !== null && expectedGeneration !== sessionGeneration(sessionId)) || (receipt && expectedGeneration !== null && receipt.generation !== expectedGeneration)) throw httpError('session lifecycle changed; queued messages were not restored', 409);
    const existing = queues.get(sessionId);
    const existingIds = new Set(existing?.items.map((item) => item.id) ?? []);
    const additions = parsedItems.filter((item) => !existingIds.has(item.id));
    if (additions.length === 0) {
      if (operationId) {
        const before = captureState();
        completedRestoreOperations.set(operationId, { operationId, sessionId, directory: restorationDirectory, revision: revision + 1, generation: sessionGeneration(sessionId), createdAt: now(), itemIds: parsedItems.map((item) => item.id), fingerprint: restoredItemsFingerprint(parsedItems) });
        if (receipt) removeTakeReceipt(sessionId, operationId);
        pruneOperationHistory();
        return commit(sessionId, before);
      }
      return { revision, session: sessionSnapshot(sessionId) };
    }
    const sendingId = sending.get(sessionId) ?? null;
    const existingQueuedItems = (existing?.items ?? []).filter((item) => item.id !== sendingId);
    const availableSlots = MAX_ITEMS_PER_SESSION - (sendingId ? 1 : 0);
    if (additions.length > availableSlots) throw httpError('restored batch exceeds the queue capacity', 409);
    const before = captureState();
    const retainedExistingItems = existingQueuedItems.slice(Math.max(0, existingQueuedItems.length + additions.length - availableSlots));
    try {
      setQueueItems(sessionId, restorationDirectory, [
        ...(sendingId && existing?.items.find((item) => item.id === sendingId) ? [existing.items.find((item) => item.id === sendingId)] : []),
        ...additions,
        ...retainedExistingItems,
      ]);
      const evictedIds = enforceSessionLimitOrThrow(sessionId);
      if (operationId) {
        completedRestoreOperations.set(operationId, { operationId, sessionId, directory: restorationDirectory, revision: revision + 1, generation: sessionGeneration(sessionId), createdAt: now(), itemIds: parsedItems.map((item) => item.id), fingerprint: restoredItemsFingerprint(parsedItems) });
        pruneOperationHistory();
        removeTakeReceipt(sessionId, operationId);
      }
      const result = await commit(sessionId, before, [...evictedIds, sessionId]);
      for (const evictedId of evictedIds) directories.delete(evictedId);
      armDispatch(sessionId);
      return result;
    } catch (error) {
      restoreState(before);
      throw error;
    }
  });

  const reorder = (sessionIdInput, directoryInput, itemIds, expectedGenerationInput) => runMutation(async () => {
    const sessionId = requireSessionId(sessionIdInput);
    if (!asList(itemIds) || itemIds.some((id) => !asNonEmptyString(id))) {
      throw new TypeError('itemIds must be a list of ids');
    }
    await load();
    assertSessionMutationGeneration(sessionId, expectedGenerationInput, false, directoryInput);
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    if (itemIds.length !== byId.size || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !byId.has(id))) {
      throw new TypeError('itemIds must list every queued message exactly once');
    }
    const before = captureState();
    queues.set(sessionId, { directory: queue.directory, items: itemIds.map((id) => byId.get(id)) });
    return commit(sessionId, before);
  });

  const clear = (sessionIdInput, directoryInput, expectedGenerationInput) => runMutation(async () => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    assertSessionMutationGeneration(sessionId, expectedGenerationInput, false, directoryInput);
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    // Never drop a message already handed to OpenCode: its send resolves and
    // must find its entry.
    const sendingId = sending.get(sessionId) ?? null;
    const before = captureState();
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId));
    clearTimer(sessionId);
    return commit(sessionId, before);
  });

  const acknowledgeTake = (sessionIdInput, directoryInput, operationIdInput, expectedGenerationInput) => runMutation(async () => {
    const sessionId = requireSessionId(sessionIdInput);
    const operationId = parseTakeOperationId(operationIdInput);
    if (!operationId) throw new TypeError('operationId is required');
    await load();
    assertSessionMutationGeneration(sessionId, expectedGenerationInput, false, directoryInput);
    const before = captureState();
    if (removeTakeReceipt(sessionId, operationId)) {
      await commit(sessionId, before);
    }
    return { acknowledged: true };
  });

  const setHold = (sessionIdInput, directoryInput, held, ttlMs = HOLD_DEFAULT_TTL_MS, expectedGenerationInput, sequenceInput, clientTokenInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    if (held !== true && held !== false) throw new TypeError('held must be a boolean');
    const expectedGeneration = parseExpectedGeneration(expectedGenerationInput);
    const sequence = sequenceInput === undefined ? null : asCount(sequenceInput);
    if (sequenceInput !== undefined && sequence === null) throw new TypeError('sequence must be a non-negative integer');
    const clientToken = parseHoldClientToken(clientTokenInput);
    const generation = sessionGeneration(sessionId);
    const lifecycle = sessionLifecycles.get(sessionId);
    const hold = holds.get(sessionId);
    const transition = holdGenerationTransitions.get(sessionId);
    const isCapturedGenerationZeroRelease = !held
      && expectedGeneration !== null
      && transition?.fromGeneration === expectedGeneration
      && transition.toGeneration === generation
      && hold?.generation === generation
      && hold.clientToken === clientToken;
    if (lifecycle?.deleted || (!isCapturedGenerationZeroRelease && (expectedGeneration === null && generation > 0)) || (!isCapturedGenerationZeroRelease && expectedGeneration !== null && expectedGeneration !== generation)) {
      const error = httpError('session lifecycle changed; queue hold was not updated', 409);
      error.generation = generation;
      error.deleted = lifecycle?.deleted === true;
      throw error;
    }
    const directory = assertSessionDirectory(sessionId, directoryInput);
    const previous = holdMutationSequences.get(sessionId);
    const currentExpiresAt = hold?.expiresAt;
    const holdResponse = (isHeld, expiresAt, responseSequence) => {
      const response = { held: isHeld, expiresAt };
      if (responseSequence !== null) response.sequence = responseSequence;
      return response;
    };
    const activeHold = hold
      && hold.expiresAt > now()
      && hold.generation === generation
      && hold.directory === directory
      ? hold
      : null;
    if (activeHold && activeHold.clientToken !== clientToken) {
      return holdResponse(true, activeHold.expiresAt, activeHold.sequence);
    }
    if (sequence !== null && previous && previous.clientToken === clientToken && previous.sequence !== null && sequence < previous.sequence) {
      return holdResponse(currentExpiresAt !== undefined, currentExpiresAt ?? null, previous.sequence);
    }
    const nextMutation = { clientToken, sequence, generation, directory };
    holdMutationSequences.set(sessionId, nextMutation);
    if (held) {
      const ttl = Math.min(asCount(ttlMs) || HOLD_DEFAULT_TTL_MS, HOLD_MAX_TTL_MS);
      holds.set(sessionId, { expiresAt: now() + ttl, ...nextMutation });
      if (previous && previous.clientToken !== clientToken) holdGenerationTransitions.delete(sessionId);
      clearTimer(sessionId);
      if (queues.has(sessionId)) armDispatch(sessionId, ttl);
      return holdResponse(true, holds.get(sessionId).expiresAt, sequence);
    }
    holds.delete(sessionId);
    holdGenerationTransitions.delete(sessionId);
    armDispatch(sessionId);
    return holdResponse(false, null, sequence);
  };

  // --- events --------------------------------------------------------------

  const processPayloadNow = async (value) => {
    const payload = asRecord(value);
    if (stopped || !payload) return;

    const createdSession = extractCreatedSession(payload);
    if (createdSession) {
      const lifecycle = sessionLifecycles.get(createdSession.sessionId);
      if (!lifecycle) {
        if (!lifecyclePruned) return;
        sessionLifecycles.set(createdSession.sessionId, {
          generation: 1,
          deleted: false,
          restoreRequiresReceipt: true,
          ...(createdSession.directory ? { directory: createdSession.directory } : {}),
        });
      } else if (lifecycle.deleted) {
        sessionLifecycles.set(createdSession.sessionId, {
          generation: lifecycle.generation + 1,
          deleted: false,
          restoreRequiresReceipt: true,
          ...(createdSession.directory ? { directory: createdSession.directory } : {}),
        });
      } else return;
      const before = captureState();
      if (!promoteGenerationZeroHold(createdSession.sessionId, createdSession.directory, sessionGeneration(createdSession.sessionId))) {
        holdMutationSequences.delete(createdSession.sessionId);
        holdGenerationTransitions.delete(createdSession.sessionId);
      }
      if (createdSession.directory) directories.set(createdSession.sessionId, createdSession.directory);
      await commit(createdSession.sessionId, before);
      return;
    }

    const updatedSession = extractUpdatedSession(payload);
    if (updatedSession) {
      const lifecycle = sessionLifecycles.get(updatedSession.sessionId);
      if (lifecycle?.deleted) return;
      const queue = queues.get(updatedSession.sessionId);
      const previousDirectory = queue?.directory ?? directories.get(updatedSession.sessionId);
      if (previousDirectory === undefined || previousDirectory === updatedSession.directory) return;
      const before = captureState();
      directories.set(updatedSession.sessionId, updatedSession.directory);
      if (lifecycle) sessionLifecycles.set(updatedSession.sessionId, { ...lifecycle, directory: updatedSession.directory });
      if (queue) {
        queues.set(updatedSession.sessionId, { directory: updatedSession.directory, items: queue.items });
        await commit(updatedSession.sessionId, before);
        armDispatch(updatedSession.sessionId);
      } else {
        await commit(updatedSession.sessionId, before);
      }
      return;
    }

    const deletedSessionId = extractDeletedSessionId(payload);
    if (deletedSessionId) {
      const lifecycle = sessionLifecycles.get(deletedSessionId);
      if (lifecycle?.deleted) return;
      const directory = directories.get(deletedSessionId) ?? queues.get(deletedSessionId)?.directory ?? lifecycle?.directory;
      const before = captureState();
      sessionLifecycles.set(deletedSessionId, {
        generation: (lifecycle?.generation ?? 0) + 1,
        deleted: true,
        deletedAt: now(),
        ...(directory ? { directory } : {}),
      });
      queues.delete(deletedSessionId);
      clearTimer(deletedSessionId);
      sending.delete(deletedSessionId);
      failures.delete(deletedSessionId);
      abortedAt.delete(deletedSessionId);
      holds.delete(deletedSessionId);
      holdMutationSequences.delete(deletedSessionId);
      holdGenerationTransitions.delete(deletedSessionId);
      pruneSessionLifecycles();
      await commit(deletedSessionId, before);
      directories.delete(deletedSessionId);
      return;
    }

    const status = extractSessionStatus(payload);
    if (status) {
      if (!queues.has(status.sessionId)) return;
      if (status.type === 'idle') armDispatch(status.sessionId);
      else clearTimer(status.sessionId);
      return;
    }

    const assistant = extractAssistantMessageUpdate(payload);
    if (assistant && queues.has(assistant.sessionId)) {
      if (assistant.aborted) abortedAt.set(assistant.sessionId, now());
      // A completed reply without a following idle status (missed event)
      // must still drain the queue; the tick verifies idleness itself.
      if (assistant.completed && !timers.has(assistant.sessionId)) armDispatch(assistant.sessionId);
    }
  };

  const processPayload = (value) => {
    const payload = asRecord(value);
    if (stopped || !payload) return Promise.resolve();
    if (!loaded) {
      pendingPayloads.push(payload);
      return Promise.resolve();
    }
    return runMutation(() => processPayloadNow(payload));
  };

  const processEvent = (event) => {
    const raw = asRecord(asRecord(event)?.payload);
    const result = processPayload(asRecord(raw?.payload) ?? raw);
    void result.catch((error) => {
      console.warn('[message-queue] failed to apply queue event:', error?.message ?? error);
    });
    return result;
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') reconcileAll();
    });
    void load()
      .then(() => {
        if (queues.size > 0) console.log(`[message-queue] restored queues for ${queues.size} session(s)`);
        reconcileAll();
      })
      .catch((error) => {
        console.warn('[message-queue] failed to load queue file:', error?.message ?? error);
      });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  const stop = () => {
    if (drainPromise) return drainPromise;
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    drainPromise = Promise.allSettled(Array.from(inFlightSends)).then(() => undefined);
    return drainPromise;
  };

  return {
    load,
    snapshot,
    sessionSnapshot,
    enqueue,
    remove,
    take,
    takeAll,
    acknowledgeTake,
    restore,
    reorder,
    clear,
    setHold,
    processPayload,
    start,
    stop,
    /** Drains the pending write; tests and shutdown use it. */
    flush: () => lastWritePromise,
  };
}

export function registerMessageQueueRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError ? 400 : (Number.isInteger(error?.status) ? error.status : 500);
    const body = { error: error?.message ?? fallback };
    if (Number.isInteger(error?.generation)) body.generation = error.generation;
    if (typeof error?.directory === 'string' && error.directory) body.directory = error.directory;
    if (typeof error?.deleted === 'boolean') body.deleted = error.deleted;
    res.status(status).json(body);
  };

  app.get('/api/message-queue', async (_req, res) => {
    try {
      await runtime.load();
      res.json(runtime.snapshot());
    } catch (error) {
      respondError(res, error, 'Failed to load message queue');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items', async (req, res) => {
    try {
      res.json(await runtime.enqueue(req.params.sessionId, req.body?.directory, req.body?.item, req.body?.idempotencyKey, req.body?.generation));
    } catch (error) {
      respondError(res, error, 'Failed to queue message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/take', async (req, res) => {
    try {
      res.json(await runtime.takeAll(req.params.sessionId, req.body?.directory, req.body?.operationId, req.body?.generation));
    } catch (error) {
      respondError(res, error, 'Failed to take queued messages');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/restore', async (req, res) => {
    try {
      res.json(await runtime.restore(req.params.sessionId, req.body?.directory, req.body?.items, req.body?.generation, req.body?.operationId));
    } catch (error) {
      respondError(res, error, 'Failed to restore queued messages');
    }
  });

  app.put('/api/message-queue/sessions/:sessionId/order', async (req, res) => {
    try {
      res.json(await runtime.reorder(req.params.sessionId, req.body?.directory, req.body?.itemIds, req.body?.generation));
    } catch (error) {
      respondError(res, error, 'Failed to reorder queue');
    }
  });

  app.put('/api/message-queue/sessions/:sessionId/hold', async (req, res) => {
    try {
      await runtime.load();
      res.json(runtime.setHold(req.params.sessionId, req.body?.directory, req.body?.held, req.body?.ttlMs, req.body?.generation, req.body?.sequence, req.body?.clientToken));
    } catch (error) {
      respondError(res, error, 'Failed to update queue hold');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId', async (req, res) => {
    try {
      res.json(await runtime.clear(req.params.sessionId, req.body?.directory, req.body?.generation));
    } catch (error) {
      respondError(res, error, 'Failed to clear queue');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items/:itemId/take', async (req, res) => {
    try {
      res.json(await runtime.take(req.params.sessionId, req.body?.directory, req.params.itemId, req.body?.requireHead === true, req.body?.operationId, req.body?.generation));
    } catch (error) {
      respondError(res, error, 'Failed to take queued message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/take-receipts/:operationId/ack', async (req, res) => {
    try {
      res.json(await runtime.acknowledgeTake(req.params.sessionId, req.body?.directory, req.params.operationId, req.body?.generation));
    } catch (error) {
      respondError(res, error, 'Failed to acknowledge queue take');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId/items/:itemId', async (req, res) => {
    try {
      res.json(await runtime.remove(req.params.sessionId, req.body?.directory, req.params.itemId, req.body?.generation));
    } catch (error) {
      respondError(res, error, 'Failed to remove queued message');
    }
  });
}
