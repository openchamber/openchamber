import { asNonEmptyString, asObject, toNumber, toTimestamp } from '../utils/transformers.js';
import { toUsageWindow } from '../utils/formatters.js';

const CONSOLE_API_BASE = 'https://opencode.ai/console/api';
const REQUEST_TIMEOUT_MS = 15_000;
// The Console counts one cent as 1_000_000 micro-cents, so a dollar is 100_000_000.
const MICRO_CENTS_PER_DOLLAR = 100_000_000;

const consoleNumber = (value) => toNumber(typeof value === 'string' ? asNonEmptyString(value) : value);
const clampPercent = (value) => Math.min(100, Math.max(0, value));

export const parseConsoleSummary = (payload) => {
  const summary = asObject(payload);
  if (!summary) return null;
  const requests = consoleNumber(summary.totalRequests);
  if (requests === null || requests < 0) return null;
  return { requests };
};

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

export const parseConsoleModelUsage = (payload) => {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const models = new Map();
  for (const item of items) {
    const entry = asObject(item);
    if (!entry) continue;
    const model = asNonEmptyString(entry.model);
    const requests = consoleNumber(entry.totalRequests);
    if (!model || requests === null || requests < 0) continue;
    models.set(model, { requests });
  }
  return Object.fromEntries(models);
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

const fetchModels = async (credential, fetchImpl) => {
  const first = await fetchConsoleJson('/usage/models?range=30d&page=1&pageSize=50', credential, fetchImpl);
  const models = new Map(Object.entries(parseConsoleModelUsage(first)));
  const pageCount = first?.pageInfo?.pageCount;
  if (pageCount !== undefined && (!Number.isSafeInteger(pageCount) || pageCount < 0)) {
    throw new Error('OpenCode Zen model pagination could not be parsed');
  }
  for (let page = 2; page <= (pageCount ?? 1); page++) {
    const payload = await fetchConsoleJson(`/usage/models?range=30d&page=${page}&pageSize=50`, credential, fetchImpl);
    if (!Array.isArray(payload?.items)) throw new Error('OpenCode Zen model page could not be parsed');
    for (const [model, usage] of Object.entries(parseConsoleModelUsage(payload))) models.set(model, usage);
  }
  return Object.fromEntries(models);
};

export const fetchOpenCodeZenUsage = async (credential, fetchImpl = fetch) => {
  const [dailyPayload, weeklyPayload, monthlyPayload, modelUsage, budgetPayload] = await Promise.all([
    fetchConsoleJson('/usage/summary?range=24h', credential, fetchImpl),
    fetchConsoleJson('/usage/summary?range=7d', credential, fetchImpl),
    fetchConsoleJson('/usage/summary?range=30d', credential, fetchImpl),
    fetchModels(credential, fetchImpl),
    // A workspace without a service account has no budget; that is not an error.
    fetchConsoleJson('/budgets/service-accounts/status', credential, fetchImpl).catch(() => null),
  ]);
  const daily = parseConsoleSummary(dailyPayload);
  const weekly = parseConsoleSummary(weeklyPayload);
  const monthly = parseConsoleSummary(monthlyPayload);
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
  const models = Object.fromEntries(Object.entries(modelUsage).map(([model, usage]) => [
    model, { windows: { monthly: requestWindow(usage.requests) } },
  ]));
  if (Object.keys(windows).length === 0 && Object.keys(models).length === 0) {
    throw new Error('OpenCode Zen usage data could not be parsed');
  }
  return { windows, models };
};
