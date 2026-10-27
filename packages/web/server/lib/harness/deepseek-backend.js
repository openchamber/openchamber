/**
 * deepseek-backend.js — OpenChamber harness backend runtime for DeepSeek Harness
 * (`dsh`) over ACP.
 *
 * Mirrors the shape of `codex-backend.js`: it exports a single factory
 * `createDeepSeekBackendRuntime(deps)` whose returned object is registered as a
 * backend runtime (`registerRuntime('deepseek', ...)`) and exposes the same
 * session/prompt/abort/control-surface surface the harness routes call.
 *
 * The transport lives in `./deepseek-appserver.js`; this module owns web-side
 * session persistence, message/part records, event emission, busy status and the
 * ACP↔harness mapping.
 *
 * Capabilities are under-claimed on purpose: only what the adapter implements is set to
 * `true` in `CAPABILITIES`.
 *
 * @module
 */

import path from 'node:path';

import { createDeepSeekAppServerAdapter, partsToAcpContentBlocks } from './deepseek-appserver.js';
import { createSessionBindingsRuntime } from './session-bindings.js';

/** @typedef {import('../../harness-contracts/src/index.ts').HarnessBackendCapabilities} HarnessBackendCapabilities */

const BACKEND_ID = 'deepseek';

// dsh's ACP `model` config option uses the JSON-encoded [provider, model] pair as its value.
const modelOptionValue = (providerId, modelId) => JSON.stringify([providerId, modelId]);

// The route this backend is pinned to. `dsh` only knows the one provider defined in its
// profile, so a deepseek session can never fall back to another vendor's model. Defaults
// match stock `dsh`; DEEPSEEK_PROVIDER / DEEPSEEK_MODEL / DEEPSEEK_MODELS override them.
const buildSnapshotModels = (envObj = {}) => {
  const providerId = envObj.DEEPSEEK_PROVIDER || 'deepseek-official';
  const defaultId = envObj.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const ids = (envObj.DEEPSEEK_MODELS || defaultId).split(',').map((id) => id.trim()).filter(Boolean);
  return Object.freeze(ids.map((modelId) => Object.freeze({
    id: modelOptionValue(providerId, modelId),
    label: modelId,
    description: providerId,
    default: modelId === defaultId,
    raw: { providerId, modelID: modelId },
  })));
};

/** ACP has no shell/share/agents; config + approvals are real. Under-claim. */
const CAPABILITIES = Object.freeze({
  chat: true,
  sessions: true,
  models: true,
  shell: false,
  share: false,
  delete: true,
  agents: false,
  providers: false,
  auth: false,
  commands: false,
  config: true,
  skills: false,
  approvals: true,
});

// ---------------------------------------------------------------------------
// Small pure helpers (mirrors of the reference helpers)
// ---------------------------------------------------------------------------

const normalizeDirectory = (directory) => {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const createId = (crypto) =>
  `${Date.now().toString(16).padStart(12, '0')}${crypto.randomBytes(4).toString('hex')}`;

let lastSortableTimestamp = 0;
let sortableCounter = 0;
const createSortableId = (prefix, crypto) => {
  const ts = Date.now();
  if (ts === lastSortableTimestamp) {
    sortableCounter += 1;
  } else {
    lastSortableTimestamp = ts;
    sortableCounter = 0;
  }
  const suffix = `${sortableCounter.toString(16).padStart(3, '0')}${crypto
    .randomBytes(4)
    .toString('hex')}`;
  return `${prefix}_${ts.toString(16).padStart(12, '0')}${suffix}`;
};

const cloneRecord = (record) => ({
  info: {
    ...record.info,
    time: record.info?.time ? { ...record.info.time } : undefined,
    model: record.info?.model ? { ...record.info.model } : undefined,
  },
  parts: record.parts.map((part) => ({ ...part })),
});

// ---------------------------------------------------------------------------
// Runtime factory
// ---------------------------------------------------------------------------

/**
 * @param {Object} dependencies
 * @param {object} dependencies.crypto
 * @param {object} dependencies.fsPromises
 * @param {string} dependencies.sessionsFilePath
 * @param {(event: object) => void} [dependencies.publishEvent]
 * @param {ReturnType<typeof createDeepSeekAppServerAdapter>} [dependencies.appServer] test seam
 * @param {NodeJS.ProcessEnv} [dependencies.env]
 */
export const createDeepSeekBackendRuntime = (dependencies = {}) => {
  const {
    crypto,
    fsPromises,
    sessionsFilePath,
    publishEvent,
    env,
    appServer: injectedAppServer,
  } = dependencies;

  if (!crypto || !fsPromises || !sessionsFilePath) {
    throw new Error('createDeepSeekBackendRuntime requires { crypto, fsPromises, sessionsFilePath }');
  }

  const runtimeEnv = env || process.env;
  const MODEL_PROVIDER_ID = runtimeEnv.DEEPSEEK_PROVIDER || 'deepseek-official';
  const SNAPSHOT_MODELS = buildSnapshotModels(runtimeEnv);
  const PROVIDER_SNAPSHOT = Object.freeze({
    backendId: BACKEND_ID,
    label: 'DeepSeek Harness',
    enabled: true,
    auth: { status: 'unknown' },
    capabilities: CAPABILITIES,
    models: SNAPSHOT_MODELS,
  });

  // Backend-private binding store: openchamber session id -> ACP session id.
  const bindingsFilePath = `${sessionsFilePath.replace(/\.json$/, '')}-bindings.json`;
  const sessionBindings = createSessionBindingsRuntime({
    fsPromises,
    path,
    bindingsFilePath,
  });

  let loaded = false;
  let writeLock = Promise.resolve();
  /** @type {Map<string, { session: object, records: object[], acpSessionId: string|null, bindings: object|null }>} */
  const sessions = new Map();
  /** sessionId -> AbortController */
  const runControllers = new Map();
  /** sessionId -> true while a turn is starting or running (synchronous admission guard) */
  const turnLocks = new Set();
  /** sessionId -> { type: 'busy'|'idle', ... } */
  const busyStatus = new Map();
  const eventClients = new Set();
  /** appServer permissionId -> { sessionId, directory, options, toolCall } */
  const pendingPermissions = new Map();

  const emitEvent = (directory, payload) => {
    const normalizedDirectory = normalizeDirectory(directory) || 'global';
    const eventPayload = {
      id: createId(crypto),
      directory: normalizedDirectory,
      ...payload,
    };
    try {
      publishEvent?.({
        payload: eventPayload,
        directory: normalizedDirectory,
        eventId: eventPayload.id,
      });
    } catch {
      // never let a publish failure break a turn
    }
    const encoded = `data: ${JSON.stringify(eventPayload)}\n\n`;
    for (const client of eventClients) {
      if (client.directory && client.directory !== normalizedDirectory) {
        continue;
      }
      try {
        client.res.write(encoded);
      } catch {
        // client gone; routes clean up on close
      }
    }
  };

  // --- app-server adapter -------------------------------------------------
  const appServer =
    injectedAppServer ||
    createDeepSeekAppServerAdapter({
      crypto,
      env,
      onSessionUpdate: ({ sessionId, update }) => handleSessionUpdate(sessionId, update),
      onPermissionRequest: ({ requestId, sessionId, directory, params }) =>
        handlePermissionRequest(requestId, sessionId, directory, params),
    });

  // --- persistence --------------------------------------------------------
  const ensureLoaded = async () => {
    if (loaded) return;
    try {
      const raw = await fsPromises.readFile(sessionsFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
      for (const entry of entries) {
        const normalized = normalizeEntry(entry);
        if (normalized) sessions.set(normalized.session.id, normalized);
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.warn(`[deepseek-backend] failed to load sessions: ${err.message}`);
      }
    }
    loaded = true;
  };

  const persist = async () => {
    const write = async () => {
      const payload = { sessions: [...sessions.values()].map(serializeEntry) };
      await fsPromises.mkdir(path.dirname(sessionsFilePath), { recursive: true });
      const tmp = `${sessionsFilePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fsPromises.rename(tmp, sessionsFilePath);
    };
    writeLock = writeLock.then(write, write);
    return writeLock;
  };

  const normalizeEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const session = entry.session && typeof entry.session === 'object' ? entry.session : null;
    if (!session || typeof session.id !== 'string') return null;
    return {
      session: {
        ...session,
        directory: normalizeDirectory(session.directory),
        time: {
          created: typeof session.time?.created === 'number' ? session.time.created : Date.now(),
          updated: typeof session.time?.updated === 'number' ? session.time.updated : Date.now(),
        },
      },
      records: Array.isArray(entry.records) ? entry.records.map(cloneRecord) : [],
      acpSessionId: typeof entry.acpSessionId === 'string' ? entry.acpSessionId : null,
      bindings: entry.bindings ?? null,
    };
  };

  const serializeEntry = (entry) => ({
    session: entry.session,
    records: entry.records,
    acpSessionId: entry.acpSessionId,
    bindings: entry.bindings,
  });

  const getEntry = async (sessionId) => {
    await ensureLoaded();
    return sessions.get(sessionId) ?? null;
  };

  const persistEntry = async (entry) => {
    sessions.set(entry.session.id, entry);
    await persist();
  };

  // --- session builders ---------------------------------------------------
  const buildSession = async (input = {}) => {
    const directory = normalizeDirectory(input.directory);
    const now = Date.now();
    const session = {
      id: createSortableId('ses', crypto),
      slug: null,
      projectID: null,
      directory,
      parentID: typeof input.parentID === 'string' ? input.parentID : null,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'New session',
      version: '0.1.0',
      time: { created: now, updated: now },
      share: null,
      backendId: BACKEND_ID,
    };

    const entry = { session, records: [], acpSessionId: null, bindings: null };

    if (directory) {
      try {
        const created = await appServer.newSession({ directory });
        if (created?.sessionId) {
          entry.acpSessionId = created.sessionId;
          entry.bindings = { directory };
          await sessionBindings.upsertBinding({
            sessionId: session.id,
            backendId: BACKEND_ID,
            backendSessionId: created.sessionId,
            directory,
          });
        }
      } catch (err) {
        console.warn(`[deepseek-backend] session/new failed, will retry on prompt: ${err?.message}`);
      }
    }
    return entry;
  };

  const buildMessageRecord = ({ sessionId, role, parts = [], parentMessageId = null, model = null }) => ({
    info: {
      id: createSortableId('msg', crypto),
      sessionID: sessionId,
      role,
      time: { created: Date.now() },
      parentID: parentMessageId,
      model,
      agent: BACKEND_ID,
    },
    parts,
  });

  const buildTextPart = (text) => ({ id: createSortableId('prt', crypto), type: 'text', text });
  const buildReasoningPart = (text) => ({ id: createSortableId('prt', crypto), type: 'reasoning', text });

  // --- event emission -----------------------------------------------------
  const emitSessionUpdate = (type, session) => {
    emitEvent(session.directory, {
      type,
      properties: { info: session, sessionID: session.id, directory: session.directory },
    });
  };

  const emitRecordEvents = (directory, record) => {
    emitEvent(directory, { type: 'message.updated', properties: { info: record.info } });
    const sessionID = record.info.sessionID;
    const messageID = record.info.id;
    // Parts must carry their owning ids: the UI's v1 adapter files parts by
    // `part.messageID` (an empty string otherwise) and keys rows by `part.id`.
    for (const part of record.parts) {
      emitEvent(directory, {
        type: 'message.part.updated',
        properties: { part: { ...part, sessionID, messageID } },
      });
    }
  };

  const setBusyStatus = (sessionId, directory, status) => {
    busyStatus.set(sessionId, { ...status, at: Date.now() });
    emitEvent(directory, {
      type: 'session.status',
      properties: { sessionID: sessionId, status },
    });
    if (status.type === 'idle') {
      emitEvent(directory, { type: 'session.idle', properties: { sessionID: sessionId } });
    }
  };

  // --- ACP update → record mutation --------------------------------------
  /** acpSessionId -> active turn context */
  const activeTurns = new Map();

  const handleSessionUpdate = (acpSessionId, update) => {
    const turn = activeTurns.get(acpSessionId);
    if (!turn || !update || typeof update !== 'object') return;
    const { entry, assistantRecord } = turn;
    const directory = entry.session.directory;

    const emitPart = (part) => {
      const idx = assistantRecord.parts.findIndex((p) => p.id === part.id);
      if (idx >= 0) assistantRecord.parts[idx] = part;
      else assistantRecord.parts.push(part);
      emitEvent(directory, { type: 'message.part.updated', properties: { part } });
    };

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : '';
        if (!text) return;
        let part = turn.textPart;
        if (!part) {
          part = { ...buildTextPart(''), ...{ text: '' } };
          turn.textPart = part;
        }
        part.text += text;
        emitPart(part);
        return;
      }
      case 'agent_thought_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : '';
        if (!text) return;
        let part = turn.reasoningPart;
        if (!part) {
          part = { ...buildReasoningPart(''), ...{ text: '' } };
          turn.reasoningPart = part;
        }
        part.text += text;
        emitPart(part);
        return;
      }
      case 'tool_call': {
        const id = update.toolCallId || createSortableId('tool', crypto);
        const part = {
          id: `tool_${id}`,
          type: 'tool',
          tool: update.kind || 'other',
          callID: id,
          state: {
            status: mapToolStatus(update.status),
            title: update.title,
            input: update.rawInput,
            metadata: update.kind ? { kind: update.kind } : undefined,
          },
        };
        turn.toolParts.set(id, part);
        emitPart(part);
        return;
      }
      case 'tool_call_update': {
        const id = update.toolCallId;
        const part = turn.toolParts.get(id);
        if (!part) return;
        part.state = {
          ...part.state,
          status: mapToolStatus(update.status),
          output: update.rawOutput,
          ...(update.title ? { title: update.title } : {}),
        };
        emitPart(part);
        return;
      }
      case 'usage_update': {
        turn.usage = { size: update.size, used: update.used };
        return;
      }
      case 'available_commands_update': {
        entry.commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        return;
      }
      case 'current_mode_update': {
        entry.currentMode = update.currentModeId ?? null;
        return;
      }
      default:
        return;
    }
  };

  const mapToolStatus = (status) => {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'failed':
        return 'error';
      case 'in_progress':
      case 'pending':
        return 'running';
      default:
        return status ?? 'running';
    }
  };

  // --- permission round-trip ---------------------------------------------
  const handlePermissionRequest = (requestId, acpSessionId, directory, params) => {
    const turn = activeTurns.get(acpSessionId);
    const sessionId = turn?.entry?.session?.id ?? null;
    const options = Array.isArray(params?.options) ? params.options : [];
    pendingPermissions.set(requestId, {
      sessionId,
      acpSessionId,
      directory,
      options,
      toolCall: params?.toolCall,
    });
    emitEvent(directory, {
      type: 'permission.asked',
      properties: {
        id: requestId,
        sessionID: sessionId,
        // Flat OpenCode-shaped contract (see ui/src/types/permission.ts):
        // `permission` is a STRING, not the ACP object.
        permission: params?.toolCall?.kind ?? 'tool',
        patterns: params?.toolCall?.title ? [params.toolCall.title] : [],
        metadata: {
          toolCall: params?.toolCall,
          options: options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
        },
        always: [],
        ...(params?.toolCall?.toolCallId
          ? { tool: { messageID: '', callID: params.toolCall.toolCallId } }
          : {}),
      },
    });
  };

  // --- turn execution -----------------------------------------------------
  const ensureAcpSession = async (entry) => {
    const directory = entry.session.directory;
    if (!directory) {
      throw new Error('Session has no directory; cannot start ACP session');
    }
    if (entry.acpSessionId) {
      if (appServer.hasSession?.({ directory, sessionId: entry.acpSessionId })) {
        return entry.acpSessionId;
      }
      // The process restarted (crash) or the session is otherwise unknown to the
      // live process — ACP `session/resume` re-materializes it.
      try {
        const resumed = await appServer.resumeSession({ directory, sessionId: entry.acpSessionId });
        if (resumed?.sessionId) return resumed.sessionId;
      } catch {
        // fall through to a fresh session
      }
    }
    const created = await appServer.newSession({ directory });
    entry.acpSessionId = created.sessionId;
    await sessionBindings
      .upsertBinding({
        sessionId: entry.session.id,
        backendId: BACKEND_ID,
        backendSessionId: created.sessionId,
        directory,
      })
      .catch(() => {});
    await persistEntry(entry);
    return entry.acpSessionId;
  };

  const executeTurn = async ({ entry, userRecord, input, contentBlocks }) => {
    const sessionId = entry.session.id;
    const directory = entry.session.directory;
    const model = normalizeModel(input.model);

    // Reserve the turn SYNCHRONOUSLY, before any await: otherwise two same-tick sends both
    // pass the check, and the loser's finally clears the winner's controller/turn.
    if (runControllers.has(sessionId)) {
      throw new Error('Session already has a running turn');
    }
    const controller = new AbortController();
    runControllers.set(sessionId, controller);

    let acpSessionId = null;
    let turn = null;
    try {
      // Reflect the user message immediately.
      entry.records.push(userRecord);
      entry.session = {
        ...entry.session,
        time: { ...entry.session.time, updated: Date.now() },
      };
      if (userRecord.parts.some((p) => p.type === 'text') && entry.session.title === 'New session') {
        const firstText = userRecord.parts.find((p) => p.type === 'text')?.text ?? '';
        if (firstText.trim()) entry.session.title = firstText.trim().slice(0, 80);
      }
      await persistEntry(entry);
      emitRecordEvents(directory, userRecord);
      emitSessionUpdate('session.updated', entry.session);

      const assistantRecord = buildMessageRecord({
        sessionId,
        role: 'assistant',
        parentMessageId: userRecord.info.id,
        model,
      });
      entry.records.push(assistantRecord);

      setBusyStatus(sessionId, directory, { type: 'busy' });
      turn = {
        entry,
        assistantRecord,
        textPart: null,
        reasoningPart: null,
        toolParts: new Map(),
        usage: null,
      };

      acpSessionId = await ensureAcpSession(entry);
      activeTurns.set(acpSessionId, turn);

      if (model) {
        // Pass the caller's original model value: a string option id (e.g. `["p","m"]`) must
        // reach dsh verbatim, and normalizeModel() would otherwise wrap it as a model name.
        await applyModel(entry, acpSessionId, input.model ?? model).catch(() => {});
      }
      const result = await appServer.prompt({
        directory,
        sessionId: acpSessionId,
        contentBlocks,
        signal: controller.signal,
      });
      finalizeAssistant(entry, assistantRecord, {
        completed: true,
        stopReason: result?.stopReason,
      });
      await persistEntry(entry);
      return { ok: true, record: assistantRecord };
    } catch (error) {
      if (turn) {
        finalizeAssistant(entry, turn.assistantRecord, { completed: false, error });
        await persistEntry(entry).catch(() => {});
      }
      emitSessionError(directory, sessionId, error);
      throw error;
    } finally {
      // Only release state this turn still owns.
      if (acpSessionId && activeTurns.get(acpSessionId) === turn) activeTurns.delete(acpSessionId);
      if (runControllers.get(sessionId) === controller) {
        runControllers.delete(sessionId);
        // Drop any permission prompts the turn never answered.
        for (const [requestId, pending] of pendingPermissions) {
          if (acpSessionId && pending.acpSessionId === acpSessionId) pendingPermissions.delete(requestId);
        }
        setBusyStatus(sessionId, directory, { type: 'idle' });
      }
    }
  };

  const finalizeAssistant = (entry, record, { completed, stopReason, error }) => {
    // ACP emits no synthetic "final" part; parts already live on the record.
    record.info.time = {
      created: record.info.time.created,
      completed: Date.now(),
      ...(stopReason ? { stopReason } : {}),
    };
    if (error) record.info.error = { message: error?.message ?? 'turn failed' };
    if (completed) {
      entry.session = { ...entry.session, time: { ...entry.session.time, updated: Date.now() } };
    }
    emitRecordEvents(entry.session.directory, record);
    return record;
  };

  const emitSessionError = (directory, sessionId, error) => {
    emitEvent(directory, {
      type: 'session.error',
      properties: {
        sessionID: sessionId,
        error: { message: error instanceof Error ? error.message : 'deepseek run failed' },
      },
    });
  };

  // dsh wants the config option's exact value — the JSON-encoded [provider, model] pair — not a
  // bare model name (`ds` is rejected with "unknown model option"). Resolve against the live
  // option list; accept already-encoded values, {providerID,modelID}, or `provider/model`.
  const resolveModelValue = (entry, acpSessionId, model) => {
    if (!model) return null;
    if (typeof model === 'string' && model.startsWith('[')) return model; // already an option value
    let providerID;
    let modelID;
    if (typeof model === 'string') {
      const segs = model.split('/').filter(Boolean);
      modelID = segs[segs.length - 1] || model;
      providerID = segs.length > 1 ? segs[segs.length - 2] : MODEL_PROVIDER_ID;
    } else {
      providerID = model.providerID || model.provider || MODEL_PROVIDER_ID;
      modelID = model.modelID || model.id;
    }
    if (!modelID) return null;
    if (entry?.acpSessionId && entry.session.directory) {
      const state = appServer.getSessionConfig?.({ directory: entry.session.directory, sessionId: acpSessionId });
      const opts = state?.configOptions?.find((c) => c.id === 'model')?.options ?? [];
      const flat = flattenModelOptions(opts);
      const match = flat.find((o) => o.id === modelOptionValue(providerID, modelID))
        || flat.find((o) => o.label === modelID)
        || flat.find((o) => o.id === modelID);
      if (match) return match.id;
      // A stale model from another backend (e.g. moonshot/kimi) is unknown to dsh; keep the
      // session pinned to a model this provider actually serves rather than erroring.
      if (flat.length > 0) {
        console.warn(`[deepseek-backend] model ${providerID}/${modelID} not offered; using ${flat[0].label}`);
        return flat[0].id;
      }
    }
    return modelOptionValue(providerID, modelID);
  };

  const applyModel = async (entry, acpSessionId, model) => {
    const value = resolveModelValue(entry, acpSessionId, model);
    if (!value || !entry.session.directory) return;
    try {
      await appServer.setConfigOption({
        directory: entry.session.directory,
        sessionId: acpSessionId,
        configId: 'model',
        value,
      });
    } catch (err) {
      console.warn(`[deepseek-backend] set model failed: ${err?.message}`);
    }
  };

  const normalizeModel = (model) => {
    if (!model) return null;
    if (typeof model === 'string') return { providerID: BACKEND_ID, modelID: model };
    if (typeof model === 'object' && typeof model.modelID === 'string') {
      return { providerID: model.providerID ?? BACKEND_ID, modelID: model.modelID };
    }
    return null;
  };

  // --- public runtime surface --------------------------------------------
  const listSessions = async (input = {}) => {
    await ensureLoaded();
    const directory = normalizeDirectory(input.directory);
    const list = [...sessions.values()]
      .filter((entry) => !entry.session.parentID)
      .filter((entry) => !directory || entry.session.directory === directory)
      .map((entry) => entry.session)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    return list;
  };

  const getSession = async (input = {}) => {
    await ensureLoaded();
    // Look up by id ONLY. A directory fallback would let the route layer's
    // repairNonOpenCodeBinding() re-bind an unrelated session (and another backend's
    // session in the same directory) to this backend.
    const entry = await getEntry(input.sessionID);
    return entry?.session ?? null;
  };

  const getMessages = async (input = {}) => {
    await ensureLoaded();
    const entry = await getEntry(input.sessionID);
    if (!entry) return [];
    return entry.records.map(cloneRecord);
  };

  const createSession = async (input = {}) => {
    await ensureLoaded();
    const entry = await buildSession(input);
    await persistEntry(entry);
    emitSessionUpdate('session.created', entry.session);
    return entry.session;
  };

  const deleteSession = async (input = {}) => {
    await ensureLoaded();
    const sessionId = input.sessionID;
    const entry = await getEntry(sessionId);
    if (!entry) return false;
    sessions.delete(sessionId);
    // Best-effort close of the ACP session; ACP has no delete.
    if (entry.acpSessionId && entry.session.directory) {
      await appServer
        .closeSession({ directory: entry.session.directory, sessionId: entry.acpSessionId })
        .catch(() => {});
    }
    await sessionBindings.removeBinding(sessionId).catch(() => {});
    await persist();
    emitSessionUpdate('session.deleted', entry.session);
    return true;
  };

  const updateSession = async (input = {}) => {
    await ensureLoaded();
    const sessionId = input.sessionID;
    const entry = await getEntry(sessionId);
    if (!entry) throw new Error('Session not found');
    if (typeof input.title === 'string' && input.title.trim()) {
      entry.session = { ...entry.session, title: input.title.trim(), time: { ...entry.session.time, updated: Date.now() } };
    }
    await persistEntry(entry);
    emitSessionUpdate('session.updated', entry.session);
    return entry.session;
  };

  const buildContentBlocks = (parts) => partsToAcpContentBlocks(parts);

  const startTurn = (input, awaitCompletion) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID : '';
    if (!sessionId) {
      return Promise.reject(new Error('Session ID is required'));
    }
    // Admit ONE turn per session synchronously, before any await, so two same-tick sends
    // (double-click, two tabs, stop-then-resend) cannot both start.
    if (turnLocks.has(sessionId)) {
      const err = new Error('Session already has a running turn');
      err.code = 'SESSION_BUSY';
      return Promise.reject(err);
    }
    turnLocks.add(sessionId);

    const run = (async () => {
      try {
        await ensureLoaded();
        const entry = await getEntry(sessionId);
        if (!entry) throw new Error('Session not found');

        const contentBlocks = buildContentBlocks(input.parts ?? []);
        if (contentBlocks.length === 0) {
          const lastText = (input.parts ?? []).find((p) => p?.type === 'text')?.text;
          if (lastText && lastText.trim()) contentBlocks.push({ type: 'text', text: lastText });
        }

        const model = normalizeModel(input.model);
        const userRecord = buildMessageRecord({
          sessionId,
          role: 'user',
          model,
          parts: (input.parts ?? []).map((part) => {
            if (part?.type === 'file') {
              return {
                id: createSortableId('prt', crypto),
                type: 'file',
                mime: part.mime ?? 'application/octet-stream',
                filename: part.filename ?? 'attachment',
                url: part.url,
              };
            }
            return {
              id: createSortableId('prt', crypto),
              type: part?.type ?? 'text',
              ...(typeof part?.text === 'string' ? { text: part.text } : {}),
            };
          }),
        });
        if (typeof input.messageID === 'string' && input.messageID.trim()) {
          userRecord.info.id = input.messageID.trim();
        }

        return await executeTurn({ entry, userRecord, input, contentBlocks });
      } finally {
        turnLocks.delete(sessionId);
      }
    })();

    if (awaitCompletion) return run;
    run.catch(() => {});
    return Promise.resolve({ ok: true });
  };

  const prompt = async (input = {}) => {
    await startTurn(input, true);
    return { ok: true };
  };

  const promptAsync = (input = {}) => startTurn(input, false);

  const abortSession = async (input = {}) => {
    const sessionId = typeof input.sessionID === 'string' ? input.sessionID : '';
    const controller = runControllers.get(sessionId);
    const entry = await getEntry(sessionId);
    if (controller) {
      // Abort only: the turn's own finally releases runControllers/activeTurns. Deleting the
      // controller here would let a new turn start while the old one is still unwinding.
      controller.abort();
      if (entry?.acpSessionId && entry.session.directory) {
        await appServer.cancel({ directory: entry.session.directory, sessionId: entry.acpSessionId }).catch(() => {});
      }
      return { ok: true };
    }
    setBusyStatus(sessionId, entry?.session.directory, { type: 'idle' });
    return { ok: true };
  };

  const listPendingPermissions = (sessionId) =>
    [...pendingPermissions.entries()]
      .filter(([, v]) => !sessionId || v.sessionId === sessionId)
      .map(([id, v]) => ({ id, sessionID: v.sessionId, permission: { id, options: v.options } }));

  // Accepts BOTH conventions:
  //   object style  : replyToPermission({ requestId, optionId|reply, ... })   [author's suite]
  //   route  style  : replyToPermission(requestId, reply, { directory, sessionID })  [openchamber-routes.js]
  const replyToPermission = async (input = {}, replyArg, _context = {}) => {
    const positional = typeof input === 'string' || typeof input === 'number';
    const requestId = positional ? input : input.requestId ?? input.permissionId;
    const reply = positional ? replyArg : input.reply ?? input.response;
    const pending = pendingPermissions.get(requestId);
    if (!pending) return { ok: false };
    const optionId = pickPermissionOption(pending.options, reply);
    const delivered = appServer.resolvePermission(requestId, optionId);
    if (delivered) pendingPermissions.delete(requestId);
    emitEvent(pending.directory, {
      type: 'permission.replied',
      properties: { sessionID: pending.sessionId, requestID: requestId, reply, optionId },
    });
    return { ok: delivered };
  };

  const pickPermissionOption = (options = [], reply) => {
    if (!reply || reply === 'reject' || reply === 'deny') return null;
    // Direct optionId match first.
    const direct = options.find((o) => o.optionId === reply);
    if (direct) return direct.optionId;
    // Match by kind (allow_once / allow_always).
    const byKind = options.find((o) => o.kind === reply || o.kind === `allow_${reply}`);
    if (byKind) return byKind.optionId;
    // Fall back to the first allow option.
    const allow = options.find((o) => String(o.kind ?? '').startsWith('allow'));
    return allow ? allow.optionId : options[0]?.optionId ?? null;
  };

  const hasPermissionRequest = (requestId) => pendingPermissions.has(requestId);

  const getControlSurface = async (input = {}) => {
    await ensureLoaded();
    const entry = await getEntry(input.sessionID);
    const directory = entry?.session.directory ?? normalizeDirectory(input.directory);

    let modelOptions = [];
    let defaultOptionId = null;
    if (entry?.acpSessionId && directory) {
      const state = appServer.getSessionConfig?.({ directory, sessionId: entry.acpSessionId });
      const modelConfig = state?.configOptions?.find((c) => c.id === 'model');
      if (modelConfig?.options) {
        modelOptions = flattenModelOptions(modelConfig.options);
        defaultOptionId = modelConfig.currentValue ?? null;
      }
    }
    // Before a session exists (new-chat screen) dsh has no config to read: advertise the
    // pinned models so the picker is never empty.
    if (modelOptions.length === 0) {
      modelOptions = SNAPSHOT_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
      }));
      defaultOptionId = (SNAPSHOT_MODELS.find((m) => m.default) ?? SNAPSHOT_MODELS[0])?.id ?? null;
    }

    return {
      backendId: BACKEND_ID,
      providerSnapshot: PROVIDER_SNAPSHOT,
      modelSelector: {
        label: 'Model',
        source: 'backend',
        providerId: MODEL_PROVIDER_ID,
        options: modelOptions,
        defaultOptionId,
      },
      capabilities: CAPABILITIES,
    };
  };

  const flattenModelOptions = (options) => {
    const flat = [];
    for (const opt of options) {
      if (Array.isArray(opt.options)) {
        for (const child of opt.options) {
          flat.push({ id: child.value, label: child.name, description: opt.name });
        }
      } else if (opt.value) {
        flat.push({ id: opt.value, label: opt.name });
      }
    }
    return flat;
  };

  const getStatusSnapshot = async () => ({
    backendId: BACKEND_ID,
    busySessions: [...busyStatus.entries()]
      .filter(([, v]) => v.type === 'busy')
      .map(([id]) => id),
  });

  const addEventClient = (res, directory) => {
    const client = { res, directory: normalizeDirectory(directory) };
    eventClients.add(client);
    res.on('close', () => eventClients.delete(client));
    return () => eventClients.delete(client);
  };

  return {
    backendId: BACKEND_ID,
    capabilities: CAPABILITIES,
    providerSnapshot: PROVIDER_SNAPSHOT,
    isAvailable: () => appServer.isAvailable(),
    resolveBinary: () => appServer.resolveBinary(),

    listSessions,
    getSession,
    getMessages,
    createSession,
    deleteSession,
    updateSession,
    prompt,
    promptAsync,
    abortSession,
    getControlSurface,
    getStatusSnapshot,
    addEventClient,
    listPendingPermissions,
    hasPermissionRequest,
    replyToPermission,

    // Terminate every managed dsh process (mirrors codex-backend's shutdownAll).
    shutdownAll: () => appServer.shutdown(),

    // Unsupported by ACP; present so routes can feature-detect.
    forkSession: async (input = {}) => {
      // Simple fork: new openchamber session in the same directory (no thread forking in ACP).
      const entry = await getEntry(input.sessionID);
      if (!entry) throw new Error('Session not found');
      return createSession({ directory: entry.session.directory, title: `${entry.session.title} (fork)` });
    },
    shareSession: async () => ({ ok: false, reason: 'acp-has-no-share' }),
    unshareSession: async () => ({ ok: false, reason: 'acp-has-no-share' }),

    /** Exposed for diagnostics/tests. */
    _emitEvent: emitEvent,
    _appServer: appServer,
  };
};
