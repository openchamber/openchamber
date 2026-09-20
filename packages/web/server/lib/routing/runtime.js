/**
 * Owns Jev routing at runtime: whether Auto is ready, rewriting a prompt body
 * that names the `openchamber/auto` model, and the safety net consulted before
 * a permission is auto-accepted. Every failure path keeps the user's own
 * behaviour: a prompt goes to the fallback model, a permission is accepted as
 * auto-accept would have, and the UI is told why.
 */
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { z } from 'zod';
import { isRoutingFeatureAvailable } from './feature-flag.js';
import { BUILTIN_CATEGORIES, isAutoModel } from './defaults.js';
import { createRoutingStore, parseEffectiveConfig } from './store.js';
import { buildPermissionRequest, buildRoutingRequest, createJevClient, decidePermission, decideRouting } from './jev.js';
import { loadRoutingHistory } from './history.js';

const HISTORY_TIMEOUT_MS = 2500;
/** A held permission is remembered so reconnect reconciliation does not re-ask Jev. */
const PERMISSION_DECISION_TTL_MS = 15 * 60 * 1000;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const textPartSchema = z.object({ type: z.literal('text'), text: z.string(), synthetic: z.boolean().optional() });
const commandBodySchema = z.object({ command: z.string(), arguments: z.string().optional() });
const promptBodySchema = z.object({ parts: z.array(z.unknown()).optional() });

/** The user's words for this send: text parts the composer authored, or the slash command. */
export const requestTextOf = (body) => {
  const command = commandBodySchema.safeParse(body);
  if (command.success) {
    const args = command.data.arguments?.trim();
    return `/${command.data.command}${args ? ` ${args}` : ''}`;
  }
  const prompt = promptBodySchema.safeParse(body);
  const parts = prompt.success ? prompt.data.parts ?? [] : [];
  return parts
    .map((part) => textPartSchema.safeParse(part))
    .filter((part) => part.success && !part.data.synthetic)
    .map((part) => part.data.text)
    .join('\n\n')
    .trim();
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
    const available = isRoutingFeatureAvailable();
    if (!available) return { available: false, autoReady: false, tokenPresent: false, config: null, builtins: [] };
    const [config, token] = await Promise.all([store.readConfig(), store.readToken()]);
    const tokenPresent = Boolean(token);
    const autoReady = config.enabled && tokenPresent && Boolean(config.fallback) && enabledCategories(config).length >= 2;
    // Built-in text travels with the config so "Reset" in Settings restores the shipped wording.
    return { available, autoReady, tokenPresent, config, builtins: BUILTIN_CATEGORIES };
  };

  const publishUpdated = async () => {
    const state = await describe();
    broadcast('openchamber:routing.updated', { available: state.available, autoReady: state.autoReady, tokenPresent: state.tokenPresent });
    return state;
  };

  const readHistory = async ({ sessionId, directory }) => {
    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const client = createOpencodeClient({ baseUrl, headers: getOpenCodeAuthHeaders(), throwOnError: true });
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS);
    return loadRoutingHistory({
      signal,
      readPage: (page) => client.session.messages({ sessionID: sessionId, directory, ...page }, { signal }),
    });
  };

  // A category without a model of its own means "the fallback pair"; a variant
  // only travels with the model it was chosen for.
  const applyChoice = (body, config, choice) => {
    const own = Boolean(choice?.model);
    const model = own ? choice.model : config.fallback.model;
    const variant = own ? choice.variant : config.fallback.variant;
    // Keep the wire shape the route uses: a string on /command, an object on the prompt routes.
    body.model = z.string().safeParse(body.model).success
      ? `${model.providerID}/${model.modelID}`
      : { providerID: model.providerID, modelID: model.modelID };
    if (variant) body.variant = variant;
    else delete body.variant;
    if (choice?.agent) body.agent = choice.agent;
    return { providerID: model.providerID, modelID: model.modelID, variant: variant ?? null, agent: choice?.agent ?? null };
  };

  /**
   * Rewrites `body.model` in place when it is the Auto sentinel. Returns the
   * decision that was applied, or null when the body named a real model.
   * Throws only when Auto cannot be honoured at all (no fallback configured):
   * the sentinel must never reach OpenCode.
   */
  const resolvePromptBody = async (body, { sessionId, directory }) => {
    if (!isAutoModel(body?.model)) return null;
    const state = await describe();
    const config = state.config;
    if (!config?.fallback) {
      throw Object.assign(new Error('Auto routing is selected but no fallback model is configured'), { status: 400 });
    }
    const decision = { sessionId, at: now(), category: null, confidence: 0, reason: 'not-ready', ms: 0 };
    if (state.autoReady) {
      const request = requestTextOf(body);
      let history = [];
      try {
        history = await readHistory({ sessionId, directory });
      } catch (error) {
        console.warn('[routing] history unavailable, routing on the request alone:', errorMessage(error));
      }
      try {
        const token = await store.readToken();
        const { answers, ms } = await jev.ask(buildRoutingRequest({ categories: enabledCategories(config), history, request }), token);
        const result = decideRouting(answers.category, { categories: enabledCategories(config), minConfidence: config.minConfidence });
        decision.category = result.category?.id ?? null;
        decision.confidence = result.confidence;
        decision.reason = result.reason;
        decision.ms = ms;
        Object.assign(decision, applyChoice(body, config, result.category));
      } catch (error) {
        decision.reason = 'error';
        decision.error = errorMessage(error);
        Object.assign(decision, applyChoice(body, config, null));
      }
    } else {
      Object.assign(decision, applyChoice(body, config, null));
    }
    broadcast('openchamber:routing.decision', decision);
    return decision;
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
    if (!state.available || !state.config?.enabled || !state.config.safetyNet.enabled || !state.tokenPresent) return { action: 'accept' };
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

  return { describe, resolvePromptBody, evaluatePermission, forgetPermission, heldPermissions, updateConfig, setToken, clearToken };
}
