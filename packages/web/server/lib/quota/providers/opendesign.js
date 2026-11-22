import { readQuotaJson } from '../utils/response-body.js';
import { readManagedCredential } from '../credentials/providers.js';
import {
  asNonEmptyString,
  asObject,
  buildResult,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../utils/index.js';

export const providerId = 'opendesign';
export const providerName = 'Open Design';
export const aliases = ['opendesign', 'open-design', 'amr'];

const API_BASE_URL = 'https://amr-api.open-design.ai/api';
const SESSION_COOKIE_NAME = 'better-auth.session_token';

export const IMPORT_REQUIRED_ERROR = 'Import the Open Design session cookie in Settings to read Open Design quota';
export const SESSION_EXPIRED_ERROR = 'Open Design session expired; import a fresh session cookie in Settings';

// The console reports plan windows by duration: 18000 seconds is the 5-hour
// window and 604800 is the 7-day window. Windows of any other duration are
// not part of the published plan shape and are left out.
const WINDOW_LABELS = new Map([
  [18000, '5h'],
  [604800, '7d']
]);

export const parseCodingPlanWindows = (payload) => {
  const data = asObject(payload);
  if (!data || !Array.isArray(data.windows)) return null;

  const windows = {};
  for (const entry of data.windows) {
    const record = asObject(entry);
    if (!record) continue;
    const label = WINDOW_LABELS.get(record.durationSeconds);
    if (!label) continue;
    const limit = toNumber(record.limitCredits);
    const remaining = toNumber(record.remainingCredits);
    if (limit === null || remaining === null) continue;
    const usedPercent = limit > 0
      ? Math.min(100, Math.max(0, (1 - remaining / limit) * 100))
      : null;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: record.durationSeconds,
      resetAt: toTimestamp(record.resetsAt),
      valueLabel: `${remaining} / ${limit} credits`
    });
  }
  return Object.keys(windows).length > 0 ? windows : null;
};

const BREAKDOWN_RECORD_KEYS = ['records', 'items', 'usage', 'data', 'entries'];

const breakdownRecords = (payload) => {
  if (Array.isArray(payload)) return payload;
  const data = asObject(payload);
  if (!data) return null;
  for (const key of BREAKDOWN_RECORD_KEYS) {
    if (Array.isArray(data[key])) return data[key];
  }
  return null;
};

/**
 * Per-model detail from the workspace usage records. The endpoint's field
 * names have not been verified against a live account yet (no session cookie
 * has been imported), so the parser accepts the plausible spellings and sums
 * what it finds; a payload it cannot recognize answers null and the quota
 * result simply carries no breakdown.
 */
export const parseUsageBreakdown = (payload) => {
  const records = breakdownRecords(payload);
  if (!records) return null;

  const byModel = new Map();
  for (const raw of records) {
    const record = asObject(raw);
    if (!record) continue;
    const model = asNonEmptyString(record.model ?? record.modelId ?? record.modelName);
    if (!model) continue;
    const entry = byModel.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      credits: 0,
      multiplier: null
    };
    entry.inputTokens += toNumber(record.inputTokens ?? record.input_tokens ?? record.promptTokens ?? record.prompt_tokens) ?? 0;
    entry.outputTokens += toNumber(record.outputTokens ?? record.output_tokens ?? record.completionTokens ?? record.completion_tokens) ?? 0;
    entry.totalTokens += toNumber(record.totalTokens ?? record.total_tokens) ?? 0;
    entry.credits += toNumber(record.credits ?? record.creditsUsed ?? record.credits_used ?? record.cost) ?? 0;
    const multiplier = toNumber(record.multiplier ?? record.creditMultiplier ?? record.credit_multiplier);
    if (multiplier !== null) entry.multiplier = multiplier;
    byModel.set(model, entry);
  }
  if (byModel.size === 0) return null;

  const models = [...byModel.values()];
  for (const entry of models) {
    if (entry.totalTokens === 0 && (entry.inputTokens > 0 || entry.outputTokens > 0)) {
      entry.totalTokens = entry.inputTokens + entry.outputTokens;
    }
  }
  const totalCredits = models.reduce((sum, entry) => sum + entry.credits, 0);
  for (const entry of models) {
    entry.sharePercent = totalCredits > 0 ? (entry.credits / totalCredits) * 100 : null;
  }
  models.sort((left, right) => right.credits - left.credits);
  return models;
};

const buildHeaders = (credential) => ({
  Accept: 'application/json',
  Cookie: credential.cookie,
  'x-vela-workspace-id': credential.workspaceId,
  'User-Agent': 'OpenChamber quota provider'
});

const workspaceUrl = (credential, suffix) => (
  `${API_BASE_URL}/v1/workspaces/${encodeURIComponent(credential.workspaceId)}/billing/${suffix}`
);

/**
 * The full Open Design usage read for one stored credential: session health
 * first, then the plan windows, then the per-model breakdown on a
 * best-effort basis. Throws with a user-facing message; an expired session
 * always throws SESSION_EXPIRED_ERROR so callers never render it as zeros.
 */
export const fetchOpenDesignQuota = async (credential, fetchImpl = fetch) => {
  const headers = buildHeaders(credential);

  const sessionResponse = await fetchImpl(`${API_BASE_URL}/auth/get-session`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(15_000)
  });
  const session = sessionResponse.ok ? await readQuotaJson(sessionResponse).catch(() => null) : null;
  if (!asObject(session)) throw new Error(SESSION_EXPIRED_ERROR);

  const usageResponse = await fetchImpl(workspaceUrl(credential, 'coding-plan-usage'), {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(15_000)
  });
  if (usageResponse.status === 401 || usageResponse.status === 403) {
    throw new Error(SESSION_EXPIRED_ERROR);
  }
  if (!usageResponse.ok) {
    throw new Error(`Open Design usage API returned HTTP ${usageResponse.status}`);
  }
  const windows = parseCodingPlanWindows(await readQuotaJson(usageResponse).catch(() => null));
  if (!windows) throw new Error('Open Design usage data could not be parsed');

  let models = null;
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
    const breakdownUrl = `${workspaceUrl(credential, 'usage')}?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
    const breakdownResponse = await fetchImpl(breakdownUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000)
    });
    if (breakdownResponse.ok) {
      models = parseUsageBreakdown(await readQuotaJson(breakdownResponse).catch(() => null));
    }
  } catch {
    // The breakdown is decoration on the windows: a failed read leaves the
    // windows standing and omits the per-model detail.
    models = null;
  }

  return models ? { windows, models } : { windows };
};

export const validateOpenDesignCredential = async (credential, fetchImpl = fetch) => {
  await fetchOpenDesignQuota(credential, fetchImpl);
};

export const isConfigured = () => Boolean(readManagedCredential(providerId));

export const fetchQuota = async () => {
  const credential = readManagedCredential(providerId);
  if (!credential) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: IMPORT_REQUIRED_ERROR
    });
  }

  try {
    const usage = await fetchOpenDesignQuota(credential);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
