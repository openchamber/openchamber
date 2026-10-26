import fs from 'fs';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'os';
import path from 'path';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { asNonEmptyString } from '../shared/guards.js';
import {
  findModelInfo,
  getConfiguredSmallModelRef,
  getDefaultModelInfo,
  getSmallModelClient,
  listModelInfos,
  listProviderInfos,
} from './client.js';

const DEFAULT_TIMEOUT_MS = 60_000;

// The deadline is a hang guard, not a pace-setter: prefill dominates, so the
// budget scales with the prompt the module actually sends instead of the flat
// default. Issue #5017 measured local-model prefill at 94-187 tok/s on 4 GB-VRAM
// hardware, i.e. ~10.6 ms/token worst observed; 40 ms/token is ~4x headroom over
// that floor, which also absorbs the answer decode and one structured-output
// retry. The cap matches the walkthrough ceiling (../walkthrough/index.js), the
// in-repo precedent for size-scaled budgets.
const TIMEOUT_PER_TOKEN_MS = 40;
const TIMEOUT_MAX_MS = 900_000;

/** Budget for a prompt of `promptChars` characters (~4 chars/token, as for the input clamp). */
export const generationBudgetMs = (promptChars) => Math.min(
  TIMEOUT_MAX_MS,
  DEFAULT_TIMEOUT_MS + Math.max(0, Math.ceil(Number(promptChars) / 4)) * TIMEOUT_PER_TOKEN_MS,
);

// Waits between retries of `Model unavailable`, ~31 s in total. Right after
// OpenCode starts, plugin-provided models (claude-code) stay unavailable for
// 20-40 s while plugins for the global location load lazily. The rejection
// precedes provider dispatch, so a retry costs no tokens.
const UNAVAILABLE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000];
let unavailableRetryDelaysMs = UNAVAILABLE_RETRY_DELAYS_MS;

/** Test hook: replace the backoff schedule; no argument restores the default. */
export const setUnavailableRetryDelaysForTest = (delays = UNAVAILABLE_RETRY_DELAYS_MS) => {
  unavailableRetryDelaysMs = delays;
};

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

/**
 * OpenChamber's own settings: when the user unchecks "use default small model"
 * their explicit override outranks the model OpenCode would pick. The chosen
 * thinking variant belongs to that override, and is ignored with the rest of
 * it while "use default" is on.
 */
const readSmallModelSettingsOverride = () => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  if (settings.smallModelUseDefault !== false) return null;
  const model = parseModelRef(asNonEmptyString(settings.smallModelOverride));
  if (!model) return null;
  const variant = asNonEmptyString(settings.smallModelVariant);
  if (variant) model.variant = variant;
  return model;
};

export function parseModelRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

/**
 * The variant to actually send for a resolved model. A model the catalog does
 * not know yet keeps the saved variant, so a discovery gap does not silently
 * lose the user's choice. A model it knows uses only listed variants, the same
 * rule session defaults apply.
 */
const resolveModelVariant = (modelInfo, variant) => {
  const normalized = asNonEmptyString(variant);
  if (!normalized) return undefined;
  // An unlisted model is not evidence either way. A known model must list the
  // variant; a missing or malformed list counts as no levels, the same rule
  // session defaults and the VS Code bridge apply.
  if (!modelInfo) return normalized;
  const variants = Array.isArray(modelInfo.variants) ? modelInfo.variants : [];
  return variants.some((entry) => entry?.id === normalized) ? normalized : undefined;
};

// Rough safety clamp so a huge input never blows the model's context window.
// Token estimate is ~4 chars/token; when OpenCode reports no limit for the
// model a conservative default applies.
const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;

/**
 * Input budget in characters, given how much of the context the caller intends
 * to leave for the answer. The reserve must match the output budget the caller
 * will actually request, or the two disagree and the model overruns its context.
 */
export const getModelInputCharBudget = ({ modelInfo, outputReserveTokens }) => {
  const context = Number(modelInfo?.limit?.context);
  const known = context > 0;
  const contextTokens = known ? context : DEFAULT_CONTEXT_TOKENS;
  const reserve = Number(outputReserveTokens) > 0 ? Number(outputReserveTokens) : OUTPUT_RESERVE_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - reserve);
  return { maxChars: inputBudgetTokens * 4, contextTokens, contextKnown: known };
};

/**
 * The output budget to actually request: what the caller asked for, capped by
 * what the model admits it can emit.
 *
 * `/api/experimental/generate` takes no output budget of its own, so this number only
 * shapes the input reserve — but it has to stay the same number on both sides
 * or a caller that asks for a large answer overruns the context.
 */
const resolveOutputTokens = ({ modelInfo, maxOutputTokens }) => {
  const requested = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 0;
  if (!requested) return undefined;
  const limit = Number(modelInfo?.limit?.output);
  return limit > 0 ? Math.min(requested, limit) : requested;
};

// `truncate` keeps the historical behavior for callers whose prompt losing its
// tail is survivable (summaries, commit messages). `error` is for callers whose
// output would be quietly wrong on a clipped input — they need the failure.
const clampPromptToModelLimit = ({ prompt, modelInfo, providerID, modelID, onOverflow, outputReserveTokens }) => {
  const { maxChars } = getModelInputCharBudget({ modelInfo, outputReserveTokens });
  if (prompt.length <= maxChars) {
    return { prompt, truncated: false };
  }
  if (onOverflow === 'error') {
    throw Object.assign(
      new Error(`Input is too large for ${providerID}/${modelID}: ${prompt.length} characters exceeds the ${maxChars} the model's context allows`),
      { statusCode: 413, code: 'context-too-small', providerID, modelID, requiredChars: prompt.length, availableChars: maxChars },
    );
  }
  return { prompt: `${prompt.slice(0, maxChars)}…`, truncated: true };
};

const noClientError = () => Object.assign(
  new Error('No small model available — OpenCode is not reachable'),
  { statusCode: 404 },
);

/**
 * The model families that count as "small", most preferred first. The same
 * list OpenCode uses for its own session titles (`Catalog.model.small` in
 * `packages/core/src/catalog.ts`); OpenCode does not expose that lookup over
 * HTTP, so the scan is repeated here on `GET /api/model`.
 */
export const SMALL_MODEL_FAMILY_PRIORITY = ['gpt-luna', 'gemini-flash-lite', 'gemini-flash', 'claude-haiku'];

/**
 * A model's family: the catalog's `family` (models.dev) when it has one,
 * else read from the id. A custom provider or a subscription outside the
 * catalog has no `family`, yet its `gemini-3.6-flash` is still a flash.
 */
export const familyOf = (model) => {
  if (model?.family) return String(model.family);
  const id = String(model?.id ?? '').toLowerCase();
  if (id.includes('luna')) return 'gpt-luna';
  if (id.includes('flash-lite') || id.includes('flash_lite')) return 'gemini-flash-lite';
  if (id.includes('flash')) return 'gemini-flash';
  if (id.includes('haiku')) return 'claude-haiku';
  return null;
};

/**
 * The small model within one provider: the newest enabled, active, text-in
 * text-out model of the first family in `SMALL_MODEL_FAMILY_PRIORITY` that the
 * provider has. Null when the provider has none of those families.
 */
export const pickSmallModelInProvider = (models, providerID) => pickSmallModel(models, (model) => model.providerID === providerID);

const pickSmallModel = (models, accept) => {
  const candidates = models
    .filter((model) => model && accept(model)
      && model.enabled !== false
      && (model.status === undefined || model.status === 'active')
      && (model.capabilities?.input ?? ['text']).some((item) => String(item).startsWith('text'))
      && (model.capabilities?.output ?? ['text']).some((item) => String(item).startsWith('text')))
    .sort((a, b) => (Number(b.time?.released) || 0) - (Number(a.time?.released) || 0));
  for (const family of SMALL_MODEL_FAMILY_PRIORITY) {
    const found = candidates.find((model) => familyOf(model) === family);
    if (found) return { providerID: found.providerID, modelID: found.id };
  }
  return null;
};

/**
 * Which model this call runs on, in order:
 *
 * 1. An explicit request model, with the thinking variant the caller names.
 * 2. OpenChamber's settings override (Settings → Sessions → Small Model),
 *    including the thinking variant chosen beside the model.
 * 3. The small model configured for OpenCode itself: the `title` agent's
 *    model and variant (`agents.title.model`, or v1 `small_model`) — `config`.
 * 4. The small model of the caller's provider — the session's, or the one
 *    in the composer (family scan above) — `session-provider-small`. Without
 *    one the caller's own model (`session-model`): costlier, but never
 *    someone else's subscription.
 * 5. `GET /api/model/default`: OpenCode's default model — `default`, only
 *    when the caller named no provider or it is on that provider. This is
 *    the chat default, not a small model; OpenCode's own family scan is not
 *    reachable over HTTP, which is why step 4 lives here.
 *
 * There is no step that picks a small model from whichever other provider
 * happens to be connected: the content (diffs, replies, session text) goes
 * only where the user sent their own work or configured on purpose.
 */
const resolveSmallModel = async ({ client, directory, model, variant, preferredProviderID, preferredModelID }) => {
  const explicit = parseModelRef(model);
  if (explicit) {
    // A caller naming its model may name its thinking level with it.
    const explicitVariant = asNonEmptyString(variant);
    if (explicitVariant) explicit.variant = explicitVariant;
    return { ...explicit, source: 'request' };
  }

  const fromSettings = readSmallModelSettingsOverride();
  if (fromSettings) return { ...fromSettings, source: 'settings' };

  // A config can outlive the login behind it. OpenCode's own titles then move
  // on to another model, so a model it lists as disabled is skipped here too;
  // one it does not list (a plugin model still loading) is kept.
  const fromConfig = await getConfiguredSmallModelRef(client);
  if (fromConfig) {
    const info = findModelInfo(await listModelInfos(client, directory), fromConfig.providerID, fromConfig.modelID);
    if (info?.enabled !== false) return { ...fromConfig, source: 'config' };
  }

  if (preferredProviderID) {
    const small = pickSmallModelInProvider(await listModelInfos(client, directory), preferredProviderID);
    if (small) return { ...small, source: 'session-provider-small' };
    // OpenCode's own titles end here too: the model the user works with.
    if (preferredModelID) return { providerID: preferredProviderID, modelID: preferredModelID, source: 'session-model' };
  }

  const fallback = await getDefaultModelInfo(client);
  if (!fallback) return null;
  // Without a configured default, OpenCode answers with its first available
  // model, from any provider. A caller that named its provider stays on it.
  if (preferredProviderID && fallback.providerID !== preferredProviderID) return null;
  return { providerID: fallback.providerID, modelID: fallback.id, source: 'default' };
};

const LOCAL_NETWORKS = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 32], ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10]]) {
  LOCAL_NETWORKS.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) {
  LOCAL_NETWORKS.addSubnet(address, prefix, 'ipv6');
}
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa'];

/**
 * Whether the model is served from this machine or the local network, read
 * from the endpoint OpenCode reports for it (`settings.baseURL`). Covers
 * loopback, private and CGNAT (Tailscale) ranges, and LAN-style host names.
 * A model whose endpoint OpenCode does not report is not local.
 */
const isLocalModelEndpoint = (modelInfo) => {
  const endpoint = modelInfo?.settings?.baseURL ?? modelInfo?.settings?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) return false;
  let host;
  try {
    host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  const family = net.isIP(host);
  if (family) return LOCAL_NETWORKS.check(host, family === 6 ? 'ipv6' : 'ipv4');
  return host === 'localhost' || !host.includes('.') || LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
};

const JSON_FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

/**
 * `/api/experimental/generate` has no structured-output mode, so the schema travels in the
 * prompt and the reply is parsed here.
 */
const buildSchemaInstruction = (responseSchema) =>
  `Reply with JSON matching this schema and nothing else: ${JSON.stringify(responseSchema)}`;

const extractJsonText = (raw) => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  const fenced = JSON_FENCE.exec(trimmed);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
};

const requestOptions = ({ timeoutMs, promptChars, signal }) => {
  // An explicit caller timeout (e.g. the walkthrough's per-hunk budget) wins;
  // otherwise the deadline derives from the prompt actually sent.
  const budgetMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : generationBudgetMs(promptChars);
  const deadline = AbortSignal.timeout(budgetMs);
  return {
    budgetMs,
    deadline,
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  };
};

/**
 * Generates text with the user's small model through the running OpenCode.
 * Credentials stay inside OpenCode; this server only sends a prompt.
 */
export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, variant: requestVariant, directory, preferredProviderID, preferredModelID, responseSchema, timeoutMs, signal, onOverflow = 'truncate' }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }

  const client = getSmallModelClient(directory);
  if (!client) throw noClientError();

  const resolved = await resolveSmallModel({
    client,
    directory,
    model,
    variant: requestVariant,
    preferredProviderID,
    preferredModelID,
  });

  if (!resolved) {
    throw Object.assign(
      new Error(preferredProviderID
        ? 'No small model available within the session provider'
        : 'No small model available — OpenCode reports no default model'),
      { statusCode: 404 },
    );
  }

  const models = await listModelInfos(client, directory);
  const modelInfo = findModelInfo(models, resolved.providerID, resolved.modelID);
  const variant = resolveModelVariant(modelInfo, resolved.variant);

  const outputTokens = resolveOutputTokens({ modelInfo, maxOutputTokens });

  const clamped = clampPromptToModelLimit({
    prompt: prompt.trim(),
    modelInfo,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    onOverflow,
    outputReserveTokens: outputTokens,
  });

  // `/api/experimental/generate` takes a single prompt, so the system instructions lead it.
  const sections = [];
  if (typeof system === 'string' && system.trim()) sections.push(system.trim());
  sections.push(clamped.prompt);
  if (responseSchema) sections.push(buildSchemaInstruction(responseSchema));
  const fullPrompt = sections.join('\n\n');

  const generationOptions = requestOptions({ timeoutMs, promptChars: fullPrompt.length, signal });
  const unavailableMessage = `Model unavailable: ${resolved.providerID}/${resolved.modelID}`;

  // A blown deadline is a budget problem the user can act on (shorter diff,
  // faster model), not a bad model choice, so it gets its own code and message.
  // Detection reads the deadline signal itself: its reason is always the
  // timeout, while the composed signal's reason propagation varies by runtime.
  const deadlineError = (cause) => Object.assign(
    new Error(`${resolved.providerID}/${resolved.modelID} did not finish within the ${Math.round(generationOptions.budgetMs / 1000)}s budget for this prompt size`, { cause }),
    { statusCode: 504, code: 'generation-timeout', providerID: resolved.providerID, modelID: resolved.modelID },
  );

  const send = async () => {
    const model = { id: resolved.modelID, providerID: resolved.providerID };
    if (variant) model.variant = variant;
    const result = await client.generate.text(
      { prompt: fullPrompt, model },
      generationOptions,
    );
    return typeof result?.text === 'string' ? result.text : '';
  };

  const sendWithCatalogRetry = async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (generationOptions.deadline.aborted) throw deadlineError(error);
        if (error?._tag !== 'InvalidRequestError' || error.message !== unavailableMessage) throw error;
        // OpenCode 2 can resolve a cold catalog before its models arrive.
        // This rejection precedes provider dispatch; other failures must not retry.
        if (attempt < unavailableRetryDelaysMs.length) {
          await delay(unavailableRetryDelaysMs[attempt], undefined, { signal: generationOptions.signal })
            .catch((delayError) => {
              throw generationOptions.deadline.aborted ? deadlineError(delayError) : delayError;
            });
          continue;
        }
        throw Object.assign(new Error(unavailableMessage), {
          statusCode: 503,
          code: 'small-model-unavailable',
        });
      }
    }
  };

  let text = await sendWithCatalogRetry();

  if (responseSchema) {
    // One retry: a model that ignored the shape once often honours it on a
    // second pass, and the alternative is failing a walkthrough over a stray
    // sentence of preamble.
    let json = extractJsonText(text);
    if (json === null) {
      text = await sendWithCatalogRetry();
      json = extractJsonText(text);
    }
    if (json === null) {
      throw Object.assign(
        new Error(`${resolved.providerID}/${resolved.modelID} did not return JSON matching the requested schema`),
        { statusCode: 422, code: 'structured-output-unsupported', providerID: resolved.providerID, modelID: resolved.modelID },
      );
    }
    text = json;
  }

  return {
    text: text.trim(),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
    ...(clamped.truncated ? { inputTruncated: true } : {}),
  };
}

/**
 * Provider ids the small model can actually call. A provider counts when
 * OpenCode has at least one enabled model for it — that is the same test
 * OpenCode applies before letting a chat turn use it. The model list is
 * directory-scoped, so `directory` scopes this answer the same way
 * `describeSmallModel` scopes its own; without one the server default applies.
 *
 * The provider list alone is not enough: it comes back empty on setups where
 * models are perfectly usable, so the model list is the authority and the
 * provider list only contributes names.
 */
export async function listAuthenticatedProviders(directory) {
  const client = getSmallModelClient(directory);
  if (!client) return [];
  try {
    const [providers, models] = await Promise.all([
      listProviderInfos(client),
      listModelInfos(client, directory),
    ]);
    const enabled = new Set();
    for (const model of models) {
      if (model?.enabled === false) continue;
      if (typeof model?.providerID === 'string' && model.providerID) enabled.add(model.providerID);
    }
    const ids = new Set();
    for (const provider of providers) {
      if (typeof provider?.id === 'string' && enabled.has(provider.id)) ids.add(provider.id);
    }
    for (const id of enabled) ids.add(id);
    return Array.from(ids);
  } catch {
    return [];
  }
}

/**
 * The reserve, resolved against the model that was actually picked.
 *
 * A caller that wants "as much answer room as this model allows" cannot state a
 * number up front — it does not know which model it will get. Passing a
 * function lets it decide once the limits are known, and keeps the reserve and
 * the eventual request the same number by construction.
 */
const resolveReserveTokens = (outputReserveTokens, limits) => (
  typeof outputReserveTokens === 'function' ? outputReserveTokens(limits) : outputReserveTokens
);

/**
 * Reports which model and thinking variant would be used, without calling it.
 *
 * `structuredOutput` stays `null`: `/api/experimental/generate` has no structured-output
 * mode for any model, and this module emulates it through the prompt. Callers
 * must read `null` as "try it", which is exactly right here — the verdict
 * comes from the reply, not from a capability flag.
 */
export async function describeSmallModel({ directory, preferredProviderID, preferredModelID, outputReserveTokens, overrideModel, overrideVariant } = {}) {
  const client = getSmallModelClient(directory);
  if (!client) return null;

  // A caller with its own model setting (the diff walkthrough) outranks the
  // small-model chain entirely — it asked for this model on purpose.
  const resolved = await resolveSmallModel({
    client,
    directory,
    model: overrideModel,
    variant: overrideVariant,
    preferredProviderID,
    preferredModelID,
  });
  if (!resolved) return null;

  const models = await listModelInfos(client, directory);
  const modelInfo = findModelInfo(models, resolved.providerID, resolved.modelID);
  const variant = resolveModelVariant(modelInfo, resolved.variant);
  const outputTokenLimit = Number(modelInfo?.limit?.output) > 0 ? Number(modelInfo.limit.output) : null;

  // Two passes: the first only to learn the context, which a caller-supplied
  // reserve function needs before it can answer.
  const { contextTokens, contextKnown } = getModelInputCharBudget({ modelInfo });
  const reserveTokens = resolveReserveTokens(outputReserveTokens, { contextTokens, outputTokenLimit });
  const { maxChars } = getModelInputCharBudget({ modelInfo, outputReserveTokens: reserveTokens });

  // An override can name a model OpenCode has no credential for. It reports
  // that as a disabled model, and readiness refuses before the user pays for
  // a failed request. A model we cannot find at all is not evidence either
  // way, so it counts as usable.
  const hasLogin = modelInfo ? modelInfo.enabled !== false : true;

  return {
    ...resolved,
    variant,
    hasLogin,
    localEndpoint: isLocalModelEndpoint(modelInfo),
    inputCharBudget: maxChars,
    contextTokens,
    contextKnown,
    // What the caller should ask for, so the request and the reserve above
    // cannot drift apart.
    outputTokens: Number(reserveTokens) > 0 ? Number(reserveTokens) : null,
    structuredOutput: null,
    outputTokenLimit,
  };
}
