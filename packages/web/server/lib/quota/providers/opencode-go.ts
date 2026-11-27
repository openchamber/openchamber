import { z } from 'zod';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import type { UsageWindow } from '../utils/contracts.js';
import type { ConsoleBudgetsRead } from '../console-budgets.js';
import { deleteLegacyOpenCodeGoCredential } from '../credentials/store.js';
import { readConsoleBudgets, withConsoleBudgets } from '../console-budgets.js';
import {
  asNonEmptyString,
  asObject,
  buildResult,
  formatMoney,
  getAuthEntry,
  normalizeAuthEntry,
  toNumber,
  toTimestamp,
  toUsageWindow,
} from '../utils/index.js';

export interface ConsoleGoCredential {
  access: string;
  orgID: string;
  expires: number | null;
}

export interface OpenCodeGoQuotaDependencies {
  readAuth?: () => LegacyAuthFile | Promise<LegacyAuthFile>;
  fetchImpl?: typeof fetch;
  readBudgets?: () => ConsoleBudgetsRead | null | Promise<ConsoleBudgetsRead | null>;
}

interface GoPayload {
  usage?: unknown;
  access?: unknown;
  meters?: unknown;
  availableMicroCents?: unknown;
  error?: unknown;
  code?: unknown;
  product?: unknown;
}

interface ApiKeyMeters {
  rolling?: unknown;
  weekly?: unknown;
  monthly?: unknown;
}

interface ConsoleMeters {
  fiveHour?: unknown;
  week?: unknown;
  month?: unknown;
}

interface GoMeter {
  percent?: unknown;
  resetsAt?: unknown;
  limitMicroCents?: unknown;
  usedMicroCents?: unknown;
}

interface GoAuthFields {
  label?: unknown;
  key?: unknown;
  token?: unknown;
  type?: unknown;
  access?: unknown;
  orgID?: unknown;
  server?: unknown;
  expires?: unknown;
}

interface ConsoleFailure {
  error?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => asObject(value) !== null;
const asPayload = z.custom<GoPayload | null>(isObject).catch(null).parse;
const asApiKeyMeters = z.custom<ApiKeyMeters | null>(isObject).catch(null).parse;
const asConsoleMeters = z.custom<ConsoleMeters | null>(isObject).catch(null).parse;
const asMeter = z.custom<GoMeter | null>(isObject).catch(null).parse;
const asAuthFields = z.custom<GoAuthFields | null>(isObject).catch(null).parse;
const isString = (value: unknown): value is string => typeof value === 'string';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode Go';

const API_KEY_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_STATUS_URL = 'https://opencode.ai/console/api/go/status';
const CONSOLE_BILLING_STATUS_URL = 'https://opencode.ai/console/api/billing/status';
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const CONSOLE_SERVER = 'https://opencode.ai/console';
const CONSOLE_INTEGRATION_ID = 'opencode';
const ORGANIZATION_ID_PATTERN = /^(?:org|wrk)_[A-Za-z0-9]+$/;
const CONSOLE_PRODUCTS = new Set(['go', 'go-plus', 'go-teams']);
const NO_CONSOLE_SUBSCRIPTION = 'No active OpenCode Go subscription on the selected Console account';
const API_KEY_EXPIRED = 'OpenCode Go key expired. Connect an OpenCode Console account on the OpenCode card in Providers.';
const KEY_AUTH_FAILED = 'OpenCode Go authentication failed';
const KEY_REFUSALS = new Set([NO_CONSOLE_SUBSCRIPTION, API_KEY_EXPIRED, KEY_AUTH_FAILED]);
const REQUEST_TIMEOUT_MS = 15_000;

const API_KEY_WINDOW_FIELDS = {
  '5h': 'rolling',
  weekly: 'weekly',
  monthly: 'monthly',
} satisfies Record<string, keyof ApiKeyMeters>;

const CONSOLE_WINDOW_METERS = {
  '5h': 'fiveHour',
  weekly: 'week',
  monthly: 'month',
} satisfies Record<string, keyof ConsoleMeters>;

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

export const parseOpenCodeGoUsage = z.unknown().transform((payload) => {
  const usage = asPayload(payload) ? asApiKeyMeters(asPayload(payload)?.usage) : null;
  if (!usage) return {};
  const windows: Record<string, UsageWindow> = {};
  for (const [key, field] of Object.entries(API_KEY_WINDOW_FIELDS)) {
    const entry = asMeter(usage[field]);
    if (!entry) continue;
    const usedPercent = toNumber(entry.percent);
    const resetAt = toTimestamp(entry.resetsAt);
    if (usedPercent === null || resetAt === null) continue;
    windows[key] = toUsageWindow({
      usedPercent: clampPercent(usedPercent),
      resetAt,
      windowSeconds: null,
    });
  }
  return windows;
}).parse;

const toMicroCents = z.unknown().transform((value) => {
  const amount = toNumber(value);
  if (amount === null || amount < 0) return null;
  return amount;
}).parse;

export const parseConsoleGoUsage = z.unknown().transform((payload) => {
  const access = asPayload(payload) ? asPayload(asPayload(payload)?.access) : null;
  const meters = access ? asConsoleMeters(access.meters) : null;
  if (!meters) return {};
  const windows: Record<string, UsageWindow> = {};
  for (const [key, meterName] of Object.entries(CONSOLE_WINDOW_METERS)) {
    const meter = asMeter(meters[meterName]);
    if (!meter) continue;
    const limit = toMicroCents(meter.limitMicroCents);
    const used = toMicroCents(meter.usedMicroCents);
    const resetAt = toTimestamp(meter.resetsAt);
    if (limit === null || limit <= 0 || used === null || resetAt === null) continue;
    windows[key] = toUsageWindow({
      usedPercent: clampPercent((used / limit) * 100),
      resetAt,
      windowSeconds: null,
    });
  }
  return windows;
}).parse;

export const parseConsoleBillingBalance = z.unknown().transform((payload) => {
  const microCents = toMicroCents(asPayload(payload)?.availableMicroCents);
  if (microCents === null) return null;
  return microCents / MICRO_CENTS_PER_DOLLAR;
}).parse;

const isExpiredKeyResponse = async (response: Response) => {
  const payload = asPayload(await response.json().catch(() => null));
  return asPayload(payload?.error)?.code === 'api_key_expired';
};

export const fetchOpenCodeGoUsage = async (apiKey: string, fetchImpl = fetch, { consoleKey = false } = {}) => {
  const response = await fetchImpl(API_KEY_USAGE_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'x-opencode-session': 'openchamber-usage',
      'User-Agent': 'OpenChamber quota provider',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 403 && consoleKey) throw new Error(NO_CONSOLE_SUBSCRIPTION);
  if (response.status === 401 && await isExpiredKeyResponse(response)) throw new Error(API_KEY_EXPIRED);
  if (response.status === 401 || response.status === 403) {
    throw new Error(KEY_AUTH_FAILED);
  }
  if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`);
  const windows = parseOpenCodeGoUsage(await response.json().catch(() => null));
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

const fetchConsoleGoUsageWithKey = async (apiKey: string, fetchImpl = fetch) => {
  try {
    const response = await fetchImpl(CONSOLE_STATUS_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'OpenChamber quota provider',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = asPayload(await response.json().catch(() => null));
    const product = payload?.product;
    if (!payload || !isString(product) || !CONSOLE_PRODUCTS.has(product)) return null;
    const windows = parseConsoleGoUsage(payload);
    return Object.keys(windows).length > 0 ? windows : null;
  } catch {
    return null;
  }
};

const isConsoleSignInExpired = (expires: number | null) => expires !== null && expires > 0 && expires <= Date.now();

export const fetchConsoleGoUsage = async ({ access, orgID, expires }: ConsoleGoCredential, fetchImpl = fetch) => {
  if (isConsoleSignInExpired(expires)) {
    throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  }
  const response = await fetchImpl(CONSOLE_STATUS_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${access}`,
      'x-org-id': orgID,
      'User-Agent': 'OpenChamber quota provider',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  }
  if (!response.ok) throw new Error(`OpenCode Console Go status API returned HTTP ${response.status}`);
  const payload = asPayload(await response.json().catch(() => null));
  if (!payload) throw new Error('OpenCode Console Go status returned an unreadable response');
  const product = payload.product;
  if (!isString(product) || !CONSOLE_PRODUCTS.has(product) || payload.access == null) {
    throw new Error(NO_CONSOLE_SUBSCRIPTION);
  }
  if (!asObject(payload.access)) throw new Error('OpenCode Console Go status returned an unreadable response');
  const windows = parseConsoleGoUsage(payload);
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

export const fetchConsoleBillingBalance = async ({ access, orgID }: Pick<ConsoleGoCredential, 'access' | 'orgID'>, fetchImpl = fetch) => {
  try {
    const response = await fetchImpl(CONSOLE_BILLING_STATUS_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${access}`,
        'x-org-id': orgID,
        'User-Agent': 'OpenChamber quota provider',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseConsoleBillingBalance(await response.json().catch(() => null));
  } catch {
    return null;
  }
};

const readKey = (entry: GoAuthFields | null) => asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);

interface GoApiKey {
  key: string;
  consoleKey: boolean;
  label: string | null;
}

const getApiKey = (auth: LegacyAuthFile, integrationID: typeof CONSOLE_INTEGRATION_ID | typeof providerId): GoApiKey | null => {
  const entry = asAuthFields(normalizeAuthEntry(getAuthEntry(auth, [integrationID])));
  if (!entry || entry.type === 'oauth') return null;
  const key = readKey(entry);
  return key ? { key, consoleKey: integrationID === CONSOLE_INTEGRATION_ID, label: asNonEmptyString(entry.label) } : null;
};

const getConsoleCredential = (auth: LegacyAuthFile) => {
  const entry = asAuthFields(normalizeAuthEntry(getAuthEntry(auth, [CONSOLE_INTEGRATION_ID])));
  if (!entry || entry.type !== 'oauth') return null;
  const access = asNonEmptyString(entry.access);
  const orgID = asNonEmptyString(entry.orgID);
  if (!access || entry.server !== CONSOLE_SERVER || !orgID || !ORGANIZATION_ID_PATTERN.test(orgID)) return null;
  const expires = toNumber(entry.expires);
  return { access, orgID, expires, label: asNonEmptyString(entry.label) };
};

export const isConfigured = (auth: LegacyAuthFile) => Boolean(getConsoleCredential(auth) || getApiKey(auth, CONSOLE_INTEGRATION_ID) || getApiKey(auth, providerId));

const fetchKeyUsage = async ({ key, consoleKey }: GoApiKey, fetchImpl: typeof fetch) => (
  await fetchConsoleGoUsageWithKey(key, fetchImpl) ?? fetchOpenCodeGoUsage(key, fetchImpl, { consoleKey })
);

const fetchGoQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch }: OpenCodeGoQuotaDependencies = {}) => {
  try {
    deleteLegacyOpenCodeGoCredential();
    const auth = await readAuth();
    const consoleCredential = getConsoleCredential(auth);
    const consoleKey = getApiKey(auth, CONSOLE_INTEGRATION_ID);
    const apiKey = getApiKey(auth, providerId);
    const consoleFailure: ConsoleFailure = {};
    if (consoleCredential) {
      try {
        const balanceRead = isConsoleSignInExpired(consoleCredential.expires)
          ? Promise.resolve(null)
          : fetchConsoleBillingBalance(consoleCredential, fetchImpl);
        const windows = await fetchConsoleGoUsage(consoleCredential, fetchImpl);
        const balance = await balanceRead;
        const usageWindows = balance === null
          ? windows
          : {
              ...windows,
              credits_balance: toUsageWindow({
                usedPercent: null,
                windowSeconds: null,
                resetAt: null,
                valueLabel: `$${formatMoney(balance)}`,
              }),
            };
        return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: usageWindows }, accountLabel: consoleCredential.label });
      } catch (consoleError) {
        if (!apiKey && !(consoleError instanceof Error && consoleError.message === NO_CONSOLE_SUBSCRIPTION)) throw consoleError;
        consoleFailure.error = consoleError;
      }
    } else if (consoleKey) {
      try {
        const windows = await fetchKeyUsage(consoleKey, fetchImpl);
        return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows }, accountLabel: consoleKey.label });
      } catch (consoleError) {
        if (!(consoleError instanceof Error) || !(apiKey ? KEY_REFUSALS.has(consoleError.message) : consoleError.message === NO_CONSOLE_SUBSCRIPTION)) throw consoleError;
      }
    }
    if (!apiKey) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
    const windows = await fetchKeyUsage(apiKey, fetchImpl).catch((keyError) => {
      throw consoleFailure.error && keyError.message === API_KEY_EXPIRED ? consoleFailure.error : keyError;
    });
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows }, accountLabel: apiKey.label });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};

export const fetchQuota = async ({ readBudgets = readConsoleBudgets, ...options }: OpenCodeGoQuotaDependencies = {}) => {
  const [result, consoleBudgets] = await Promise.all([fetchGoQuota(options), readBudgets()]);
  return withConsoleBudgets(result, consoleBudgets);
};
