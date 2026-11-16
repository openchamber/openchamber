import fs from 'fs';
import path from 'path';
import { createMessageId } from '../dispatch-results/runtime.js';
import { assertPromptResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { attachmentHint } from '../routing/runtime.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';

const QUEUE_FILE_NAME = 'message-queue.json';
const QUEUE_FILE_VERSION = 1;

const MAX_SESSIONS = 50;
const MAX_ITEMS_PER_SESSION = 20;
const CONTENT_CHAR_LIMIT = 200_000;

const DISPATCH_QUIET_MS = 500;
const ABORT_HOLD_MS = 2_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_TAIL_LIMIT = 2;

const ATTACHMENT_SOURCES = new Set(['local', 'server', 'vscode']);
const CONTEXT_PART_KINDS = new Set(['context', 'instruction', 'synthetic']);
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]{8,64}$/;

const getQueuedSendRetryDelayMs = (failures) =>
  Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

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

const parseGoal = (value) => {
  if (value === undefined) return null;
  const raw = asRecord(value);
  if (!raw) throw new TypeError('invalid goal');
  const tokenBudget = raw.tokenBudget ?? null;
  if (tokenBudget !== null && !(Number.isInteger(tokenBudget) && tokenBudget > 0)) throw new TypeError('invalid goal tokenBudget');
  const goal = { tokenBudget };
  const objective = asNonEmptyString(raw.objective);
  if (objective) goal.objective = objective;
  return goal;
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
  const agentPath = asNonEmptyString(raw.agentPath);
  if (agentPath) attachment.agentPath = agentPath;
  attachment.dataUrl = dataUrl;
  return attachment;
};

const parseContextPart = (value) => {
  const raw = asRecord(value);
  if (!raw || !CONTEXT_PART_KINDS.has(raw.kind)) return null;
  const text = asText(raw.text);
  if (raw.kind !== 'context') return { kind: raw.kind, text };
  const metadata = asRecord(raw.metadata);
  if (!metadata) return null;
  const part = { kind: 'context', text, metadata };
  const instructions = asNonEmptyString(raw.instructions);
  if (instructions) part.instructions = instructions;
  return part;
};

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
  const provenance = asRecord(raw.scheduledTask);
  const projectId = asNonEmptyString(provenance?.projectId);
  const taskId = asNonEmptyString(provenance?.taskId);
  if (provenance && (!projectId || !taskId)) throw new TypeError('invalid scheduledTask provenance');
  if (!sendConfig && !provenance) throw new TypeError('item sendConfig with providerID and modelID is required');
  const goal = parseGoal(raw.goal);
  if (goal && !text.trim()) throw new TypeError('a goal needs message text');
  const item = { content, text };
  const agentMention = asNonEmptyString(raw.agentMention);
  if (agentMention) item.agentMention = agentMention;
  item.attachments = attachments;
  item.context = context;
  const contextPreview = asNonEmptyString(raw.contextPreview).slice(0, 103);
  if (contextPreview) item.contextPreview = contextPreview;
  item.sendConfig = sendConfig ?? {};
  if (goal) item.goal = goal;
  if (provenance) {
    item.scheduledTask = { projectId, taskId };
    const agent = asNonEmptyString(raw.sendConfig?.agent);
    if (agent) item.sendConfig.agent = agent;
  }
  return item;
};

const parseStoredItem = (value) => {
  const raw = asRecord(value);
  const id = raw ? asNonEmptyString(raw.id) : '';
  if (!id) return null;
  try {
    const item = { id, createdAt: asCount(raw.createdAt) ?? Date.now(), ...parseQueuedItemInput(raw) };
    const syntheticIds = asList(raw.syntheticIds) ?? [];
    if (syntheticIds.length > 0 && syntheticIds.every((entry) => MESSAGE_ID_PATTERN.test(asText(entry)))) item.syntheticIds = syntheticIds;
    return item;
  } catch {
    return null;
  }
};

const toPublicAttachment = ({ dataUrl: _dataUrl, ...attachment }) => attachment;

const toPublicItem = (item) => {
  const publicItem = { id: item.id, createdAt: item.createdAt, content: item.content, text: item.text };
  if (item.agentMention) publicItem.agentMention = item.agentMention;
  publicItem.attachments = item.attachments.map(toPublicAttachment);
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
  if (item.goal) publicItem.goal = { ...item.goal };
  if (item.scheduledTask) publicItem.scheduledTask = { ...item.scheduledTask };
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
    completed: asCount(asRecord(info.time)?.completed) !== null,
  };
};

// external: https://github.com/anomalyco/opencode OpenCode v2 emits session.execution.interrupted, translated to session.idle with aborted: true.
const extractAbortedSessionId = (payload) => {
  if (payload.type !== 'session.idle') return null;
  const properties = asRecord(payload.properties) ?? {};
  if (properties.aborted !== true) return null;
  return asNonEmptyString(properties.sessionID);
};

const extractDeletedSessionId = (payload) => {
  if (payload.type !== 'session.deleted') return null;
  const properties = asRecord(payload.properties) ?? {};
  return asNonEmptyString(asRecord(properties.info)?.id) || asNonEmptyString(properties.sessionID) || null;
};

const extractSessionDirectoryUpdate = (payload) => {
  if (payload.type !== 'session.updated') return null;
  const properties = asRecord(payload.properties) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(info.id) || asNonEmptyString(properties.sessionID);
  const directory = asNonEmptyString(info.directory);
  const projectID = asNonEmptyString(info.projectID);
  return sessionId && directory && projectID ? { sessionId, directory } : null;
};

export function createMessageQueueRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime = null,
  broadcastGlobalUiEvent,
  onPromptSent,
  beforeScheduledTaskSend,
  validateScheduledTaskTarget,
  onScheduledTaskResult,
  resolveAutoSelection = null,
  persistSessionGoal = null,
  isDeliveryHeld = () => false,
  deliveryHoldReady = Promise.resolve(),
  dataDir,
  fetchImpl = fetch,
  now = Date.now,
  dispatchQuietMs = DISPATCH_QUIET_MS,
  abortHoldMs = ABORT_HOLD_MS,
  retryDelayMs = getQueuedSendRetryDelayMs,
}) {
  const filePath = path.join(dataDir, QUEUE_FILE_NAME);

  const queues = new Map();
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;

  const runtimeStartedAt = now();

  const sending = new Map();
  const timers = new Map();
  const failures = new Map();
  const abortedAt = new Map();
  const directories = new Map();

  const serialize = () => ({
    version: QUEUE_FILE_VERSION,
    revision,
    sessions: Object.fromEntries(
      Array.from(queues.entries()).map(([sessionId, queue]) => [sessionId, { directory: queue.directory, items: queue.items }]),
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
      sessions[sessionId] = { directory, items };
    }
    return { sessions, revision: asCount(stored.revision) ?? 0 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const [sessionId, entry] of Object.entries(stored.sessions)) queues.set(sessionId, entry);
          revision = Math.max(revision, stored.revision);
        })
        .catch((error) => {
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify(serialize());
    const write = writePromise.then(async () => {
      await fs.promises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
    });
    writePromise = write.catch((error) => {
      console.warn('[message-queue] failed to persist queue:', error?.message ?? error);
    });
    return write;
  };

  const sessionSnapshot = (sessionId) => {
    const queue = queues.get(sessionId);
    return {
      sessionId,
      directory: queue?.directory ?? directories.get(sessionId) ?? '',
      items: (queue?.items ?? []).map(toPublicItem),
      sendingId: sending.get(sessionId) ?? null,
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

  const commit = (sessionId) => {
    revision += 1;
    persist().catch(() => undefined);
    broadcast(sessionId);
    return { revision, session: sessionSnapshot(sessionId) };
  };

  const reportScheduledResult = (item, status, error) => {
    if (!item.scheduledTask) return;
    Promise.resolve().then(() => onScheduledTaskResult?.(item.scheduledTask, status, error))
      .catch((failure) => console.warn('[message-queue] scheduled task state write failed:', failure?.message ?? failure));
  };

  const setQueueItems = (sessionId, directory, items, status = 'cancelled', error) => {
    for (const item of queues.get(sessionId)?.items ?? []) {
      if (item.scheduledTask && !items.some((entry) => entry.id === item.id)) reportScheduledResult(item, status, error);
    }
    directories.set(sessionId, directory);
    if (items.length === 0) {
      queues.delete(sessionId);
      return;
    }
    queues.set(sessionId, { directory, items });
  };

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
    if (method === 'POST') {
      await assertPromptResponse(response, 'OpenCode dispatch');
    }
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  const isSessionIdle = async (sessionId, directory) => {
    const body = asRecord(await openCodeFetch('/api/session/active').catch(() => null));
    const statuses = asRecord(body && 'data' in body ? body.data : body);
    if (!statuses) return null;
    if (asRecord(statuses[sessionId])) return false;
    // external: https://github.com/anomalyco/opencode OpenCode v2 lists messages newest first, so the tail is messages[0].
    const page = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_TAIL_LIMIT) },
    }).catch(() => null);
    const messages = asList(asRecord(page)?.data);
    if (!messages) return null;
    const last = asRecord(messages[0]);
    const lastTime = asRecord(last?.time);
    if (last?.type === 'assistant' && asCount(lastTime?.completed) === null) {
      const created = asCount(lastTime?.created);
      if (created === null || created >= runtimeStartedAt) return false;
      console.log(`[message-queue] ignoring pre-boot unfinished tail for ${sessionId}`);
    }
    return true;
  };

  const resolveSlashCommand = async (text, directory) => {
    if (!text.startsWith('/')) return null;
    const [head, ...tail] = text.split(' ');
    const name = head.slice(1);
    if (!name) return null;
    const commands = asList(await openCodeFetch('/api/command', { directory })) ?? [];
    const match = commands.map(asRecord).find((command) => command?.name === name);
    if (!match) return null;
    return {
      name,
      arguments: tail.join(' '),
    };
  };

  // external: https://github.com/anomalyco/opencode OpenCode v2 takes prompt attachments as URIs, and a data URL is one.
  const toPromptFile = (attachment) => ({
    uri: attachment.dataUrl,
    ...(attachment.agentPath || attachment.filename ? { name: attachment.agentPath || attachment.filename } : {}),
  });

  const toContextMessages = (part) => {
    const body = { text: part.text, resume: false };
    if (part.kind !== 'context') return [body];
    const withMetadata = part.metadata ? { ...body, metadata: part.metadata } : body;
    return part.instructions
      ? [{ text: part.instructions, resume: false }, withMetadata]
      : [withMetadata];
  };

  const ensureSyntheticIds = async (item, count) => {
    if (item.syntheticIds?.length === count) return;
    const firstAt = now() - count + 1;
    item.syntheticIds = Array.from({ length: count }, (_, index) => createMessageId(firstAt + index));
    try {
      await persist();
    } catch (error) {
      delete item.syntheticIds;
      throw error;
    }
  };

  const sendItem = async (sessionId, directory, item) => {
    const { providerID, modelID, variant } = item.sendConfig;
    let agent = item.sendConfig.agent;
    let model = { id: modelID, providerID, ...(variant ? { variant } : {}) };
    const promptFiles = item.attachments.map(toPromptFile);
    const synthetics = [
      ...item.context.flatMap(toContextMessages),
      ...(item.goal ? [{ text: buildGoalIntroText(item.goal.tokenBudget), resume: false }] : []),
    ];

    const routed = providerID && modelID ? await resolveAutoSelection?.({
      sessionId,
      directory,
      model,
      agent,
      requestText: `${item.text}${attachmentHint({ files: promptFiles })}`.trim(),
    }) : null;
    if (routed) {
      model = routed.model;
      agent = routed.agent ?? agent;
    }

    // external: https://github.com/anomalyco/opencode OpenCode v2 holds the model and agent on the session, so the choice is switched once and persists.
    if (!item.scheduledTask || (providerID && modelID)) await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/model`, {
      directory,
      method: 'POST',
      body: { model },
    });
    if (agent) {
      await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/agent`, {
        directory,
        method: 'POST',
        body: { agent },
      });
    }

    const command = await resolveSlashCommand(item.text, directory);

    if (sessionKnowledgeRuntime) await sessionKnowledgeRuntime.sync(sessionId, directory);

    if (synthetics.length > 0) {
      await ensureSyntheticIds(item, synthetics.length);
      const session = asRecord(await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}`, { directory }));
      if (!session) throw new Error(`OpenCode returned no record for session ${sessionId}`);
      if (session.revert) {
        await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/revert/commit`, { directory, method: 'POST' });
      }
    }

    if (item.goal) {
      await createSessionGoal({
        persistSessionGoal,
        sessionID: sessionId,
        directory,
        objective: item.goal.objective || item.text,
        tokenBudget: item.goal.tokenBudget,
        providerID: model.providerID,
        modelID: model.id,
        onWarning: (message, error) => console.warn(`[message-queue] ${message}:`, error?.message || error),
      });
    }

    for (const [index, synthetic] of synthetics.entries()) {
      await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
        directory,
        method: 'POST',
        body: { id: item.syntheticIds[index], ...synthetic },
      });
    }

    if (command) {
      await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/command`, {
        directory,
        method: 'POST',
        body: {
          // external: https://github.com/anomalyco/opencode OpenCode 2.0.8 renamed the command body field command to name.
          name: command.name,
          text: command.arguments,
          ...(promptFiles.length > 0 ? { files: promptFiles } : {}),
        },
      });
    } else {
      await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
        directory,
        method: 'POST',
        body: {
          text: item.text,
          ...(promptFiles.length > 0 ? { files: promptFiles } : {}),
          ...(item.agentMention ? { agents: [{ name: item.agentMention }] } : {}),
        },
      });
    }
  };

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

  async function tick(sessionId) {
    if (stopped) return;
    const queue = queues.get(sessionId);
    if (!queue || queue.items.length === 0 || sending.has(sessionId) || isDeliveryHeld(sessionId)) return;

    const abortHoldUntil = (abortedAt.get(sessionId) ?? 0) + abortHoldMs;
    if (abortHoldUntil > now()) {
      armDispatch(sessionId, abortHoldUntil - now());
      return;
    }

    const head = queue.items[0];
    const failure = failures.get(sessionId);
    if (failure && failure.itemId !== head.id) failures.delete(sessionId);
    else if (failure && failure.nextAttemptAt > now()) {
      armDispatch(sessionId, failure.nextAttemptAt - now());
      return;
    }

    const idle = await isSessionIdle(sessionId, queue.directory);
    if (idle === null) {
      if (head.scheduledTask && validateScheduledTaskTarget) {
        try {
          await validateScheduledTaskTarget(head.scheduledTask.projectId, sessionId);
        } catch (error) {
          if (error?.statusCode === 404 || error?.statusCode === 409) {
            const after = queues.get(sessionId);
            if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== head.id), 'failed', error.message);
            commit(sessionId);
            armDispatch(sessionId);
            return;
          }
        }
      }
      armDispatch(sessionId, retryDelayMs(1));
      return;
    }
    if (!idle) return;

    const current = queues.get(sessionId);
    const item = current?.items[0];
    if (!item || item.id !== head.id || sending.has(sessionId)) return;

    sending.set(sessionId, item.id);
    broadcast(sessionId);
    try {
      if (item.scheduledTask) {
        try {
          await beforeScheduledTaskSend?.(sessionId, current.directory, item);
        } catch (error) {
          if (error?.statusCode !== 404 && error?.statusCode !== 409) throw error;
          sending.delete(sessionId);
          const after = queues.get(sessionId);
          if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id), 'failed', error.message);
          failures.delete(sessionId);
          commit(sessionId);
          armDispatch(sessionId);
          return;
        }
      }
      await sendItem(sessionId, current.directory, item);
      const after = queues.get(sessionId);
      if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id), 'sent');
      failures.delete(sessionId);
      sending.delete(sessionId);
      commit(sessionId);
      try {
        onPromptSent?.(sessionId);
      } catch {
        // bookkeeping only
      }
      console.log(`[message-queue] sent queued message to ${sessionId}`);
    } catch (error) {
      sending.delete(sessionId);
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
      if (!timers.has(sessionId)) armDispatch(sessionId, dispatchQuietMs);
    }
  };

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
    if (parsed.scheduledTask) {
      for (const queue of queues.values()) {
        if (queue.items.some((entry) => entry.scheduledTask?.projectId === parsed.scheduledTask.projectId && entry.scheduledTask.taskId === parsed.scheduledTask.taskId)) {
          throw httpError('task is already queued', 409);
        }
      }
      if ((queues.get(sessionId)?.items.length ?? 0) >= MAX_ITEMS_PER_SESSION || (!queues.has(sessionId) && queues.size >= MAX_SESSIONS)) {
        throw httpError('message queue is full', 409);
      }
    }
    const item = {
      id: `queued-${now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now(),
      ...parsed,
    };
    const existing = queues.get(sessionId);
    const items = [...(existing?.items ?? []), item].slice(-MAX_ITEMS_PER_SESSION);
    setQueueItems(sessionId, directory, items);
    directories.set(sessionId, directory);
    if (queues.size > MAX_SESSIONS) {
      const oldest = Array.from(queues.entries())
        .filter(([id]) => id !== sessionId && !sending.has(id))
        .sort((left, right) => (left[1].items[0]?.createdAt ?? 0) - (right[1].items[0]?.createdAt ?? 0))
        .slice(0, queues.size - MAX_SESSIONS);
      for (const [staleId] of oldest) {
        setQueueItems(staleId, directories.get(staleId), []);
        clearTimer(staleId);
        broadcast(staleId);
        directories.delete(staleId);
      }
    }
    const result = commit(sessionId);
    armDispatch(sessionId);
    return { ...result, itemId: item.id };
  };

  const remove = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    if (!queue || !queue.items.some((item) => item.id === itemId)) {
      return { revision, session: sessionSnapshot(sessionId) };
    }
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id !== itemId));
    return commit(sessionId);
  };

  const take = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!queue || !item) throw httpError('queued message not found', 404);
    if (item.scheduledTask) throw httpError('scheduled messages cannot be taken', 409);
    setQueueItems(sessionId, queue.directory, queue.items.filter((entry) => entry.id !== itemId));
    return { ...commit(sessionId), item };
  };

  const takeAll = async (sessionIdInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId), items: [] };
    const sendingId = sending.get(sessionId) ?? null;
    const items = queue.items.filter((item) => item.id !== sendingId && !item.scheduledTask);
    if (items.length === 0) return { revision, session: sessionSnapshot(sessionId), items: [] };
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId || item.scheduledTask));
    return { ...commit(sessionId), items };
  };

  const reorder = async (sessionIdInput, itemIds) => {
    const sessionId = requireSessionId(sessionIdInput);
    if (!asList(itemIds) || itemIds.some((id) => !asNonEmptyString(id))) {
      throw new TypeError('itemIds must be a list of ids');
    }
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
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
    const sendingId = sending.get(sessionId) ?? null;
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId));
    clearTimer(sessionId);
    return commit(sessionId);
  };

  const release = (sessionId) => {
    armDispatch(sessionId);
  };

  const processPayload = (value) => {
    const payload = asRecord(value);
    if (stopped || !payload) return;

    const deletedSessionId = extractDeletedSessionId(payload);
    if (deletedSessionId) {
      if (!queues.has(deletedSessionId)) return;
      setQueueItems(deletedSessionId, directories.get(deletedSessionId), []);
      clearTimer(deletedSessionId);
      failures.delete(deletedSessionId);
      commit(deletedSessionId);
      directories.delete(deletedSessionId);
      return;
    }

    const moved = extractSessionDirectoryUpdate(payload);
    if (moved) {
      const queue = queues.get(moved.sessionId);
      if (queue && queue.directory !== moved.directory) {
        setQueueItems(moved.sessionId, moved.directory, queue.items);
        commit(moved.sessionId);
      }
      return;
    }

    const status = extractSessionStatus(payload);
    if (status) {
      if (!queues.has(status.sessionId)) return;
      if (status.type === 'idle') armDispatch(status.sessionId);
      else clearTimer(status.sessionId);
      return;
    }

    const abortedSessionId = extractAbortedSessionId(payload);
    if (abortedSessionId) {
      if (queues.has(abortedSessionId)) abortedAt.set(abortedSessionId, now());
      return;
    }

    const assistant = extractAssistantMessageUpdate(payload);
    if (assistant && queues.has(assistant.sessionId)) {
      if (assistant.completed && !timers.has(assistant.sessionId)) armDispatch(assistant.sessionId);
    }
  };

  const processEvent = (event) => {
    for (const payload of event?.translated?.() ?? []) processPayload(payload);
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') reconcileAll();
    });
    void load()
      .then(async () => {
        if (queues.size > 0) console.log(`[message-queue] restored queues for ${queues.size} session(s)`);
        await deliveryHoldReady;
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

  const cancelScheduledTask = async (projectId, taskId) => {
    await load();
    for (const [sessionId, queue] of queues) {
      const items = queue.items.filter((item) => item.scheduledTask?.projectId !== projectId || item.scheduledTask.taskId !== taskId || sending.get(sessionId) === item.id);
      if (items.length === queue.items.length) continue;
      setQueueItems(sessionId, queue.directory, items);
      commit(sessionId);
      armDispatch(sessionId);
    }
  };

  return {
    load,
    snapshot,
    sessionSnapshot,
    enqueue,
    cancelScheduledTask,
    remove,
    take,
    takeAll,
    reorder,
    clear,
    release,
    processPayload,
    start,
    stop,
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
      if (req.body?.item?.scheduledTask) throw new TypeError('scheduledTask is server-owned');
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

  app.put('/api/message-queue/sessions/:sessionId/order', async (req, res) => {
    try {
      res.json(await runtime.reorder(req.params.sessionId, req.body?.itemIds));
    } catch (error) {
      respondError(res, error, 'Failed to reorder queue');
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
