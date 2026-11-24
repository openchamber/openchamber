import { z } from 'zod';
import { asNonEmptyString, asObject, toNumber, toTimestamp } from '../utils/transformers.js';
import { toUsageWindow } from '../utils/formatters.js';
import type { UsageWindow } from '../utils/contracts.js';

export type OpenCodeZenCredential = { apiKey: string } | { accessToken: string; orgID: string };

interface ConsoleFields {
  serviceAccountId?: unknown;
  spentMicroCents?: unknown;
  limitMicroCents?: unknown;
  name?: unknown;
  resetsAt?: unknown;
  items?: unknown;
  pageInfo?: unknown;
  pageCount?: unknown;
  provider?: unknown;
  model?: unknown;
  totalRequests?: unknown;
}

const isObject = (value: unknown): value is ConsoleFields => asObject(value) !== null;
const asFields = z.custom<ConsoleFields | null>(isObject).catch(null).parse;
const hasFields = (value: unknown): value is ConsoleFields => value !== null && value !== undefined;
const isSafePageCount = (value: unknown): value is number => Number.isSafeInteger(value);
const isString = (value: unknown): value is string => typeof value === 'string';

export interface ConsoleBudget {
  serviceAccountId: string;
  name: string | null;
  spent: number;
  limit: number | null;
  resetAt: number | null;
}

export interface OpenCodeZenWindow extends UsageWindow {
  usedPercent: number | null;
  resetAt: number | null;
  value: { kind: 'requests'; count: number } | { kind: 'spend'; spent: number; limit: number | null };
}

type ConsoleHeaders = {
  Accept: string;
  Authorization: string;
  'x-opencode-session': string;
  'User-Agent': string;
  'x-org-id'?: string;
};

const CONSOLE_API_BASE = 'https://opencode.ai/console/api';
const REQUEST_TIMEOUT_MS = 15_000;
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const ZEN_PROVIDER_ID = 'opencode';
const MODEL_PAGE_SIZE = 50;

const consoleNumber = z.unknown().transform((value) => toNumber(isString(value) ? asNonEmptyString(value) : value)).parse;
const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

class MalformedUsageError extends Error {}

export const parseConsoleBudget = z.unknown().transform((payload) => {
  const budgets: ConsoleBudget[] = [];
  for (const row of Array.isArray(payload) ? payload : []) {
    const budget = asFields(row);
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
}).parse;

const requestWindow = (requests: number): OpenCodeZenWindow => ({
  ...toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null }),
  resetAt: null,
  value: { kind: 'requests', count: requests },
});

const budgetWindow = (budget: ConsoleBudget): OpenCodeZenWindow => ({
  ...toUsageWindow({
    usedPercent: budget.limit === null ? null : clampPercent((budget.spent / budget.limit) * 100),
    windowSeconds: null,
    resetAt: budget.resetAt,
  }),
  resetAt: budget.resetAt,
  value: { kind: 'spend', spent: budget.spent, limit: budget.limit },
});

const fetchConsoleJson = async (path: string, credential: OpenCodeZenCredential, fetchImpl: typeof fetch) => {
  const headers: ConsoleHeaders = {
    Accept: 'application/json',
    Authorization: `Bearer ${'apiKey' in credential ? credential.apiKey : credential.accessToken}`,
    'x-opencode-session': 'openchamber-usage',
    'User-Agent': 'OpenChamber quota provider',
  };
  if ('orgID' in credential) headers['x-org-id'] = credential.orgID;
  const response = await fetchImpl(`${CONSOLE_API_BASE}${path}`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) throw new Error('OpenCode Zen authentication failed');
  if (!response.ok) throw new Error(`OpenCode Zen usage API returned HTTP ${response.status}`);
  return asFields(payload);
};

const parseModelPage = z.unknown().transform((payload) => {
  const page = asFields(payload);
  if (!page || !Array.isArray(page.items)) {
    throw new MalformedUsageError('OpenCode Zen model page could not be parsed');
  }
  const pageCount = hasFields(page.pageInfo) ? page.pageInfo.pageCount : undefined;
  if (pageCount === undefined) {
    if (page.items.length >= MODEL_PAGE_SIZE) {
      throw new MalformedUsageError('OpenCode Zen model pagination could not be parsed');
    }
  } else if (!isSafePageCount(pageCount) || pageCount < 0) {
    throw new MalformedUsageError('OpenCode Zen model pagination could not be parsed');
  }
  const models = new Map<string, { requests: number }>();
  let requests = 0;
  for (const item of page.items) {
    const entry = asFields(item);
    const provider = asNonEmptyString(entry?.provider);
    if (!provider) throw new MalformedUsageError('OpenCode Zen model page could not be parsed');
    if (provider !== ZEN_PROVIDER_ID) continue;
    const model = asNonEmptyString(entry?.model);
    const count = consoleNumber(entry?.totalRequests);
    if (!model || count === null || count < 0) {
      throw new MalformedUsageError('OpenCode Zen model page could not be parsed');
    }
    const current = models.get(model);
    if (current) current.requests += count;
    else models.set(model, { requests: count });
    requests += count;
  }
  return { models, requests, pageCount: pageCount ?? 1 };
}).parse;

const fetchModelsForRange = async (range: string, credential: OpenCodeZenCredential, fetchImpl: typeof fetch) => {
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

const readUsageRange = async (range: string, credential: OpenCodeZenCredential, fetchImpl: typeof fetch) => {
  try {
    return await fetchModelsForRange(range, credential, fetchImpl);
  } catch (error) {
    if (error instanceof MalformedUsageError) return null;
    throw error;
  }
};

export const fetchOpenCodeZenUsage = async (credential: OpenCodeZenCredential, fetchImpl = fetch) => {
  const [daily, weekly, monthly, budgetPayload] = await Promise.all([
    readUsageRange('24h', credential, fetchImpl),
    readUsageRange('7d', credential, fetchImpl),
    readUsageRange('30d', credential, fetchImpl),
    fetchConsoleJson('/budgets/service-accounts/status', credential, fetchImpl).catch(() => null),
  ]);
  const windows: Record<string, OpenCodeZenWindow> = {};
  if (daily) windows.daily = requestWindow(daily.requests);
  if (weekly) windows.weekly = requestWindow(weekly.requests);
  if (monthly) windows.monthly = requestWindow(monthly.requests);
  for (const budget of parseConsoleBudget(budgetPayload)) {
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
