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
const MANUAL_CLAIM_START_TTL_MS = 5_000;
const MANUAL_CONFIRM_MS = 5_000;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_TAIL_LIMIT = 2;

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

const isValidSessionId = (value) => SESSION_ID_PATTERN.test(asNonEmptyString(value));

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
  if (!id) return null;
  try {
    return { id, createdAt: asCount(raw.createdAt) ?? Date.now(), ...parseQueuedItemInput(raw) };
  } catch {
    return null;
  }
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
}) {
  const filePath = path.join(dataDir, QUEUE_FILE_NAME);

  /** sessionId → { directory, items } */
  const queues = new Map();
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let durableRevision = 0;
  let stopped = false;

  /** Automatic sends are transient; manual operations are restored from disk. */
  const sending = new Map(); // sessionId → Set<itemId>
  // Started manual claims retain their exact identity across process restarts.
  const manualClaims = new Map(); // sessionId → Map<itemId, claim>
  const reconciling = new Set();
  const absentSince = new Map(); // token → first consecutive idle/absent observation
  const timers = new Map(); // sessionId → timeout
  const failures = new Map(); // sessionId → { itemId, failures, nextAttemptAt }
  const abortedAt = new Map(); // sessionId → timestamp
  const holds = new Map(); // sessionId → expiresAt
  // sessionId → directory, kept after the queue empties: the UI keys its
  // projection by directory, so the broadcast that removes the last item must
  // still name it or the client cannot tell which queue just finished.
  const directories = new Map();

  // --- persistence ---------------------------------------------------------

  const serialize = () => ({
    version: QUEUE_FILE_VERSION,
    revision,
    sessions: Object.fromEntries(
      Array.from(queues.entries()).map(([sessionId, queue]) => [sessionId, {
        directory: queue.directory,
        items: queue.items,
        manualClaims: Object.fromEntries([...(manualClaims.get(sessionId) ?? [])].filter(([, claim]) => claim.started)),
      }]),
    ),
  });

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') return { sessions: {}, revision: 0 };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Malformed is a failure, not an empty queue: keep the bytes for the
      // user and start over rather than overwriting them on the next write.
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[message-queue] queue file was unreadable and moved to ${backup}: ${error?.message ?? error}`);
      return { sessions: {}, revision: 0 };
    }
    const stored = asRecord(parsed) ?? {};
    const sessions = {};
    for (const [sessionId, value] of Object.entries(asRecord(stored.sessions) ?? {})) {
      const entry = asRecord(value);
      if (!entry || !isValidSessionId(sessionId)) continue;
      const directory = asNonEmptyString(entry.directory);
      const items = (asList(entry.items) ?? []).map(parseStoredItem).filter(Boolean);
      if (!directory || items.length === 0) continue;
      const claims = {};
      if ((stored.version === 2 || entry.manualClaims !== undefined) && !asRecord(entry.manualClaims)) throw new Error('Invalid persisted manual claims');
      for (const [itemId, value] of Object.entries(entry.manualClaims ?? {})) {
        const claim = asRecord(value);
        if (!items.some((item) => item.id === itemId) || !claim || !asNonEmptyString(claim.token)
          || !/^msg_[A-Za-z0-9_-]+$/.test(asNonEmptyString(claim.messageID)) || claim.started !== true
          || ![true, false].includes(claim.dispatched)) throw new Error('Invalid persisted manual claim');
        claims[itemId] = { token: claim.token, messageID: claim.messageID, started: true, dispatched: claim.dispatched };
      }
      sessions[sessionId] = { directory, items, claims };
    }
    return { sessions, revision: asCount(stored.revision) ?? 0 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const [sessionId, entry] of Object.entries(stored.sessions)) {
            queues.set(sessionId, { directory: entry.directory, items: entry.items });
            const claims = new Map(Object.entries(entry.claims));
            if (claims.size > 0) {
              manualClaims.set(sessionId, claims);
              sending.set(sessionId, new Set(claims.keys()));
            }
          }
          revision = Math.max(revision, stored.revision);
          durableRevision = revision;
        })
        .catch((error) => {
          // A read failure keeps the in-memory (empty) queue but must not be
          // mistaken for "nothing queued": the next write would clobber the
          // file, so writes stay disabled until a later load succeeds.
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify(serialize());
    const writingRevision = revision;
    const write = writePromise
      .then(async () => {
        await fs.promises.mkdir(dataDir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
        durableRevision = writingRevision;
      });
    writePromise = write.catch((error) => {
      console.warn('[message-queue] failed to persist queue:', error?.message ?? error);
    });
    return write;
  };

  // --- snapshots -----------------------------------------------------------

  const sessionSnapshot = (sessionId) => {
    const queue = queues.get(sessionId);
    const sendingIds = [...(sending.get(sessionId) ?? [])];
    return {
      sessionId,
      directory: queue?.directory ?? directories.get(sessionId) ?? '',
      items: (queue?.items ?? []).map(toPublicItem),
      // `sendingId` remains the automatic head-send compatibility field. Newer
      // clients use `sendingIds` because a manual composer batch may be pending.
      sendingId: sendingIds[0] ?? null,
      sendingIds,
    };
  };

  const snapshot = () => ({
    revision,
    sessions: Array.from(queues.keys()).map(sessionSnapshot),
  });

  const broadcast = (sessionId) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:message-queue.updated',
      properties: { revision, session: sessionSnapshot(sessionId) },
    });
  };

  /** Every mutation goes through here: bump, persist, broadcast. */
  const commit = (sessionId, durable = false) => {
    revision += 1;
    const write = persist();
    // The chain logs failures; callers at dispatch boundaries must also see them.
    void write.catch(() => undefined);
    broadcast(sessionId);
    const result = { revision, session: sessionSnapshot(sessionId) };
    return durable ? write.then(() => result) : result;
  };

  const setQueueItems = (sessionId, directory, items) => {
    directories.set(sessionId, directory);
    if (items.length === 0) {
      queues.delete(sessionId);
      return;
    }
    queues.set(sessionId, { directory, items });
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
    const expiresAt = holds.get(sessionId);
    if (expiresAt === undefined) return false;
    if (expiresAt > now()) return true;
    holds.delete(sessionId);
    return false;
  };

  const releaseSending = (sessionId, itemIds) => {
    const currentSending = sending.get(sessionId);
    if (!currentSending) return;
    for (const itemId of itemIds) currentSending.delete(itemId);
    if (currentSending.size === 0) sending.delete(sessionId);
  };

  const releaseManualClaim = (sessionId, itemIds, token) => {
    const claims = manualClaims.get(sessionId);
    if (!claims) return;
    const released = [];
    for (const itemId of itemIds) {
      const claim = claims.get(itemId);
      if (claim && claim.token === token) {
        claims.delete(itemId);
        released.push(itemId);
      }
    }
    if (claims.size === 0) manualClaims.delete(sessionId);
    releaseSending(sessionId, released);
    absentSince.delete(token);
  };

  const releaseExpiredUnstartedClaims = (sessionId) => {
    const claims = manualClaims.get(sessionId);
    if (!claims) return;
    const abandoned = [...claims]
      .filter(([, claim]) => !claim.started && claim.expiresAt <= now())
      .map(([itemId]) => itemId);
    if (abandoned.length === 0) return;
    for (const itemId of abandoned) claims.delete(itemId);
    if (claims.size === 0) manualClaims.delete(sessionId);
    releaseSending(sessionId, abandoned);
    commit(sessionId);
  };

  async function tick(sessionId) {
    if (stopped) return;
    await writePromise;
    if (durableRevision < revision) {
      try { await persist(); } catch { armDispatch(sessionId, MANUAL_CONFIRM_MS); return; }
    }
    if (stopped) return;
    const queue = queues.get(sessionId);
    if (!queue || queue.items.length === 0) return;
    releaseExpiredUnstartedClaims(sessionId);

    const head = queue.items[0];
    if (sending.get(sessionId)?.has(head.id)) {
      const claim = manualClaims.get(sessionId)?.get(head.id);
      if (!claim) return;
      if (!claim.started) {
        armDispatch(sessionId, claim.expiresAt - now());
        return;
      }
      if (reconciling.has(sessionId)) return;
      reconciling.add(sessionId);
      try {
        let absent = false;
        const record = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(claim.messageID)}`, { directory: queue.directory })
          .catch((error) => { if (error.status === 404) absent = true; return null; });
        const info = asRecord(asRecord(record)?.info);
        const accepted = info?.id === claim.messageID && info?.sessionID === sessionId && info?.role === 'user';
        const idle = !accepted && absent ? await isSessionIdle(sessionId, queue.directory) : null;
        // Dispatch, fail, ACK, or a new owner may have won while these reads ran.
        if (manualClaims.get(sessionId)?.get(head.id) !== claim || stopped) return;
        const ids = [...manualClaims.get(sessionId)].filter(([, entry]) => entry.token === claim.token && entry.messageID === claim.messageID).map(([id]) => id);
        if (accepted) {
          await ackManualSend(sessionId, ids, claim.token);
        } else if (!claim.dispatched && absent && idle === true) {
          const since = absentSince.get(claim.token);
          if (since !== undefined && now() - since >= MANUAL_CONFIRM_MS) {
            await failManualSend(sessionId, ids, claim.token);
          } else if (since === undefined) absentSince.set(claim.token, now());
        } else absentSince.delete(claim.token);
      } finally {
        reconciling.delete(sessionId);
        armDispatch(sessionId, MANUAL_CONFIRM_MS);
      }
      return;
    }
    if (isHeld(sessionId)) return;

    const abortHoldUntil = (abortedAt.get(sessionId) ?? 0) + abortHoldMs;
    if (abortHoldUntil > now()) {
      armDispatch(sessionId, abortHoldUntil - now());
      return;
    }

    const failure = failures.get(sessionId);
    if (failure && failure.itemId !== head.id) failures.delete(sessionId);
    else if (failure && failure.nextAttemptAt > now()) {
      armDispatch(sessionId, failure.nextAttemptAt - now());
      return;
    }

    const idle = await isSessionIdle(sessionId, queue.directory);
    if (idle === null) {
      armDispatch(sessionId, retryDelayMs(1));
      return;
    }
    // Busy: the next idle status event re-arms the loop.
    if (!idle) return;

    // Re-read after the awaits — the user may have edited the queue meanwhile.
    const current = queues.get(sessionId);
    const currentSending = sending.get(sessionId) ?? new Set();
    const item = current?.items[0];
    if (!item || item.id !== head.id || currentSending.has(item.id) || isHeld(sessionId) || stopped) return;

    sending.set(sessionId, new Set([...currentSending, item.id]));
    broadcast(sessionId);
    try {
      await sendItem(sessionId, current.directory, item);
      const after = queues.get(sessionId);
      if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id));
      failures.delete(sessionId);
      releaseSending(sessionId, [item.id]);
      commit(sessionId);
      try {
        onPromptSent?.(sessionId);
      } catch {
        // bookkeeping only
      }
      console.log(`[message-queue] sent queued message to ${sessionId}`);
    } catch (error) {
      releaseSending(sessionId, [item.id]);
      const count = (failure?.itemId === item.id ? failure.failures : 0) + 1;
      const nextAttemptAt = now() + retryDelayMs(count);
      failures.set(sessionId, { itemId: item.id, failures: count, nextAttemptAt });
      console.warn(`[message-queue] send to ${sessionId} failed (attempt ${count}):`, error?.message ?? error);
      broadcast(sessionId);
      armDispatch(sessionId, nextAttemptAt - now());
    }
  }

  const reconcileAll = () => {
    for (const sessionId of queues.keys()) {
      armDispatch(sessionId, dispatchQuietMs);
    }
  };

  // --- public mutations ----------------------------------------------------

  const requireSessionId = (sessionId) => {
    if (!isValidSessionId(sessionId)) throw new TypeError('sessionId is invalid');
    return sessionId;
  };

  const enqueue = async (sessionIdInput, directoryInput, itemInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    const directory = asNonEmptyString(directoryInput);
    if (!directory) throw new TypeError('directory is required');
    const parsed = parseQueuedItemInput(itemInput);
    await load();
    const item = {
      id: `queued-${now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now(),
      ...parsed,
    };
    const existing = queues.get(sessionId);
    if ((existing?.items.length ?? 0) >= MAX_ITEMS_PER_SESSION) throw httpError('queue is full', 409);
    const items = [...(existing?.items ?? []), item];
    queues.set(sessionId, { directory, items });
    directories.set(sessionId, directory);
    if (queues.size > MAX_SESSIONS) {
      const oldest = Array.from(queues.entries())
        .filter(([id]) => id !== sessionId && !sending.has(id))
        .sort((left, right) => (left[1].items[0]?.createdAt ?? 0) - (right[1].items[0]?.createdAt ?? 0))
        .slice(0, queues.size - MAX_SESSIONS);
      for (const [staleId] of oldest) {
        queues.delete(staleId);
        clearTimer(staleId);
        broadcast(staleId);
        directories.delete(staleId);
      }
    }
    const result = commit(sessionId);
    // The session may already be idle (queued from a busy-looking composer
    // right as the turn ended); the tick verifies before sending.
    armDispatch(sessionId);
    return { ...result, itemId: item.id };
  };

  const remove = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId)?.has(itemId)) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    if (!queue || !queue.items.some((item) => item.id === itemId)) {
      return { revision, session: sessionSnapshot(sessionId) };
    }
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id !== itemId));
    return commit(sessionId);
  };

  /** Removes the item and hands its full payload (attachments included) back. */
  const take = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId)?.has(itemId)) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!queue || !item) throw httpError('queued message not found', 404);
    setQueueItems(sessionId, queue.directory, queue.items.filter((entry) => entry.id !== itemId));
    return { ...commit(sessionId), item };
  };

  /** Removes every item not currently being sent and hands them back in order. */
  const takeAll = async (sessionIdInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId), items: [] };
    const sendingIds = sending.get(sessionId) ?? new Set();
    const items = queue.items.filter((item) => !sendingIds.has(item.id));
    if (items.length === 0) return { revision, session: sessionSnapshot(sessionId), items: [] };
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => sendingIds.has(item.id)));
    return { ...commit(sessionId), items };
  };

  const parseItemIds = (itemIds) => {
    if (!asList(itemIds) || itemIds.length === 0 || itemIds.some((id) => !asNonEmptyString(id))) {
      throw new TypeError('itemIds must be a non-empty list of ids');
    }
    if (new Set(itemIds).size !== itemIds.length) throw new TypeError('itemIds must not contain duplicates');
    return itemIds;
  };

  /**
   * Hands complete payloads to a foreground composer without removing them.
   * The subsequent acknowledgement removes only the entries OpenCode accepted;
   * rejection releases this temporary claim for retry.
   */
  const beginManualSend = async (sessionIdInput, itemIdsInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    const itemIds = parseItemIds(itemIdsInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) throw httpError('queued message not found', 404);
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    if (itemIds.some((itemId) => !byId.has(itemId))) throw httpError('queued message not found', 404);
    const currentSending = sending.get(sessionId) ?? new Set();
    // The composer reads the projection before this request. Filter again at
    // the authority so an automatic head claim that won that race is never
    // included in the manual outgoing batch.
    const claimableIds = queue.items.filter((item) => itemIds.includes(item.id) && !currentSending.has(item.id)).map((item) => item.id);
    if (claimableIds.length === 0) return { revision, session: sessionSnapshot(sessionId), items: [] };
    const token = `manual-${now()}-${Math.random().toString(36).slice(2, 9)}`;
    const claims = manualClaims.get(sessionId) ?? new Map();
    const expiresAt = now() + MANUAL_CLAIM_START_TTL_MS;
    for (const itemId of claimableIds) claims.set(itemId, { token, started: false, expiresAt });
    manualClaims.set(sessionId, claims);
    sending.set(sessionId, new Set([...currentSending, ...claimableIds]));
    return { ...commit(sessionId), token, items: claimableIds.map((itemId) => byId.get(itemId)) };
  };

  const startManualSend = async (sessionIdInput, itemIdsInput, token, messageID) => {
    const sessionId = requireSessionId(sessionIdInput);
    const itemIds = parseItemIds(itemIdsInput);
    if (!asNonEmptyString(token)) throw new TypeError('token is required');
    if (!/^msg_[A-Za-z0-9_-]+$/.test(asNonEmptyString(messageID))) throw new TypeError('messageID is required');
    await load();
    const claims = manualClaims.get(sessionId);
    if (!claims || itemIds.some((itemId) => claims.get(itemId)?.token !== token)) {
      throw httpError('manual claim is not current', 409);
    }
    const prefix = queues.get(sessionId)?.items.slice(0, itemIds.length) ?? [];
    if (prefix.length !== itemIds.length || prefix.some((item, index) => item.id !== itemIds[index])) {
      throw httpError('earlier queued message is unresolved', 409);
    }
    if ([...claims].some(([id, claim]) => claim.token === token && !itemIds.includes(id))) throw httpError('start must bind the exact claim', 409);
    for (const itemId of itemIds) {
      const claim = claims.get(itemId);
      if (claim.started && claim.messageID !== messageID) throw httpError('manual claim identity differs', 409);
      if (!claim.started && claim.expiresAt <= now()) throw httpError('manual claim expired', 409);
    }
    clearTimer(sessionId);
    for (const itemId of itemIds) {
      const claim = claims.get(itemId);
      claim.started = true;
      claim.messageID = messageID;
      claim.dispatched ??= false;
    }
    try {
      const result = await commit(sessionId, true);
      return { ...result, token };
    } finally {
      armDispatch(sessionId, MANUAL_CONFIRM_MS);
    }
  };

  const dispatchManualSend = async (sessionIdInput, itemIdsInput, token, endpoint, bodyInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    const itemIds = parseItemIds(itemIdsInput);
    const body = asRecord(bodyInput);
    if (!['prompt_async', 'command'].includes(endpoint) || !body || (!asList(body.parts) && endpoint === 'prompt_async')) throw new TypeError('invalid manual send request');
    await load();
    const claims = manualClaims.get(sessionId);
    if (!claims || itemIds.some((id) => {
      const claim = claims.get(id);
      return !claim?.started || claim.token !== token || claim.messageID !== body.messageID || claim.dispatched;
    }) || [...claims].some(([id, claim]) => claim.token === token && !itemIds.includes(id))) {
      throw httpError('manual dispatch is not current or already dispatched', 409);
    }
    const queue = queues.get(sessionId);
    if (queue.items.slice(0, itemIds.length).some((item, index) => item.id !== itemIds[index])) throw httpError('earlier queued message is unresolved', 409);
    // This write precedes upstream I/O. A crash or timeout after it is ambiguous,
    // even if a later idle snapshot does not yet contain the message.
    const owners = itemIds.map((id) => claims.get(id));
    for (const claim of owners) claim.dispatched = true;
    absentSince.delete(token);
    try {
      await commit(sessionId, true);
    } catch (error) {
      // The upstream request has not started. Restore only this still-current
      // ownership so a later definite rejection or reconciliation can release it.
      for (const [index, id] of itemIds.entries()) {
        if (manualClaims.get(sessionId)?.get(id) === owners[index]) owners[index].dispatched = false;
      }
      throw error;
    }
    if (stopped || itemIds.some((id, index) => manualClaims.get(sessionId)?.get(id) !== owners[index])) {
      throw httpError('manual dispatch owner changed', 409);
    }
    try {
      await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/${endpoint}`, { directory: queue.directory, method: 'POST', body });
    } catch (error) {
      if ([400, 401, 403, 404, 422].includes(error.status)) {
        for (const id of itemIds) {
          if (claims.get(id)?.token === token) claims.get(id).dispatched = false;
        }
        await failManualSend(sessionId, itemIds, token);
        throw error;
      }
      throw httpError('manual dispatch outcome is unknown', 503);
    } finally {
      armDispatch(sessionId, MANUAL_CONFIRM_MS);
    }
    // Upstream acceptance must not become a client rejection if local ACK
    // persistence fails. The retained disk claim reconciles by message ID.
    await ackManualSend(sessionId, itemIds, token).catch(() => undefined);
  };

  const ackManualSend = async (sessionIdInput, itemIdsInput, token) => {
    const sessionId = requireSessionId(sessionIdInput);
    const itemIds = parseItemIds(itemIdsInput);
    await load();
    if (!asNonEmptyString(token)) throw new TypeError('token is required');
    const currentSending = sending.get(sessionId);
    const claims = manualClaims.get(sessionId);
    const queue = queues.get(sessionId);
    const queuedIds = new Set(queue?.items.map((item) => item.id) ?? []);
    if (itemIds.every((itemId) => !queuedIds.has(itemId))) {
      return { revision, session: sessionSnapshot(sessionId) };
    }
    if (!currentSending || !claims || itemIds.some((itemId) => claims.get(itemId)?.token !== token)) {
      throw httpError('message is not being sent', 409);
    }
    if (queue) setQueueItems(sessionId, queue.directory, queue.items.filter((item) => !itemIds.includes(item.id)));
    releaseManualClaim(sessionId, itemIds, token);
    failures.delete(sessionId);
    return commit(sessionId, true);
  };

  const failManualSend = async (sessionIdInput, itemIdsInput, token) => {
    const sessionId = requireSessionId(sessionIdInput);
    const itemIds = parseItemIds(itemIdsInput);
    await load();
    if (!asNonEmptyString(token)) throw new TypeError('token is required');
    const claims = manualClaims.get(sessionId);
    if (!claims || itemIds.some((itemId) => claims.get(itemId)?.token !== token)) {
      throw httpError('message is not being sent', 409);
    }
    if (itemIds.some((itemId) => claims.get(itemId).dispatched)) throw httpError('manual dispatch outcome is unresolved', 409);
    releaseManualClaim(sessionId, itemIds, token);
    armDispatch(sessionId, MANUAL_CONFIRM_MS);
    return commit(sessionId, true);
  };

  const reorder = async (sessionIdInput, itemIds) => {
    const sessionId = requireSessionId(sessionIdInput);
    if (!asList(itemIds) || itemIds.some((id) => !asNonEmptyString(id))) {
      throw new TypeError('itemIds must be a list of ids');
    }
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    if (sending.has(sessionId)) throw httpError('message is being sent', 409);
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    if (itemIds.length !== byId.size || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !byId.has(id))) {
      throw new TypeError('itemIds must list every queued message exactly once');
    }
    queues.set(sessionId, { directory: queue.directory, items: itemIds.map((id) => byId.get(id)) });
    return commit(sessionId);
  };

  const clear = async (sessionIdInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    // Never drop a message already handed to OpenCode: its send resolves and
    // must find its entry.
    const sendingIds = sending.get(sessionId) ?? new Set();
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => sendingIds.has(item.id)));
    if (!manualClaims.has(sessionId)) clearTimer(sessionId);
    return commit(sessionId);
  };

  const setHold = (sessionIdInput, held, ttlMs = HOLD_DEFAULT_TTL_MS) => {
    const sessionId = requireSessionId(sessionIdInput);
    if (held !== true && held !== false) throw new TypeError('held must be a boolean');
    if (held) {
      const ttl = Math.min(asCount(ttlMs) || HOLD_DEFAULT_TTL_MS, HOLD_MAX_TTL_MS);
      holds.set(sessionId, now() + ttl);
      if (!manualClaims.has(sessionId)) clearTimer(sessionId);
      return { held: true, expiresAt: holds.get(sessionId) };
    }
    holds.delete(sessionId);
    armDispatch(sessionId);
    return { held: false, expiresAt: null };
  };

  // --- events --------------------------------------------------------------

  const processPayload = (value) => {
    const payload = asRecord(value);
    if (stopped || !payload) return;

    const deletedSessionId = extractDeletedSessionId(payload);
    if (deletedSessionId) {
      if (!queues.has(deletedSessionId)) return;
      queues.delete(deletedSessionId);
      for (const claim of manualClaims.get(deletedSessionId)?.values() ?? []) absentSince.delete(claim.token);
      manualClaims.delete(deletedSessionId);
      sending.delete(deletedSessionId);
      clearTimer(deletedSessionId);
      failures.delete(deletedSessionId);
      commit(deletedSessionId);
      directories.delete(deletedSessionId);
      return;
    }

    const status = extractSessionStatus(payload);
    if (status) {
      if (!queues.has(status.sessionId)) return;
      if (status.type === 'idle') armDispatch(status.sessionId);
      else if (!manualClaims.has(status.sessionId)) clearTimer(status.sessionId);
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

  const processEvent = (event) => {
    const raw = asRecord(asRecord(event)?.payload);
    processPayload(asRecord(raw?.payload) ?? raw);
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
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  return {
    load,
    snapshot,
    sessionSnapshot,
    enqueue,
    remove,
    take,
    takeAll,
    beginManualSend,
    startManualSend,
    dispatchManualSend,
    ackManualSend,
    failManualSend,
    reorder,
    clear,
    setHold,
    processPayload,
    start,
    stop,
    /** Drains the pending write; tests and shutdown use it. */
    flush: () => writePromise,
  };
}

export function registerMessageQueueRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError ? 400 : (Number.isInteger(error?.status) ? error.status : 500);
    res.status(status).json({ error: error?.message ?? fallback });
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
      res.json(await runtime.enqueue(req.params.sessionId, req.body?.directory, req.body?.item));
    } catch (error) {
      respondError(res, error, 'Failed to queue message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/take', async (req, res) => {
    try {
      res.json(await runtime.takeAll(req.params.sessionId));
    } catch (error) {
      respondError(res, error, 'Failed to take queued messages');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/manual-send', async (req, res) => {
    try {
      res.json(await runtime.beginManualSend(req.params.sessionId, req.body?.itemIds));
    } catch (error) {
      respondError(res, error, 'Failed to begin queued message send');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/manual-send/start', async (req, res) => {
    try {
      res.json(await runtime.startManualSend(req.params.sessionId, req.body?.itemIds, req.body?.token, req.body?.messageID));
    } catch (error) {
      respondError(res, error, 'Failed to start queued message send');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/manual-send/dispatch', async (req, res) => {
    try {
      await runtime.dispatchManualSend(req.params.sessionId, req.body?.itemIds, req.body?.token, req.body?.endpoint, req.body?.body);
      res.status(204).end();
    } catch (error) {
      respondError(res, error, 'Failed to dispatch queued message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/manual-send/ack', async (req, res) => {
    try {
      res.json(await runtime.ackManualSend(req.params.sessionId, req.body?.itemIds, req.body?.token));
    } catch (error) {
      respondError(res, error, 'Failed to acknowledge queued message send');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/manual-send/fail', async (req, res) => {
    try {
      res.json(await runtime.failManualSend(req.params.sessionId, req.body?.itemIds, req.body?.token));
    } catch (error) {
      respondError(res, error, 'Failed to release queued message send');
    }
  });

  app.put('/api/message-queue/sessions/:sessionId/order', async (req, res) => {
    try {
      res.json(await runtime.reorder(req.params.sessionId, req.body?.itemIds));
    } catch (error) {
      respondError(res, error, 'Failed to reorder queue');
    }
  });

  app.put('/api/message-queue/sessions/:sessionId/hold', async (req, res) => {
    try {
      await runtime.load();
      res.json(runtime.setHold(req.params.sessionId, req.body?.held, req.body?.ttlMs));
    } catch (error) {
      respondError(res, error, 'Failed to update queue hold');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId', async (req, res) => {
    try {
      res.json(await runtime.clear(req.params.sessionId));
    } catch (error) {
      respondError(res, error, 'Failed to clear queue');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items/:itemId/take', async (req, res) => {
    try {
      res.json(await runtime.take(req.params.sessionId, req.params.itemId));
    } catch (error) {
      respondError(res, error, 'Failed to take queued message');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId/items/:itemId', async (req, res) => {
    try {
      res.json(await runtime.remove(req.params.sessionId, req.params.itemId));
    } catch (error) {
      respondError(res, error, 'Failed to remove queued message');
    }
  });
}
