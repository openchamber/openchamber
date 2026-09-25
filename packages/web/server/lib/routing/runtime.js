/**
 * Owns Jev routing at runtime: whether Auto is ready, which model and agent a
 * send that selected `openchamber/auto` runs on, and the safety net consulted
 * before a permission is auto-accepted. Every failure path keeps the user's own
 * behaviour: a prompt goes to the fallback model, a permission is accepted as
 * auto-accept would have, and the UI is told why.
 *
 * OpenCode 2.x holds the model and the agent on the session, switched by their
 * own calls, and a prompt body carries only the user's text. So Auto is a
 * per-session state here: the sentinel arrives on `POST /session/:id/model`
 * and is swallowed, and every prompt in that session is routed until a real
 * model is selected.
 */
import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { AUTO_MODEL_REF, BUILTIN_CATEGORIES, isAutoModel } from './defaults.js';
import { createRoutingStore, parseEffectiveConfig } from './store.js';
import { buildPermissionRequest, buildRoutingRequest, createJevClient, decidePermission, decideRouting, jevEndpoint } from './jev.js';
import { loadRoutingHistory } from './history.js';

const HISTORY_TIMEOUT_MS = 2500;
/** A held permission is remembered so reconnect reconciliation does not re-ask Jev. */
const PERMISSION_DECISION_TTL_MS = 15 * 60 * 1000;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

// v2's command body (`session.command` in the protocol) names the command in
// `name` and carries its arguments in `text`; a prompt body has no `name`.
const commandBodySchema = z.object({ name: z.string().trim().min(1), text: z.string().nullish() });
// v2 sends one user turn as flat text; the context the composer attached went
// ahead of it as synthetic messages, which are never the request being routed.
const promptBodySchema = z.object({ text: z.string().nullish() });

/** The user's words for this send: the prompt text, or the slash command. */
export const requestTextOf = (body) => {
  const command = commandBodySchema.safeParse(body);
  if (command.success) {
    const args = command.data.text?.trim();
    return `/${command.data.name}${args ? ` ${args}` : ''}`;
  }
  const prompt = promptBodySchema.safeParse(body);
  return (prompt.success ? prompt.data.text ?? '' : '').trim();
};

const agentBodySchema = z.object({ agent: z.string().trim().min(1) });

/** OpenChamber stores a model as `{ providerID, modelID }`; v2 wants a `Model.Ref`. */
const toModelRef = (model, variant) => {
  const ref = { providerID: model.providerID, id: model.modelID };
  if (variant) ref.variant = variant;
  return ref;
};

export function createRoutingRuntime({
  dataDir,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent,
  fetchImpl = fetch,
  store = createRoutingStore({ dataDir }),
  jev = createJevClient({ fetchImpl }),
  now = Date.now,
}) {
  const permissionDecisions = new Map();
  // Sessions the user put on Auto. The sentinel never reaches OpenCode, so
  // nothing upstream remembers the choice for us.
  // TODO(v2): this is process memory. A server restart drops the mark and the
  // session silently runs on whatever model it was last switched to while the
  // composer still shows Auto. Either persist it next to `routing.json` or have
  // the client resend the sentinel with every send.
  const autoSessions = new Map();
  const AUTO_SESSION_LIMIT = 1000;

  const broadcast = (type, properties) => {
    try {
      broadcastGlobalUiEvent?.({ type, properties });
    } catch (error) {
      console.warn(`[routing] failed to broadcast ${type}:`, errorMessage(error));
    }
  };

  const enabledCategories = (config) => config.categories.filter((category) => category.enabled);

  /** What the client needs to decide whether to offer Auto and what the settings page shows. */
  const describe = async () => {
    const [config, token] = await Promise.all([store.readConfig(), store.readToken()]);
    const tokenPresent = Boolean(token);
    // A key is not a precondition: without one Jev answers through the free
    // model zen serves, so Auto only needs a fallback and two categories.
    const autoReady = config.enabled && Boolean(config.fallback) && enabledCategories(config).length >= 2;
    // Built-in text travels with the config so "Reset" in Settings restores the shipped wording.
    // `available` stays in the payload for the client: a runtime without an
    // OpenChamber server (VS Code) answers 404 and reads it as false.
    return { available: true, autoReady, tokenPresent, jevSource: jevEndpoint(token).source, config, builtins: BUILTIN_CATEGORIES };
  };

  const publishUpdated = async () => {
    const state = await describe();
    broadcast('openchamber:routing.updated', {
      available: state.available, autoReady: state.autoReady, tokenPresent: state.tokenPresent, jevSource: state.jevSource,
    });
    return state;
  };

  const openCodeClient = (directory) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    // v2 scopes by header and rejects non-ASCII header values.
    const scope = z.string().trim().min(1).safeParse(directory);
    if (scope.success) headers['x-opencode-directory'] = encodeURIComponent(scope.data);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers });
  };

  const readHistory = async ({ sessionId, directory }) => {
    const client = openCodeClient(directory);
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS);
    return loadRoutingHistory({
      signal,
      // v2 pages a session's messages newest first and returns `{ data, cursor }`.
      readPage: ({ limit, cursor }) => client.message.list(
        { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
        { signal },
      ),
    });
  };

  // A category without a model of its own means "the fallback pair"; a variant
  // only travels with the model it was chosen for.
  const chooseSelection = (config, choice, composerAgent) => {
    const own = Boolean(choice?.model);
    const model = own ? choice.model : config.fallback.model;
    const variant = own ? choice.variant : config.fallback.variant;
    return {
      model: toModelRef(model, variant),
      // A category agent replaces the composer's; an empty one keeps it.
      agent: choice?.agent || composerAgent || null,
      decision: { providerID: model.providerID, modelID: model.modelID, variant: variant ?? null, agent: choice?.agent ?? null },
    };
  };

  /**
   * Resolves one send that named the Auto sentinel. Returns the model and
   * agent the send must use, or null when a real model was selected.
   *
   * v2 carries neither model nor agent in a prompt body — they are session
   * state, switched by their own calls — so the caller applies the selection
   * (`applySessionSelection`, or its own switch calls) instead of the runtime
   * rewriting a body in place the way v1 allowed.
   *
   * Throws only when Auto cannot be honoured at all (no fallback configured):
   * the sentinel must never reach OpenCode.
   */
  const resolveAutoSelection = async ({ sessionId, directory, model, agent, requestText }) => {
    if (!isAutoModel(model)) return null;
    const state = await describe();
    const config = state.config;
    if (!config?.fallback) {
      throw Object.assign(new Error('Auto routing is selected but no fallback model is configured'), { status: 400 });
    }
    const decision = { sessionId, at: now(), category: null, confidence: 0, reason: 'not-ready', ms: 0 };
    let selection;
    if (state.autoReady) {
      let history = [];
      try {
        history = await readHistory({ sessionId, directory });
      } catch (error) {
        console.warn('[routing] history unavailable, routing on the request alone:', errorMessage(error));
      }
      try {
        const token = await store.readToken();
        const request = (requestText ?? '').trim();
        const { answers, ms } = await jev.ask(buildRoutingRequest({ categories: enabledCategories(config), history, request }), token);
        const result = decideRouting(answers.category, { categories: enabledCategories(config), minConfidence: config.minConfidence });
        decision.category = result.category?.id ?? null;
        decision.confidence = result.confidence;
        decision.reason = result.reason;
        decision.ms = ms;
        selection = chooseSelection(config, result.category, agent);
      } catch (error) {
        decision.reason = 'error';
        decision.error = errorMessage(error);
        selection = chooseSelection(config, null, agent);
      }
    } else {
      selection = chooseSelection(config, null, agent);
    }
    Object.assign(decision, selection.decision);
    broadcast('openchamber:routing.decision', decision);
    return { model: selection.model, agent: selection.agent, decision };
  };

  /**
   * `POST /session/:id/model` with the sentinel puts the session on Auto;
   * with any real model it takes it off again.
   */
  const noteModelSelection = (sessionId, model, directory) => {
    if (!sessionId) return false;
    if (!isAutoModel(model)) {
      autoSessions.delete(sessionId);
      return false;
    }
    autoSessions.delete(sessionId);
    autoSessions.set(sessionId, { directory: directory ?? null, at: now() });
    while (autoSessions.size > AUTO_SESSION_LIMIT) autoSessions.delete(autoSessions.keys().next().value);
    return true;
  };

  const isAutoSession = (sessionId) => Boolean(sessionId) && autoSessions.has(sessionId);

  /** Switches the session onto a resolved selection, the way a v2 send does. */
  const applySessionSelection = async (sessionId, directory, selection) => {
    const client = openCodeClient(directory);
    await client.session.switchModel({ sessionID: sessionId, model: selection.model });
    if (selection.agent) await client.session.switchAgent({ sessionID: sessionId, agent: selection.agent });
  };

  /**
   * One send in a routed session: asks Jev on the request text, switches the
   * session onto the answer, and keeps the body in step with it.
   */
  const routeSend = async ({ sessionId, directory, body }) => {
    const resolved = await resolveAutoSelection({
      sessionId,
      directory,
      model: AUTO_MODEL_REF,
      agent: agentBodySchema.safeParse(body).data?.agent ?? null,
      requestText: requestTextOf(body),
    });
    if (!resolved) return null;
    // v2 prompt and command bodies carry neither model nor agent: switching
    // the session is the whole application of the decision.
    await applySessionSelection(sessionId, directory, resolved);
    return resolved.decision;
  };

  /**
   * Consulted by permission auto-accept before it replies. `accept` keeps the
   * reply; `hold` leaves the request for the user; `skipped` is `accept` with
   * a reason the UI surfaces (Jev unreachable, bad key).
   */
  const evaluatePermission = async (permission, directory) => {
    if (!permission?.id) return { action: 'accept' };
    const cached = permissionDecisions.get(permission.id);
    if (cached && now() - cached.at < PERMISSION_DECISION_TTL_MS) return cached.result;
    const state = await describe();
    if (!state.config?.enabled || !state.config.safetyNet.enabled) return { action: 'accept' };
    let result;
    try {
      const token = await store.readToken();
      const { answers } = await jev.ask(buildPermissionRequest(permission), token);
      const verdict = decidePermission(answers, { threshold: state.config.safetyNet.threshold });
      result = verdict.hold
        ? { action: 'hold', score: verdict.score, kind: verdict.kind }
        : { action: 'accept', score: verdict.score, kind: verdict.kind };
      if (verdict.hold) {
        broadcast('openchamber:routing.permission-held', {
          permissionId: permission.id, sessionId: permission.sessionID, directory: directory ?? null, score: verdict.score, kind: verdict.kind,
        });
      }
    } catch (error) {
      result = { action: 'accept', skipped: errorMessage(error) };
      broadcast('openchamber:routing.safety-skipped', {
        permissionId: permission.id, sessionId: permission.sessionID, directory: directory ?? null, error: result.skipped,
      });
    }
    permissionDecisions.set(permission.id, { at: now(), result });
    return result;
  };

  const forgetPermission = (permissionId) => {
    permissionDecisions.delete(permissionId);
  };

  const updateConfig = async (input) => {
    const config = parseEffectiveConfig(input);
    await store.writeConfig(config);
    return publishUpdated();
  };

  const setToken = async (token) => {
    const parsed = z.string().trim().min(1).max(4000).safeParse(token);
    if (!parsed.success) throw Object.assign(new Error('A Jev API key is required'), { status: 400 });
    await store.writeToken(parsed.data);
    return publishUpdated();
  };

  const clearToken = async () => {
    await store.clearToken();
    return publishUpdated();
  };

  /** Held permissions the UI can read back after a reload. */
  const heldPermissions = () => {
    const held = [];
    for (const [permissionId, entry] of permissionDecisions) {
      if (entry.result.action === 'hold') held.push({ permissionId, score: entry.result.score, kind: entry.result.kind });
    }
    return held;
  };

  return {
    describe,
    noteModelSelection,
    isAutoSession,
    resolveAutoSelection,
    applySessionSelection,
    routeSend,
    evaluatePermission,
    forgetPermission,
    heldPermissions,
    updateConfig,
    setToken,
    clearToken,
  };
}
