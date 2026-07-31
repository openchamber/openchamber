import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAuthFile, writeAuthFile } from '../opencode/auth.js';
import { readConfig, readConfigLayers, isPlainObject } from '../opencode/shared.js';
import { getCatalogProvider } from './catalog.js';
import { getAuthEntryForProvider } from './resolve.js';

// Direct, non-streaming text generation against the provider APIs, replicating
// how OpenCode authenticates each of them (see the plugin auth loaders in the
// opencode repo). auth.json credentials never leave this process.

const REQUEST_TIMEOUT_MS = 60_000;
const COPILOT_MODELS_TIMEOUT_MS = 5_000;
// Generous default: thinking models that can't be switched off (DeepSeek,
// Qwen, …) spend part of this budget on reasoning before the actual answer.
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;

const USER_AGENT = 'opencode/1.0 openchamber';

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

const httpError = async (response, provider) => {
  const body = await response.text().catch(() => '');
  const snippet = body ? `: ${body.slice(0, 300)}` : '';
  return new Error(`${provider} request failed with ${response.status}${snippet}`);
};

// Variant request patches resolve from the OpenCode config only:
// `provider.<id>.models.<id>.variants[variant]` in opencode.jsonc — the way
// custom models and variant overrides are configured. There is deliberately
// no models.dev layer: the models.dev schema has no `variants` field, so a
// catalog lookup could never match. (OpenCode itself generates variants at
// runtime from models.dev's `reasoning_options`, then deep-merges the config
// over them; this module does not port the generated set.)
//
// Consequence for catalog (non-custom) models: without a config entry they
// have no variants here, so a requested `#variant` resolves to no patch —
// the diagnostic log reports `applied: false` and the call proceeds with
// the model-id-derived defaults (e.g. Google's thinking default). Defining
// `provider.<id>.models.<id>.variants` in opencode.jsonc makes the variant
// effective and lets it override the catalog default, like OpenCode.
//
// A variant entry with `disabled: true` is dropped and the `disabled` key is
// stripped — same semantics as OpenCode's merge. Entries may be flat body
// options (e.g. `{ reasoning: { effort: "low" } }`) or the custom
// `{ headers, body }` patch shape. The variant is stripped from the model id
// before this point, so an unknown variant degrades to no patch instead of
// corrupting the wire model id.
const resolveVariantPatch = (variants, variant) => {
  if (!variant) return null;
  const raw = variants?.[variant];
  if (!isPlainObject(raw) || raw.disabled === true) return null;
  const { disabled, ...patch } = raw;
  const headers = patch.headers && isPlainObject(patch.headers) ? patch.headers : null;
  const body = patch.body && isPlainObject(patch.body) ? patch.body : patch;
  return { headers, body };
};

// ---------------------------------------------------------------------------
// OpenAI OAuth (ChatGPT plan / codex) token refresh — single-flight, with the
// refreshed token written back to auth.json exactly like OpenCode does.
// ---------------------------------------------------------------------------

let openaiRefreshPromise = null;

const decodeJwtClaims = (token) => {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const extractChatgptAccountId = (accessToken) => {
  const claims = decodeJwtClaims(accessToken);
  const auth = claims?.['https://api.openai.com/auth'];
  const value = auth?.chatgpt_account_id;
  return typeof value === 'string' && value ? value : null;
};

const refreshOpenaiOauth = async (entry) => {
  if (!openaiRefreshPromise) {
    openaiRefreshPromise = (async () => {
      const response = await fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: entry.refresh,
          client_id: CODEX_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw await httpError(response, 'OpenAI token refresh');
      }
      const payload = await response.json();
      const access = typeof payload?.access_token === 'string' ? payload.access_token : '';
      if (!access) {
        throw new Error('OpenAI token refresh returned no access token');
      }
      const refreshed = {
        ...entry,
        type: 'oauth',
        access,
        refresh: typeof payload?.refresh_token === 'string' && payload.refresh_token
          ? payload.refresh_token
          : entry.refresh,
        expires: Date.now() + (Number(payload?.expires_in) > 0 ? Number(payload.expires_in) : 3600) * 1000,
      };
      const auth = readAuthFile();
      auth.openai = refreshed;
      writeAuthFile(auth);
      return refreshed;
    })().finally(() => {
      openaiRefreshPromise = null;
    });
  }
  return openaiRefreshPromise;
};

const ensureFreshOpenaiOauth = async (entry) => {
  if (entry.access && Number(entry.expires) > Date.now()) {
    return entry;
  }
  if (!entry.refresh) {
    throw new Error('OpenAI OAuth entry has no refresh token');
  }
  return refreshOpenaiOauth(entry);
};

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

const callOpenaiCompatible = async ({ baseURL, headers, modelID, prompt, system, maxOutputTokens, providerLabel, extraBody, variantPatch }) => {
  const trimmedBase = baseURL.replace(/\/+$/, '');
  console.log('[small-model:diagnostic] request', {
    provider: providerLabel,
    model: modelID,
    variant: variantPatch ? 'applied' : null,
    maxOutputTokens,
    thinkingDisabled: extraBody?.thinking?.type === 'disabled',
    promptChars: prompt.length,
    systemChars: system?.length ?? 0,
    inputChars: prompt.length + (system?.length ?? 0),
  });
  const response = await fetch(`${trimmedBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(variantPatch?.headers || {}),
      ...headers,
    },
    body: JSON.stringify({
      model: modelID,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      max_tokens: maxOutputTokens,
      ...(extraBody || {}),
      ...(variantPatch?.body || {}),
      // Required wire format: this endpoint is read as a single JSON
      // response, so a variant patch can never flip streaming mode.
      stream: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  console.log('[small-model:diagnostic] response', {
    provider: providerLabel,
    model: modelID,
    httpStatus: response.status,
    ok: response.ok,
  });
  if (!response.ok) {
    throw await httpError(response, providerLabel);
  }
  const payload = await response.json();
  const message = payload?.choices?.[0]?.message;
  console.log('[small-model:diagnostic] completion', {
    provider: providerLabel,
    model: modelID,
    finishReason: payload?.choices?.[0]?.finish_reason ?? null,
    contentType: Array.isArray(message?.content) ? 'parts' : typeof message?.content,
    contentChars: typeof message?.content === 'string'
      ? message.content.length
      : Array.isArray(message?.content)
        ? message.content.reduce((total, part) => total + (typeof part?.text === 'string' ? part.text.length : 0), 0)
        : 0,
    reasoningChars: typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0,
  });

  // Providers disagree on the content shape: plain string, an array of
  // typed parts, or (thinking models) an empty content with the budget spent
  // on reasoning_content.
  let text = '';
  if (typeof message?.content === 'string') {
    text = message.content;
  } else if (Array.isArray(message?.content)) {
    text = message.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }
  if (!text.trim() && typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()) {
    const finishReason = payload?.choices?.[0]?.finish_reason;
    throw new Error(
      `${providerLabel} spent the output budget on reasoning and returned no answer`
      + (finishReason ? ` (finish_reason: ${finishReason})` : ''),
    );
  }
  if (!text.trim()) {
    throw new Error(`${providerLabel} returned no message content`);
  }
  return text;
};

const callOpenaiResponses = async ({ baseURL, headers, modelID, prompt, system, maxOutputTokens, providerLabel, variantPatch }) => {
  const trimmedBase = baseURL.replace(/\/+$/, '');
  const response = await fetch(`${trimmedBase}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(variantPatch?.headers || {}),
      ...headers,
    },
    body: JSON.stringify({
      model: modelID,
      ...(system ? { instructions: system } : {}),
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      }],
      max_output_tokens: maxOutputTokens,
      ...(variantPatch?.body || {}),
      // Required wire format: this endpoint is read as a single JSON
      // response, so a variant patch can never flip streaming mode or
      // change store behavior.
      stream: false,
      store: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await httpError(response, providerLabel);
  }
  const payload = await response.json();
  const text = typeof payload?.output_text === 'string'
    ? payload.output_text
    : Array.isArray(payload?.output)
      ? payload.output
        .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
        .map((part) => (part?.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
        .join('')
      : '';
  if (!text.trim()) {
    throw new Error(`${providerLabel} returned no text output`);
  }
  return text;
};

const callMessages = async ({ url, headers, modelID, prompt, system, maxOutputTokens, providerLabel, variantPatch }) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(variantPatch?.headers || {}),
      ...headers,
    },
    body: JSON.stringify({
      model: modelID,
      max_tokens: maxOutputTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      ...(variantPatch?.body || {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await httpError(response, providerLabel);
  }
  const payload = await response.json();
  const text = (payload?.content || [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (!text) {
    throw new Error(`${providerLabel} returned no text content`);
  }
  return text;
};

const callAnthropic = async ({ apiKey, modelID, prompt, system, maxOutputTokens, variantPatch }) => callMessages({
  url: 'https://api.anthropic.com/v1/messages',
  headers: {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  modelID,
  prompt,
  system,
  maxOutputTokens,
  providerLabel: 'Anthropic',
  variantPatch,
});

const getCopilotEndpoint = async ({ baseURL, headers, modelID }) => {
  const trimmedBase = baseURL.replace(/\/+$/, '');
  const response = await fetch(`${trimmedBase}/models`, {
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(COPILOT_MODELS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await httpError(response, 'GitHub Copilot models');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('GitHub Copilot models returned invalid JSON');
  }
  if (!Array.isArray(payload?.data)) {
    throw new Error('GitHub Copilot models returned an invalid model list');
  }

  const model = payload.data.find((item) => item && typeof item === 'object' && item.id === modelID);
  if (!model) {
    throw new Error(`GitHub Copilot model "${modelID}" was not returned by /models`);
  }
  if (model.supported_endpoints === undefined) {
    return 'chat';
  }
  if (!Array.isArray(model.supported_endpoints)) {
    throw new Error(`GitHub Copilot model "${modelID}" returned invalid endpoint metadata`);
  }
  if (model.supported_endpoints.includes('/v1/messages')) {
    return 'messages';
  }
  if (model.supported_endpoints.includes('/responses')) {
    return 'responses';
  }
  if (model.supported_endpoints.includes('/chat/completions')) {
    return 'chat';
  }
  throw new Error(`GitHub Copilot model "${modelID}" has no supported text endpoint`);
};

const callGoogle = async ({ apiKey, modelID, prompt, system, maxOutputTokens, variantPatch }) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelID)}:generateContent`;
  // Variant patches (e.g. `{ thinkingConfig: {...} }`) live in
  // generationConfig for Google's wire format; an explicit variant
  // overrides the model-id derived thinking default.
  const thinkingConfig = variantPatch?.body?.thinkingConfig
    ?? (modelID.toLowerCase().startsWith('gemini-3')
      ? { thinkingLevel: modelID.toLowerCase().includes('flash') ? 'minimal' : 'low' }
      : { thinkingBudget: 0 });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(variantPatch?.headers || {}),
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        ...(variantPatch?.body || {}),
        maxOutputTokens,
        thinkingConfig,
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await httpError(response, 'Google');
  }
  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
  if (!text) {
    throw new Error('Google returned no text content');
  }
  return text;
};

// ChatGPT-plan traffic goes to the codex backend, which only speaks the
// streaming Responses API — collect the output_text deltas from the SSE body.
const callCodexResponses = async ({ accessToken, accountId, modelID, prompt, system, variantPatch }) => {
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(variantPatch?.headers || {}),
      Authorization: `Bearer ${accessToken}`,
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      originator: 'opencode',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      model: modelID,
      ...(system ? { instructions: system } : {}),
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
      // The codex backend rejects max_output_tokens (OpenCode forces it to
      // undefined for this provider too) and only speaks the streaming
      // Responses API, so a variant patch can never flip the response mode.
      ...(variantPatch?.body || {}),
      stream: true,
      store: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw await httpError(response, 'OpenAI (ChatGPT plan)');
  }

  const raw = await response.text();
  let text = '';
  let completedText = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
    }
    if (event?.type === 'response.output_text.done' && typeof event.text === 'string') {
      completedText = event.text;
    }
    if (event?.type === 'response.failed' || event?.type === 'error') {
      const message = event?.response?.error?.message || event?.message || 'response failed';
      throw new Error(`OpenAI (ChatGPT plan) stream error: ${message}`);
    }
  }
  const result = completedText || text;
  if (!result) {
    throw new Error('OpenAI (ChatGPT plan) returned no text output');
  }
  return result;
};

// ---------------------------------------------------------------------------
// Custom provider configuration support
// ---------------------------------------------------------------------------

const resolveConfigApiKey = (value, workingDirectory, providerID) => {
  const envMatch = value.match(/^\{env:([^}]+)\}$/i);
  if (envMatch) {
    return process.env[envMatch[1].trim()]?.trim() || null;
  }

  const fileMatch = value.match(/^\{file:(.+)\}$/i);
  if (!fileMatch) return value;

  const configuredPath = fileMatch[1].trim();
  let resolvedPath;
  if (configuredPath === '~' || configuredPath.startsWith('~/') || configuredPath.startsWith('~\\')) {
    resolvedPath = path.join(os.homedir(), configuredPath.slice(2));
  } else if (path.isAbsolute(configuredPath)) {
    resolvedPath = configuredPath;
  } else {
    const layers = readConfigLayers(workingDirectory);
    const source = [
      { config: layers.customConfig, filePath: layers.paths.customPath },
      { config: layers.projectConfig, filePath: layers.paths.projectPath },
      { config: layers.userConfig, filePath: layers.paths.userPath },
    ].find(({ config }) => config?.provider?.[providerID]?.options?.apiKey === value);
    resolvedPath = path.resolve(source?.filePath ? path.dirname(source.filePath) : workingDirectory || process.cwd(), configuredPath);
  }

  try {
    const key = fs.readFileSync(resolvedPath, 'utf8').trim();
    if (!key) throw new Error('empty file');
    return key;
  } catch {
    throw new Error(`Failed to resolve configured apiKey file for provider "${providerID}"`);
  }
};

// Merged OpenCode config (user → project → custom, custom wins) — read once
// and shaped into everything the dispatch needs: provider auth options and
// the model's config-defined variants.
const readProviderConfig = (workingDirectory, providerID, modelID) => {
  try {
    const config = readConfig(workingDirectory);
    const providerCfg = config?.provider?.[providerID];
    if (!providerCfg || typeof providerCfg !== 'object') return null;
    const baseURL = typeof providerCfg?.options?.baseURL === 'string' ? providerCfg.options.baseURL.trim() : null;
    const rawApiKey = typeof providerCfg?.options?.apiKey === 'string' ? providerCfg.options.apiKey.trim() : null;
    const apiKey = rawApiKey ? resolveConfigApiKey(rawApiKey, workingDirectory, providerID) : null;
    const modelCfg = providerCfg?.models?.[modelID];
    const variants = isPlainObject(modelCfg?.variants) ? modelCfg.variants : null;
    return {
      baseURL,
      // Shape the config-supplied key as a regular api-key auth entry so it
      // can win the precedence check below and flow through the dispatch's
      // `entry.type === 'api' ? entry.key : ...` branch unchanged.
      auth: apiKey ? { type: 'api', key: apiKey } : null,
      // Variants configured under `provider.<id>.models.<id>.variants`.
      variants,
    };
  } catch {
    // Config is non-essential — continue with auth.json/catalog-only resolution.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function callSmallModel({ auth, catalog, workingDirectory, providerID, modelID, variant, prompt, system, maxOutputTokens }) {
  const tokens = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS;
  const providerConfig = readProviderConfig(workingDirectory, providerID, modelID);
  // Match OpenCode's resolveSDK precedence:
  // config provider.<id>.options.apiKey (providerConfig.auth) wins; the
  // auth.json entry is only a fallback.
  const entry = providerConfig?.auth || getAuthEntryForProvider(auth, providerID);
  if (!entry) {
    throw new Error(`No OpenCode login found for provider "${providerID}"`);
  }

  // The variant is never part of the wire model id; when the config does not
  // define it for this model the patch degrades to nothing (mirrors OpenCode's
  // fitVariant, which drops unknown variants) and the call proceeds on the
  // clean model id.
  const variantPatch = resolveVariantPatch(providerConfig?.variants, variant);
  if (variant) {
    console.log('[small-model:diagnostic] variant', {
      provider: providerID,
      model: modelID,
      variant,
      applied: Boolean(variantPatch),
    });
  }

  if (providerID === 'github-copilot') {
    // OpenCode uses the stored device-OAuth token directly as the bearer —
    // access === refresh, no exchange, no expiry.
    const token = entry.refresh || entry.access || entry.key;
    if (!token) {
      throw new Error('GitHub Copilot login has no token');
    }
    const baseURL = entry.enterpriseUrl
      ? `https://copilot-api.${String(entry.enterpriseUrl).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
      : 'https://api.githubcopilot.com';
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2026-06-01',
    };
    const headers = {
      ...authHeaders,
      'Openai-Intent': 'conversation-edits',
      'x-initiator': 'agent',
    };
    const endpoint = await getCopilotEndpoint({
      baseURL,
      headers: authHeaders,
      modelID,
    });
    const request = {
      baseURL,
      headers,
      modelID,
      prompt,
      system,
      maxOutputTokens: tokens,
      providerLabel: 'GitHub Copilot',
      variantPatch,
    };
    if (endpoint === 'messages') {
      return callMessages({
        ...request,
        url: `${baseURL.replace(/\/+$/, '')}/v1/messages`,
        headers: {
          ...request.headers,
          'anthropic-version': '2023-06-01',
        },
      });
    }
    if (endpoint === 'responses') {
      return callOpenaiResponses(request);
    }
    return callOpenaiCompatible(request);
  }

  if (providerID === 'openai' && entry.type === 'oauth') {
    const fresh = await ensureFreshOpenaiOauth(entry);
    return callCodexResponses({
      accessToken: fresh.access,
      accountId: fresh.accountId || extractChatgptAccountId(fresh.access),
      modelID,
      prompt,
      system,
      variantPatch,
    });
  }

  const apiKey = entry.type === 'api' ? entry.key
    : entry.type === 'wellknown' ? entry.token
      : entry.access;
  if (!apiKey) {
    throw new Error(`OpenCode login for "${providerID}" has no usable credential`);
  }

  if (providerID === 'anthropic') {
    return callAnthropic({ apiKey, modelID, prompt, system, maxOutputTokens: tokens, variantPatch });
  }
  if (providerID === 'google') {
    return callGoogle({ apiKey, modelID, prompt, system, maxOutputTokens: tokens, variantPatch });
  }

  // Everything else: OpenAI-compatible chat completions against the catalog's
  // base URL for that provider (openai itself included). When a custom provider
  // is not in the catalog (e.g. a user-configured OpenAI-compatible proxy),
  // fall back to its baseURL from the OpenCode provider config. The openai
  // provider also respects provider.openai.options.baseURL — OpenCode itself
  // uses the same config for all providers including openai.
  const provider = getCatalogProvider(catalog, providerID);
  const providerConfigUrl = providerConfig?.baseURL;
  const defaultOpenaiUrl = 'https://api.openai.com/v1';
  const baseURL = typeof providerConfigUrl === 'string' && providerConfigUrl
    ? providerConfigUrl
    : providerID === 'openai'
      ? defaultOpenaiUrl
      : typeof provider?.api === 'string' && provider.api
        ? provider.api
        : null;
  if (!baseURL) {
    throw new Error(`Provider "${providerID}" has no known API base URL`);
  }

  // Thinking models burn the output budget on reasoning and leave content
  // empty — disable thinking where a wire-format switch exists (mirrors
  // OpenCode's smallOptions/variants special cases). There is NO universal
  // parameter: unknown body fields 400 on some providers, so this stays an
  // explicit allowlist. Models without a switch (DeepSeek, Qwen, Kimi, …)
  // just get the generous output budget.
  const lowerModel = modelID.toLowerCase();
  const supportsThinkingToggle = providerID.includes('zai')
    || providerID.includes('zhipu')
    || lowerModel.includes('glm')
    || lowerModel.includes('minimax-m3');
  const extraBody = supportsThinkingToggle ? { thinking: { type: 'disabled' } } : undefined;

  return callOpenaiCompatible({
    baseURL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    modelID,
    prompt,
    system,
    maxOutputTokens: tokens,
    providerLabel: provider?.name || providerID,
    extraBody,
    variantPatch,
  });
}
