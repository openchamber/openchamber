import { OpenCode } from '@opencode/client';
import { z } from 'zod';
import { AUTO_MODEL_REF, BUILTIN_CATEGORIES, ZEN_JEV_PROMOTION_ACTIVE, isAutoModel } from './defaults.js';
import { createRoutingStore, parseEffectiveConfig } from './store.js';
import { buildPermissionRequest, buildProbeRequest, buildRoutingRequest, createJevClient, decidePermission, decideRouting, isProbeAnswer } from './jev.js';
import {
  CLASSIFIER_SOURCES,
  classifierEndpoint,
  legacyClassifier,
  parseCustomEndpointUrl,
  readPinnedCustomEndpoint,
  resolveClassifier,
} from './classifier.js';
import { loadRoutingHistory } from './history.js';
import { PROMPT_CACHE_TTL_MS, cacheHoldCategory, warmWindowMs } from './cache.js';
import { readOpenCodeCredentials } from '../opencode/auth.js';
import { waitForLocationPlugins } from '../opencode/location-plugins.js';
import { ENTERPRISE_MODE_ERROR, isEnterpriseMode } from '../enterprise-mode.js';
import { isRecord } from '../shared/object-guards.js';
import type { LegacyAuthFile } from '../opencode/auth.js';
import type { CustomEndpoint, RoutingCategory, RoutingConfig, RoutingModel } from './store.js';
import type { HistoryEntry } from './history.js';
import type { RoutingPermission } from './jev.js';
import type { JsonValue } from '../shared/json-values.js';
import type { AutoSelectionInput, CacheHoldInput, CustomEndpointInput, PermissionVerdict, PublicCustomEndpoint, RoutingAttempt, RoutingBody, RoutingBroadcastProperties, RoutingModelRef, RoutingRuntimeOptions, Selection, SessionScope } from './contracts.js';

const HISTORY_TIMEOUT_MS = 2500;
const PERMISSION_DECISION_TTL_MS = 15 * 60 * 1000;

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const hasTimeoutCode = (cause: unknown): cause is { code: 'timeout' } => cause !== null
  && (typeof cause === 'object' || typeof cause === 'function') && 'code' in cause && cause.code === 'timeout';
const hasHttpStatus = (cause: unknown): cause is { status: number } => cause !== null
  && (typeof cause === 'object' || typeof cause === 'function') && 'status' in cause && typeof cause.status === 'number';

const commandBodySchema = z.object({ name: z.string().trim().min(1), text: z.string().nullish() });
const promptBodySchema = z.object({ text: z.string().nullish() });
const formReplyBodySchema = z.object({ answer: z.record(z.string(), z.unknown()) });

export const requestTextOf = (body: RoutingBody) => {
  const formReply = formReplyBodySchema.safeParse(body);
  if (formReply.success) return Object.values(formReply.data.answer).flat().join('\n').trim();
  const command = commandBodySchema.safeParse(body);
  if (command.success) {
    const args = command.data.text?.trim();
    return `/${command.data.name}${args ? ` ${args}` : ''}`;
  }
  const prompt = promptBodySchema.safeParse(body);
  return (prompt.success ? prompt.data.text ?? '' : '').trim();
};

const attachmentFileSchema = z.object({ uri: z.string().nullish(), name: z.string().nullish() });
const attachmentListSchema = z.array(attachmentFileSchema);
const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp']);

const isImageFile = (file: z.infer<typeof attachmentFileSchema>) => {
  const uri = file.uri ?? '';
  if (uri.startsWith('data:')) return uri.startsWith('data:image/');
  const name = (file.name ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1));
};

export const attachmentHint = (body: RoutingBody) => {
  const files = attachmentListSchema.safeParse(isRecord(body) ? body.files : undefined).data ?? [];
  const images = files.filter((file) => isImageFile(file));
  if (images.length === 0) return '';
  const names = images.map((file) => file.name).filter(Boolean).slice(0, 3);
  const count = images.length === 1 ? 'an image' : `${images.length} images`;
  return `\n\n[The user attached ${count}${names.length > 0 ? `: ${names.join(', ')}` : ''}]`;
};

export const routingRequestTextOf = (body: RoutingBody) => `${requestTextOf(body)}${attachmentHint(body)}`.trim();

const agentBodySchema = z.object({ agent: z.string().trim().min(1) });

const catalogResponseSchema = z.object({
  data: z.array(z.object({
    providerID: z.string(),
    modelID: z.string(),
    variants: z.array(z.object({ id: z.string() })).default([]),
  })),
});

const customEndpointInputSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  model: z.string().trim().min(1).max(200),
  key: z.string().trim().max(4000).nullable().optional(),
});

const toModelRef = (model: RoutingModel, variant: string | null) => {
  const ref: RoutingModelRef = { providerID: model.providerID, id: model.modelID };
  if (variant) ref.variant = variant;
  return ref;
};

const apiKeySchema = z.object({ type: z.literal('api'), key: z.string().min(1) });
const envKeySchema = z.string().trim().min(1);
const geminiKeySchema = z.string().trim().regex(/^[\x21-\x7e]{1,4000}$/);
const usableGeminiKey = (key: string | null | undefined) => geminiKeySchema.safeParse(key).data ?? null;

const PROVIDER_ENV_KEYS = {
  openrouter: ['OPENROUTER_API_KEY'],
  vercel: ['AI_GATEWAY_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
};

export const readOpenCodeKeys = async ({ readAuth = readOpenCodeCredentials, env = process.env }: { readAuth?: () => LegacyAuthFile | Promise<LegacyAuthFile>; env?: NodeJS.ProcessEnv } = {}) => {
  let auth: LegacyAuthFile = {};
  try {
    auth = await readAuth();
  } catch {
    auth = {};
  }
  const saved = (providerId: string) => apiKeySchema.safeParse(auth[providerId]).data?.key ?? null;
  const fromEnv = (providerId: keyof typeof PROVIDER_ENV_KEYS, parse: (value: string | undefined) => string | null | undefined = (value) => envKeySchema.safeParse(value).data) => PROVIDER_ENV_KEYS[providerId]
    .map((name) => parse(env[name]))
    .find(Boolean) ?? null;
  return {
    zenKey: saved('opencode'),
    openrouterKey: saved('openrouter') ?? fromEnv('openrouter'),
    vercelKey: saved('vercel') ?? fromEnv('vercel'),
    geminiKey: usableGeminiKey(saved('google')) ?? fromEnv('google', usableGeminiKey),
  };
};

export function createRoutingRuntime({
  dataDir,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent,
  fetchImpl = fetch,
  store = createRoutingStore({ dataDir }),
  jev = createJevClient({ fetchImpl }),
  readProviderKeys = () => readOpenCodeKeys(),
  zenPromotionActive = ZEN_JEV_PROMOTION_ACTIVE,
  enterpriseMode = isEnterpriseMode,
  readPinnedEndpoint = readPinnedCustomEndpoint,
  listCatalogModels = null,
  readSessionHistory = null,
  readConfigEntries = null,
  readSessionAgent = null,
  isSessionWarm = () => false,
  now = Date.now,
}: RoutingRuntimeOptions) {
  const permissionDecisions = new Map<JsonValue, { at: number; result: PermissionVerdict }>();
  const autoSessions = new Map<string, { directory: string | null; at: number }>();
  const AUTO_SESSION_LIMIT = 1000;
  const routedAgents = new Map<string, { agent: string; previous: string }>();

  const broadcast = (type: string, properties: RoutingBroadcastProperties) => {
    try {
      broadcastGlobalUiEvent?.({ type, properties });
    } catch (error) {
      console.warn(`[routing] failed to broadcast ${type}:`, errorMessage(error));
    }
  };

  const enabledCategories = (config: RoutingConfig) => config.categories.filter((category) => category.enabled);

  const resolveAccess = async () => {
    const [typesafeKey, stored, savedEndpoint, ownGeminiKey] = await Promise.all([
      store.readToken(),
      store.readClassifierSource(),
      store.readCustomEndpoint(),
      store.readGeminiKey().then(usableGeminiKey),
    ]);
    const pinned = readPinnedEndpoint();
    const customEndpoint = pinned ?? savedEndpoint;
    const providerKeys = await readProviderKeys();
    const keys = { typesafeKey, customEndpoint, ...providerKeys, geminiKey: ownGeminiKey ?? providerKeys.geminiKey ?? null };
    const selected = !enterpriseMode() ? stored : pinned && stored !== 'off' ? 'custom' : 'off';
    const classifier = resolveClassifier({ selected, ...keys, zenPromotionActive });
    const source = classifier.effective;
    const endpoint = source === 'custom'
      ? customEndpoint ? classifierEndpoint(source, { ...keys, customEndpoint }) : null
      : source === 'gemini'
        ? keys.geminiKey ? classifierEndpoint(source, { ...keys, geminiKey: keys.geminiKey }) : null
        : source ? classifierEndpoint(source, keys) : null;
    return {
      classifier, endpoint, tokenPresent: Boolean(typesafeKey), geminiKeyPresent: Boolean(ownGeminiKey), customEndpoint, pinned: pinned !== null,
    };
  };

  const describeCustomEndpoint = (endpoint: CustomEndpoint | null, pinned: boolean): PublicCustomEndpoint | null => (endpoint
    ? { url: endpoint.url, model: endpoint.model, keyPresent: Boolean(endpoint.key), pinned }
    : null);

  const pinnedEndpointError = () => Object.assign(
    new Error('The custom endpoint is set by your administrator and cannot be changed here'),
    { status: 409 },
  );

  const describe = async () => {
    const [config, access] = await Promise.all([store.readConfig(), resolveAccess()]);
    const jevAvailable = access.endpoint !== null;
    const autoReady = jevAvailable && config.enabled && Boolean(config.fallback) && enabledCategories(config).length >= 2;
    return {
      available: true,
      autoReady,
      jevAvailable,
      tokenPresent: access.tokenPresent,
      geminiKeyPresent: access.geminiKeyPresent,
      customEndpoint: describeCustomEndpoint(access.customEndpoint, access.pinned),
      enterpriseMode: enterpriseMode(),
      jevSource: access.classifier.effective === 'typesafe' ? 'typesafe' : 'zen-free',
      classifier: legacyClassifier(access.classifier),
      classification: access.classifier,
      config,
      builtins: BUILTIN_CATEGORIES,
    };
  };

  const publishUpdated = async () => {
    const state = await describe();
    broadcast('openchamber:routing.updated', {
      available: state.available,
      autoReady: state.autoReady,
      jevAvailable: state.jevAvailable,
      tokenPresent: state.tokenPresent,
      jevSource: state.jevSource,
    });
    return state;
  };

  const openCodeClient = (directory: SessionScope['directory']) => {
    const headers = { ...getOpenCodeAuthHeaders() };
    const scope = z.string().trim().min(1).safeParse(directory);
    if (scope.success) headers['x-opencode-directory'] = encodeURIComponent(scope.data);
    return OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers });
  };

  const readHistory = readSessionHistory ?? (async ({ sessionId, directory }: SessionScope) => {
    const client = openCodeClient(directory);
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS);
    return loadRoutingHistory({
      signal,
      readPage: ({ limit, cursor }) => client.message.list(
        { sessionID: sessionId, limit, ...(cursor ? { cursor } : { order: 'desc' }) },
        { signal },
      ),
    });
  });

  const readConfig = readConfigEntries ?? ((directory: SessionScope['directory']) => openCodeClient(directory).config.get());

  const cacheHold = async ({ config, fallback, chosen, composerAgent, lastAnswer, sessionId, directory }: CacheHoldInput): Promise<RoutingCategory | null> => {
    if (!config.preserveCache || !lastAnswer) return null;
    const held = cacheHoldCategory({
      categories: enabledCategories(config), fallback, composerAgent, chosen, current: lastAnswer,
    });
    if (!held) return null;
    const idle = now() - lastAnswer.completed;
    if (idle < PROMPT_CACHE_TTL_MS) return held;
    if (isSessionWarm(sessionId, PROMPT_CACHE_TTL_MS)) return held;
    try {
      return idle < warmWindowMs(await readConfig(directory)) ? held : null;
    } catch (error) {
      console.warn('[routing] OpenCode config unavailable, treating the prompt cache as cold:', errorMessage(error));
      return null;
    }
  };

  const chooseSelection = (fallback: NonNullable<RoutingConfig['fallback']>, choice: RoutingCategory | null): Selection => {
    const model = choice?.model ? choice.model : fallback.model;
    const variant = choice?.model ? choice.variant : fallback.variant;
    return {
      model: toModelRef(model, variant),
      decision: { providerID: model.providerID, modelID: model.modelID, variant: variant ?? null, agent: choice?.agent ?? null },
    };
  };

  const readAgent = readSessionAgent ?? (async ({ sessionId, directory }: SessionScope) => (
    agentBodySchema.safeParse(await openCodeClient(directory).session.get({ sessionID: sessionId })).data?.agent ?? null
  ));

  const agentForSend = async ({ sessionId, directory, categoryAgent, composerAgent }: SessionScope & { categoryAgent: string | null; composerAgent: string | null }) => {
    const routed = routedAgents.get(sessionId);
    if (!sessionId || (!categoryAgent && !routed)) return categoryAgent || composerAgent;
    let current;
    try {
      current = await readAgent({ sessionId, directory });
    } catch (error) {
      console.warn('[routing] session agent unavailable, leaving it as it is:', errorMessage(error));
      return categoryAgent || composerAgent;
    }
    const stillRouted = routed && routed.agent === current;
    if (categoryAgent) {
      const previous = stillRouted ? routed.previous : current;
      routedAgents.delete(sessionId);
      if (previous && previous !== categoryAgent) {
        routedAgents.set(sessionId, { agent: categoryAgent, previous });
        while (routedAgents.size > AUTO_SESSION_LIMIT) {
          const oldest = routedAgents.keys().next();
          if (!oldest.done) routedAgents.delete(oldest.value);
        }
      }
      return categoryAgent;
    }
    if (!stillRouted || (composerAgent && composerAgent !== routed.agent)) {
      routedAgents.delete(sessionId);
      return composerAgent;
    }
    return routed.previous;
  };

  const readCatalog = listCatalogModels
    ?? (async (directory: SessionScope['directory']) => {
      const client = openCodeClient(directory);
      await waitForLocationPlugins(client);
      return catalogResponseSchema.parse(await client.model.list()).data;
    });

  const withKnownVariant = async (selection: Selection, directory: SessionScope['directory']) => {
    const variant = selection.model.variant;
    if (!variant) return selection;
    let models;
    try {
      models = await readCatalog(directory);
    } catch (error) {
      console.warn('[routing] model catalog unavailable, keeping the saved variant:', errorMessage(error));
      return selection;
    }
    const { providerID, id } = selection.model;
    const entry = models.find((model) => model.providerID === providerID && model.modelID === id);
    if (!entry || entry.variants.some((known) => known.id === variant)) return selection;
    console.warn(`[routing] ${providerID}/${id} has no "${variant}" thinking level; using its default`);
    return {
      ...selection,
      model: { providerID, id },
      decision: { ...selection.decision, variant: null },
    };
  };

  const resolveAutoSelection = async ({ sessionId, directory, model, agent, requestText }: AutoSelectionInput) => {
    if (!isAutoModel(model)) return null;
    const state = await describe();
    const config = state.config;
    if (!config?.fallback) {
      throw Object.assign(new Error('Auto routing is selected but no fallback model is configured'), { status: 400 });
    }
    const decision: RoutingAttempt = { sessionId, at: now(), category: null, confidence: 0, reason: 'not-ready', ms: 0 };
    let selection;
    if (state.autoReady) {
      let history: HistoryEntry[] = [];
      let lastAnswer: CacheHoldInput['lastAnswer'] = null;
      try {
        ({ history, lastAnswer } = await readHistory({ sessionId, directory }));
      } catch (error) {
        console.warn('[routing] history unavailable, routing on the request alone:', errorMessage(error));
      }
      try {
        const { endpoint } = await resolveAccess();
        if (!endpoint) throw new Error('No classification provider is available');
        const request = (requestText ?? '').trim();
        const { answers, ms } = await jev.ask(buildRoutingRequest({ categories: enabledCategories(config), history, request }), endpoint);
        const result = decideRouting(answers.category, { categories: enabledCategories(config), minConfidence: config.minConfidence });
        decision.category = result.category?.id ?? null;
        decision.confidence = result.confidence;
        decision.reason = result.reason;
        decision.ms = ms;
        const routed = routedAgents.get(sessionId);
        const composerAgent = routed && agent === routed.agent ? routed.previous : agent;
        const held = await cacheHold({ config, fallback: config.fallback, chosen: result.category, composerAgent, lastAnswer, sessionId, directory });
        if (held && result.category) {
          decision.category = held.id;
          decision.cacheHold = { requested: result.category.id };
        }
        selection = chooseSelection(config.fallback, held ?? result.category);
      } catch (error) {
        decision.reason = 'error';
        decision.error = errorMessage(error);
        selection = chooseSelection(config.fallback, null);
      }
    } else {
      selection = chooseSelection(config.fallback, null);
    }
    selection = await withKnownVariant(selection, directory);
    const sendAgent = await agentForSend({
      sessionId, directory, categoryAgent: selection.decision.agent, composerAgent: agent ?? null,
    });
    const completeDecision = Object.assign(decision, selection.decision);
    broadcast('openchamber:routing.decision', completeDecision);
    return { model: selection.model, agent: sendAgent, decision: completeDecision };
  };

  const noteModelSelection = (sessionId: string, model: JsonValue | undefined, directory?: string | null) => {
    if (!sessionId) return false;
    if (!isAutoModel(model)) {
      autoSessions.delete(sessionId);
      routedAgents.delete(sessionId);
      return false;
    }
    autoSessions.delete(sessionId);
    autoSessions.set(sessionId, { directory: directory ?? null, at: now() });
    while (autoSessions.size > AUTO_SESSION_LIMIT) {
      const oldest = autoSessions.keys().next();
      if (!oldest.done) autoSessions.delete(oldest.value);
    }
    return true;
  };

  const isAutoSession = (sessionId: string) => Boolean(sessionId) && autoSessions.has(sessionId);

  const applySessionSelection = async (sessionId: string, directory: SessionScope['directory'], selection: { model: RoutingModelRef; agent: string | null }) => {
    const client = openCodeClient(directory);
    await client.session.switchModel({ sessionID: sessionId, model: selection.model });
    if (selection.agent) await client.session.switchAgent({ sessionID: sessionId, agent: selection.agent });
  };

  const routeSend = async ({ sessionId, directory, body }: SessionScope & { body: RoutingBody }) => {
    const resolved = await resolveAutoSelection({
      sessionId,
      directory,
      model: AUTO_MODEL_REF,
      agent: agentBodySchema.safeParse(body).data?.agent ?? null,
      requestText: routingRequestTextOf(body),
    });
    if (!resolved) return null;
    await applySessionSelection(sessionId, directory, resolved);
    return resolved.decision;
  };

  const evaluatePermission = async (permission: RoutingPermission | null | undefined, directory?: JsonValue) => {
    if (!permission?.id) return { action: 'hold' };
    const cached = permissionDecisions.get(permission.id);
    if (cached && now() - cached.at < PERMISSION_DECISION_TTL_MS) return cached.result;
    const [config, access] = await Promise.all([store.readConfig(), resolveAccess()]);
    if (!access.endpoint) return { action: 'hold', unavailable: true };
    let result: PermissionVerdict;
    try {
      const { answers } = await jev.ask(buildPermissionRequest(permission), access.endpoint);
      const verdict = decidePermission(answers, { threshold: config.safetyNet.threshold });
      result = verdict.hold
        ? { action: 'hold', score: verdict.score, kind: verdict.kind }
        : { action: 'accept', score: verdict.score, kind: verdict.kind };
    } catch (error) {
      const skipped = errorMessage(error);
      broadcast('openchamber:routing.safety-skipped', {
        permissionId: permission.id, sessionId: permission.sessionID, directory: directory ?? null, error: skipped,
      });
      return { action: 'hold', skipped };
    }
    if (result.action === 'hold') {
      broadcast('openchamber:routing.permission-held', {
        permissionId: permission.id, sessionId: permission.sessionID, directory: directory ?? null, score: result.score, kind: result.kind,
      });
    }
    permissionDecisions.set(permission.id, { at: now(), result });
    return result;
  };

  const legacySafetyNetEnabled = async () => {
    try {
      return (await store.readConfig()).safetyNet.enabled === true;
    } catch {
      return false;
    }
  };

  const forgetPermission = (permissionId: string) => {
    permissionDecisions.delete(permissionId);
  };

  const updateConfig = async (input: Parameters<typeof parseEffectiveConfig>[0]) => {
    const config = parseEffectiveConfig(input);
    await store.writeConfig(config);
    return publishUpdated();
  };

  const setToken = async (token: JsonValue | undefined) => {
    const parsed = z.string().trim().min(1).max(4000).safeParse(token);
    if (!parsed.success) throw Object.assign(new Error('A Jev API key is required'), { status: 400 });
    if (enterpriseMode()) throw Object.assign(new Error(ENTERPRISE_MODE_ERROR), { status: 403 });
    await store.writeToken(parsed.data);
    await store.writeClassifierSource('typesafe');
    return publishUpdated();
  };

  const clearToken = async () => {
    await store.clearToken();
    return publishUpdated();
  };

  const setGeminiKey = async (key: JsonValue | undefined) => {
    const parsed = geminiKeySchema.safeParse(key);
    if (!parsed.success) throw Object.assign(new Error('A Gemini API key is required, without spaces or control characters'), { status: 400 });
    if (enterpriseMode()) throw Object.assign(new Error(ENTERPRISE_MODE_ERROR), { status: 403 });
    await store.writeGeminiKey(parsed.data);
    await store.writeClassifierSource('gemini');
    return publishUpdated();
  };

  const clearGeminiKey = async () => {
    await store.clearGeminiKey();
    return publishUpdated();
  };

  const setClassifierSource = async (source: JsonValue | undefined) => {
    const parsed = z.enum(CLASSIFIER_SOURCES).safeParse(source);
    if (!parsed.success) throw Object.assign(new Error(`Unknown classification provider: ${String(source)}`), { status: 400 });
    const allowedInEnterprise = parsed.data === 'off' || (parsed.data === 'custom' && readPinnedEndpoint() !== null);
    if (enterpriseMode() && !allowedInEnterprise) throw Object.assign(new Error(ENTERPRISE_MODE_ERROR), { status: 403 });
    await store.writeClassifierSource(parsed.data);
    return publishUpdated();
  };

  const setCustomEndpoint = async (input: CustomEndpointInput) => {
    if (readPinnedEndpoint()) throw pinnedEndpointError();
    if (enterpriseMode()) throw Object.assign(new Error(ENTERPRISE_MODE_ERROR), { status: 403 });
    const parsed = customEndpointInputSchema.safeParse(input);
    if (!parsed.success) throw Object.assign(new Error('A URL and a model are required'), { status: 400 });
    const { model, key } = parsed.data;
    const url = parseCustomEndpointUrl(parsed.data.url);
    const keepKey = key === undefined || key === '';
    const savedKey = keepKey ? (await store.readCustomEndpoint())?.key : key;
    const endpoint: CustomEndpoint = { url, model };
    if (savedKey) endpoint.key = savedKey;
    await store.writeCustomEndpoint(endpoint);
    if (key !== null) await store.writeClassifierSource('custom');
    return publishUpdated();
  };

  const clearCustomEndpoint = async () => {
    if (readPinnedEndpoint()) throw pinnedEndpointError();
    await store.clearCustomEndpoint();
    return publishUpdated();
  };

  const testClassifier = async (draft?: CustomEndpointInput) => {
    let source;
    let endpoint;
    if (draft !== undefined) {
      if (readPinnedEndpoint()) throw pinnedEndpointError();
      if (enterpriseMode()) throw Object.assign(new Error(ENTERPRISE_MODE_ERROR), { status: 403 });
      const parsed = customEndpointInputSchema.safeParse(draft);
      if (!parsed.success) throw Object.assign(new Error('A URL and a model are required'), { status: 400 });
      const key = parsed.data.key || (await store.readCustomEndpoint())?.key;
      source = 'custom';
      const customEndpoint: CustomEndpoint = { url: parseCustomEndpointUrl(parsed.data.url), model: parsed.data.model };
      if (key) customEndpoint.key = key;
      endpoint = classifierEndpoint('custom', {
        customEndpoint,
      });
    } else {
      const access = await resolveAccess();
      source = access.classifier.effective;
      endpoint = access.endpoint;
    }
    if (!source || !endpoint) return { ok: false, reason: 'unavailable' };
    try {
      const { answers, ms } = await jev.ask(buildProbeRequest(), endpoint);
      if (!isProbeAnswer(answers.probe)) return { ok: false, reason: 'unparsable', source, model: endpoint.model };
      return { ok: true, source, model: endpoint.model, ms };
    } catch (error) {
      if (hasTimeoutCode(error)) return { ok: false, reason: 'timeout', source, model: endpoint.model };
      if (hasHttpStatus(error)) return { ok: false, reason: 'http', status: error.status, source, model: endpoint.model };
      if (error instanceof SyntaxError || /no answers/.test(errorMessage(error))) {
        return { ok: false, reason: 'unparsable', source, model: endpoint.model };
      }
      return { ok: false, reason: 'network', message: errorMessage(error), source, model: endpoint.model };
    }
  };

  const currentClassifierEndpoint = async () => (await resolveAccess()).endpoint;

  const heldPermissions = () => {
    const held = [];
    for (const [permissionId, entry] of permissionDecisions) {
      if (entry.result.action === 'hold') held.push({ permissionId, score: entry.result.score, kind: entry.result.kind });
    }
    return held;
  };

  return {
    describe,
    classifierEndpoint: currentClassifierEndpoint,
    noteModelSelection,
    isAutoSession,
    resolveAutoSelection,
    applySessionSelection,
    routeSend,
    evaluatePermission,
    forgetPermission,
    heldPermissions,
    legacySafetyNetEnabled,
    updateConfig,
    setToken,
    clearToken,
    setGeminiKey,
    clearGeminiKey,
    setClassifierSource,
    setCustomEndpoint,
    clearCustomEndpoint,
    testClassifier,
  };
}
