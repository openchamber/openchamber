/**
 * Cost and token totals for a plan's linked session (#16).
 *
 * The decision on the issue (2026-11-03): a plan's cost is the linked
 * session's own cost as OpenCode reports it — that figure is authoritative.
 * The models.dev catalog prices the session's tokens only as a fallback for
 * a session whose record carries no cost figure. A session that cannot be
 * read, or that reports neither cost nor tokens, gives no metrics at all:
 * the plan simply shows no badge, never a fabricated zero.
 */

import { asNonEmptyString, isRecord, isString } from '../shared/guards.js';
import { readBoundedResponseJson } from '../shared/response-body.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { getModelsMetadata } from '../opencode/models-metadata.js';

// One session record is small; the cap matches the session-activity probe's
// page cap only in spirit — a single record never approaches it.
const SESSION_RESPONSE_MAX_BYTES = 1024 * 1024;
// Project context reloads on edits and focus changes. A 30-second window keeps
// badge totals responsive without repeating the same session read per client.
const PLAN_METRICS_CACHE_TTL_MS = 30_000;
const PLAN_METRICS_CACHE_MAX_ENTRIES = 500;

// Number.isFinite does not coerce, so a non-number fails it without a typeof.
const nonNegativeNumber = (value) =>
  (Number.isFinite(value) && value >= 0 ? value : null);

const tokenCount = (value) => {
  const parsed = nonNegativeNumber(value);
  return parsed === null ? 0 : Math.floor(parsed);
};

/**
 * The session's token totals in the client's shape, or null when the record
 * carries no token block at all. A present block with zero counts is data
 * (a session that ran no model step), not absence.
 */
export const sessionTokensOf = (session) => {
  if (!isRecord(session) || !isRecord(session.tokens)) return null;
  const tokens = session.tokens;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  const input = tokenCount(tokens.input);
  const output = tokenCount(tokens.output);
  const reasoning = tokenCount(tokens.reasoning);
  const cacheRead = tokenCount(cache.read);
  const cacheWrite = tokenCount(cache.write);
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
};

/** `{ providerID, modelID }` from a session record's model field, in any of its shapes. */
const sessionModelOf = (session) => {
  const model = session?.model;
  if (isString(model)) {
    const slash = model.indexOf('/');
    return slash > 0
      ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
      : { providerID: null, modelID: model };
  }
  if (!isRecord(model)) return { providerID: null, modelID: null };
  return {
    providerID: asNonEmptyString(model.providerID),
    modelID: asNonEmptyString(model.modelID) ?? asNonEmptyString(model.model) ?? asNonEmptyString(model.id),
  };
};

/**
 * USD cost of the session's tokens at models.dev catalog prices (per 1M
 * tokens), or null when the catalog does not price the session's model.
 * Reasoning tokens bill at the output rate, as OpenCode's own costing does.
 */
export const catalogCostUsdOf = (catalog, session, tokens) => {
  if (!isRecord(catalog) || !tokens) return null;
  const { providerID, modelID } = sessionModelOf(session);
  if (!providerID || !modelID) return null;
  const provider = catalog[providerID];
  const model = isRecord(provider) && isRecord(provider.models) ? provider.models[modelID] : null;
  const price = isRecord(model) ? model.cost : null;
  if (!isRecord(price)) return null;
  const input = nonNegativeNumber(price.input);
  const output = nonNegativeNumber(price.output);
  if (input === null || output === null) return null;
  const cacheRead = nonNegativeNumber(price.cache_read) ?? 0;
  const cacheWrite = nonNegativeNumber(price.cache_write) ?? 0;
  return (
    tokens.input * input +
    (tokens.output + tokens.reasoning) * output +
    tokens.cacheRead * cacheRead +
    tokens.cacheWrite * cacheWrite
  ) / 1_000_000;
};

/**
 * A plan's metrics from its linked session's record, or null when the record
 * carries neither a cost figure nor tokens. `catalog` may be null; the
 * catalog fallback then simply cannot price the session (`costUsd: null`).
 */
export const planMetricsOfSession = (session, catalog) => {
  if (!isRecord(session)) return null;
  const tokens = sessionTokensOf(session);
  const reported = nonNegativeNumber(session.cost);
  if (reported === null && tokens === null) return null;
  if (reported !== null) {
    return { costUsd: reported, costSource: 'opencode', tokens };
  }
  const priced = catalogCostUsdOf(catalog, session, tokens);
  return priced !== null
    ? { costUsd: priced, costSource: 'catalog', tokens }
    : { costUsd: null, costSource: null, tokens };
};

const defaultLoadCatalog = async () => (await getModelsMetadata()).metadata;

/**
 * Reads plan metrics by session id from the running OpenCode. Every failure
 * — OpenCode unreachable, session gone, catalog unreachable — resolves null,
 * following the module's rule that a plan without metrics is a display
 * state, not an error. The catalog is fetched only for a session whose
 * record carries tokens but no cost figure.
 */
export const createPlanMetricsReader = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  loadCatalog = defaultLoadCatalog,
  now = Date.now,
}) => {
  const metricsBySession = new Map();
  const requestsBySession = new Map();

  const readSession = async (sessionId) => {
    const response = await fetchImpl(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, ''), {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const record = unwrapOpenCodeResponse(await readBoundedResponseJson(response, SESSION_RESPONSE_MAX_BYTES));
    return isRecord(record) ? record : null;
  };

  const cacheMetrics = (sessionId, metrics) => {
    const currentTime = now();
    for (const [cachedSessionId, cached] of metricsBySession) {
      if (cached.expiresAt > currentTime) break;
      metricsBySession.delete(cachedSessionId);
    }
    while (metricsBySession.size >= PLAN_METRICS_CACHE_MAX_ENTRIES) {
      const oldestSessionId = metricsBySession.keys().next().value;
      if (oldestSessionId === undefined) break;
      metricsBySession.delete(oldestSessionId);
    }
    metricsBySession.set(sessionId, {
      metrics,
      expiresAt: currentTime + PLAN_METRICS_CACHE_TTL_MS,
    });
  };

  return async (sessionId) => {
    const id = asNonEmptyString(sessionId);
    if (!id) return null;

    const cached = metricsBySession.get(id);
    if (cached && cached.expiresAt > now()) return cached.metrics;
    if (cached) metricsBySession.delete(id);

    const pending = requestsBySession.get(id);
    if (pending) return pending;

    const request = (async () => {
      try {
        const session = await readSession(id);
        if (!session) return null;

        const directMetrics = planMetricsOfSession(session, null);
        if (!directMetrics) return null;
        if (directMetrics.costUsd !== null) {
          cacheMetrics(id, directMetrics);
          return directMetrics;
        }

        let catalog;
        try {
          catalog = await loadCatalog();
        } catch {
          return directMetrics;
        }
        const metrics = planMetricsOfSession(session, catalog) ?? directMetrics;
        if (isRecord(catalog)) cacheMetrics(id, metrics);
        return metrics;
      } catch {
        return null;
      } finally {
        if (requestsBySession.get(id) === request) requestsBySession.delete(id);
      }
    })();
    requestsBySession.set(id, request);
    return request;
  };
};
