import { asNonEmptyString, asObject, toNumber, toTimestamp } from '../utils/transformers.js';
import { toUsageWindow } from '../utils/formatters.js';

const CONSOLE_API_BASE = 'https://opencode.ai/console/api';
const REQUEST_TIMEOUT_MS = 15_000;
// The Console counts one cent as 1_000_000 micro-cents, so a dollar is 100_000_000.
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
// The Console workspace behind the shared `opencode` integration serves Zen and
// can also serve OpenCode Go. Only `opencode` model rows belong to Zen;
// `/usage/summary` counts the whole workspace and has no provider breakdown.
const ZEN_PROVIDER_ID = 'opencode';
const MODEL_PAGE_SIZE = 50;

const consoleNumber = (value) => toNumber(typeof value === 'string' ? asNonEmptyString(value) : value);
const clampPercent = (value) => Math.min(100, Math.max(0, value));

class MalformedUsageError extends Error {}

export const parseConsoleBudget = (payload) => {
  const budgets = [];
  for (const row of Array.isArray(payload) ? payload : []) {
    const budget = asObject(row);
    if (!budget) continue;
    const serviceAccountId = asNonEmptyString(budget.serviceAccountId);
    const spentMicroCents = consoleNumber(budget.spentMicroCents);
    const limitMicroCents = consoleNumber(budget.limitMicroCents);
    if (!serviceAccountId || spentMicroCents === null || spentMicroCents < 0) continue;
    budgets.push({
      serviceAccountId,
      name: asNonEmptyString(budget.name),
      spent: spentMicroCents / MICRO_CENTS_PER_DOLLAR,
      limit: limitMicroCents === null || limitMicroCents <= 0 ? null : limitMicroCents / MICRO_CENTS_PER_DOLLAR,
      resetAt: toTimestamp(budget.resetsAt),
    });
  }
  return budgets;
};

const requestWindow = (requests) => ({
  ...toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null }),
  value: { kind: 'requests', count: requests },
});

const budgetWindow = (budget) => ({
  ...toUsageWindow({
    usedPercent: budget.limit === null ? null : clampPercent((budget.spent / budget.limit) * 100),
    windowSeconds: null,
    resetAt: budget.resetAt,
  }),
  value: { kind: 'spend', spent: budget.spent, limit: budget.limit },
});

const fetchConsoleJson = async (path, credential, fetchImpl) => {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${'apiKey' in credential ? credential.apiKey : credential.accessToken}`,
    'x-opencode-session': 'openchamber-usage',
    'User-Agent': 'OpenChamber quota provider',
    ...('orgID' in credential ? { 'x-org-id': credential.orgID } : {}),
  };
  const response = await fetchImpl(`${CONSOLE_API_BASE}${path}`, {
    headers,
    // The bearer token belongs to opencode.ai; never forward it to another origin.
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) throw new Error('OpenCode Zen authentication failed');
  if (!response.ok) throw new Error(`OpenCode Zen usage API returned HTTP ${response.status}`);
  return payload;
};

/**
 * One `/usage/models` page, reduced to the rows this card owns. A row without a
 * provider cannot be attributed and makes the page unusable rather than risking
 * another provider's requests on the Zen card.
 */
const parseModelPage = (payload) => {
  const page = asObject(payload);
  if (!page || !Array.isArray(page.items)) {
    throw new MalformedUsageError('OpenCode Zen model page could not be parsed');
  }
  const pageCount = page.pageInfo?.pageCount;
  if (pageCount === undefined) {
    // A full page without pagination could be page one of several; counting it
    // as the only page would undercount the range.
    if (page.items.length >= MODEL_PAGE_SIZE) {
      throw new MalformedUsageError('OpenCode Zen model pagination could not be parsed');
    }
  } else if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
    throw new MalformedUsageError('OpenCode Zen model pagination could not be parsed');
  }
  const models = new Map();
  let requests = 0;
  for (const item of page.items) {
    const entry = asObject(item);
    const provider = asNonEmptyString(entry?.provider);
    if (!provider) throw new MalformedUsageError('OpenCode Zen model page could not be parsed');
    // OpenCode Go and any other provider in the same workspace stay on their
    // own cards; only the counts of this provider feed these windows.
    if (provider !== ZEN_PROVIDER_ID) continue;
    const model = asNonEmptyString(entry.model);
    const count = consoleNumber(entry.totalRequests);
    if (!model || count === null || count < 0) {
      throw new MalformedUsageError('OpenCode Zen model page could not be parsed');
    }
    const current = models.get(model);
    if (current) current.requests += count;
    else models.set(model, { requests: count });
    requests += count;
  }
  return { models, requests, pageCount: pageCount ?? 1 };
};

const fetchModelsForRange = async (range, credential, fetchImpl) => {
  const first = parseModelPage(await fetchConsoleJson(
    `/usage/models?range=${range}&page=1&pageSize=${MODEL_PAGE_SIZE}`,
    credential,
    fetchImpl,
  ));
  const models = first.models;
  let requests = first.requests;
  for (let page = 2; page <= first.pageCount; page++) {
    const next = parseModelPage(await fetchConsoleJson(
      `/usage/models?range=${range}&page=${page}&pageSize=${MODEL_PAGE_SIZE}`,
      credential,
      fetchImpl,
    ));
    for (const [model, usage] of next.models) {
      const current = models.get(model);
      if (current) current.requests += usage.requests;
      else models.set(model, { requests: usage.requests });
    }
    requests += next.requests;
  }
  return { models, requests };
};

const readUsageRange = async (range, credential, fetchImpl) => {
  try {
    return await fetchModelsForRange(range, credential, fetchImpl);
  } catch (error) {
    if (error instanceof MalformedUsageError) return null;
    throw error;
  }
};

export const fetchOpenCodeZenUsage = async (credential, fetchImpl = fetch) => {
  const [daily, weekly, monthly, budgetPayload] = await Promise.all([
    readUsageRange('24h', credential, fetchImpl),
    readUsageRange('7d', credential, fetchImpl),
    readUsageRange('30d', credential, fetchImpl),
    // A workspace without a service account has no budget; that is not an error.
    fetchConsoleJson('/budgets/service-accounts/status', credential, fetchImpl).catch(() => null),
  ]);
  const windows = {};
  if (daily) windows.daily = requestWindow(daily.requests);
  if (weekly) windows.weekly = requestWindow(weekly.requests);
  if (monthly) windows.monthly = requestWindow(monthly.requests);
  for (const budget of parseConsoleBudget(budgetPayload)) {
    // Window keys are also row titles. Keep the account identity visible even
    // when several accounts share a name; none of these is a workspace total.
    const label = budget.name ? `${budget.name} (${budget.serviceAccountId})` : budget.serviceAccountId;
    Object.defineProperty(windows, label, { value: budgetWindow(budget), enumerable: true, configurable: true });
  }
  const models = monthly
    ? Object.fromEntries([...monthly.models].map(([model, usage]) => [
      model, { windows: { monthly: requestWindow(usage.requests) } },
    ]))
    : {};
  if (Object.keys(windows).length === 0 && Object.keys(models).length === 0) {
    throw new Error('OpenCode Zen usage data could not be parsed');
  }
  return { windows, models };
};
