import { readOpenCodeCredentials } from '../../opencode/auth.js';
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

export const providerId = 'opencode-go';
export const providerName = 'OpenCode Go';
const aliases = ['opencode-go'];

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
const REQUEST_TIMEOUT_MS = 15_000;

const API_KEY_WINDOW_FIELDS = {
  '5h': 'rolling',
  weekly: 'weekly',
  monthly: 'monthly',
};

const CONSOLE_WINDOW_METERS = {
  '5h': 'fiveHour',
  weekly: 'week',
  monthly: 'month',
};

const clampPercent = (value) => Math.min(100, Math.max(0, value));

export const parseOpenCodeGoUsage = (payload) => {
  const usage = asObject(payload) ? asObject(payload.usage) : null;
  if (!usage) return {};
  const windows = {};
  for (const [key, field] of Object.entries(API_KEY_WINDOW_FIELDS)) {
    const entry = asObject(usage[field]);
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
};

const toMicroCents = (value) => {
  const amount = toNumber(value);
  if (amount === null || amount < 0) return null;
  return amount;
};

export const parseConsoleGoUsage = (payload) => {
  const access = asObject(payload) ? asObject(payload.access) : null;
  const meters = access ? asObject(access.meters) : null;
  if (!meters) return {};
  const windows = {};
  for (const [key, meterName] of Object.entries(CONSOLE_WINDOW_METERS)) {
    const meter = asObject(meters[meterName]);
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
};

export const parseConsoleBillingBalance = (payload) => {
  const microCents = toMicroCents(asObject(payload)?.availableMicroCents);
  if (microCents === null) return null;
  return microCents / MICRO_CENTS_PER_DOLLAR;
};

const isExpiredKeyResponse = async (response) => {
  const payload = asObject(await response.json().catch(() => null));
  return asObject(payload?.error)?.code === 'api_key_expired';
};

export const fetchOpenCodeGoUsage = async (apiKey, fetchImpl = fetch, { consoleKey = false } = {}) => {
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
    throw new Error('OpenCode Go authentication failed');
  }
  if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`);
  const windows = parseOpenCodeGoUsage(await response.json().catch(() => null));
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

// external: #5278 Console meters retain the fractional usage that the usage API floors away.
const fetchConsoleGoUsageWithKey = async (apiKey, fetchImpl = fetch) => {
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
    const payload = await response.json().catch(() => null);
    if (!asObject(payload) || !CONSOLE_PRODUCTS.has(payload.product)) return null;
    const windows = parseConsoleGoUsage(payload);
    return Object.keys(windows).length > 0 ? windows : null;
  } catch {
    return null;
  }
};

const isConsoleSignInExpired = (expires) => expires !== null && expires > 0 && expires <= Date.now();

export const fetchConsoleGoUsage = async ({ access, orgID, expires }, fetchImpl = fetch) => {
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
  const payload = await response.json().catch(() => null);
  if (!asObject(payload)) throw new Error('OpenCode Console Go status returned an unreadable response');
  // external: #6779 Ended Go subscriptions retain the Go product and omit access.
  if (!CONSOLE_PRODUCTS.has(payload.product) || !asObject(payload.access)) {
    throw new Error(NO_CONSOLE_SUBSCRIPTION);
  }
  const windows = parseConsoleGoUsage(payload);
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

export const fetchConsoleBillingBalance = async ({ access, orgID }, fetchImpl = fetch) => {
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

const readKey = (entry) => asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);

const getApiKey = (auth) => {
  const own = readKey(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  if (own) return { key: own, consoleKey: false };
  const consoleEntry = normalizeAuthEntry(getAuthEntry(auth, [CONSOLE_INTEGRATION_ID]));
  if (!consoleEntry || consoleEntry.type === 'oauth') return null;
  const key = readKey(consoleEntry);
  return key ? { key, consoleKey: true } : null;
};

const getConsoleCredential = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, [CONSOLE_INTEGRATION_ID]));
  if (!entry || entry.type !== 'oauth') return null;
  const access = asNonEmptyString(entry.access);
  const orgID = asNonEmptyString(entry.orgID);
  if (!access || entry.server !== CONSOLE_SERVER || !orgID || !ORGANIZATION_ID_PATTERN.test(orgID)) return null;
  const expires = toNumber(entry.expires);
  return { access, orgID, expires };
};

export const isConfigured = (auth) => Boolean(getConsoleCredential(auth) || getApiKey(auth));

const fetchGoQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch } = {}) => {
  try {
    deleteLegacyOpenCodeGoCredential();
    const auth = await readAuth();
    const consoleCredential = getConsoleCredential(auth);
    const apiKey = getApiKey(auth);
    let consoleFailure = null;
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
        return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: usageWindows } });
      } catch (consoleError) {
        if (!apiKey) throw consoleError;
        consoleFailure = consoleError;
      }
    }
    if (!apiKey) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
    const windows = await fetchConsoleGoUsageWithKey(apiKey.key, fetchImpl)
      ?? await fetchOpenCodeGoUsage(apiKey.key, fetchImpl, { consoleKey: apiKey.consoleKey }).catch((keyError) => {
        throw consoleFailure && keyError.message === API_KEY_EXPIRED ? consoleFailure : keyError;
      });
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};

export const fetchQuota = async ({ readBudgets = readConsoleBudgets, ...options } = {}) => {
  const [result, consoleBudgets] = await Promise.all([fetchGoQuota(options), readBudgets()]);
  return withConsoleBudgets(result, consoleBudgets);
};
