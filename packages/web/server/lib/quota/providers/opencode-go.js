import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { deleteLegacyOpenCodeGoCredential } from '../credentials/store.js';
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

// OpenCode Go has two credential shapes. A service-account key stored under the
// `opencode-go` integration uses the legacy usage API. A Console sign-in lives
// on the shared `opencode` integration and its OAuth access token is not
// interchangeable with that key, so it uses the Console Go status endpoint.
const API_KEY_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_STATUS_URL = 'https://opencode.ai/console/api/go/status';
// The Go status response carries only the three meters. The spendable credit
// balance that overage draws from lives on the Console billing status, read with
// the same Console token and organization.
const CONSOLE_BILLING_STATUS_URL = 'https://opencode.ai/console/api/billing/status';
const MICRO_CENTS_PER_DOLLAR = 1_000_000;
const CONSOLE_SERVER = 'https://opencode.ai/console';
const CONSOLE_INTEGRATION_ID = 'opencode';
const ORGANIZATION_ID_PATTERN = /^org_[A-Za-z0-9]+$/;
const CONSOLE_PRODUCTS = new Set(['go', 'go-plus']);
const REQUEST_TIMEOUT_MS = 15_000;

const API_KEY_WINDOW_FIELDS = {
  '5h': 'rolling',
  weekly: 'weekly',
  monthly: 'monthly',
};

// The Console page meters. `week` maps to the existing `weekly` window key the
// UI already labels, matching the API-key path.
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

/**
 * The Console meters report integer micro-cents as decimal strings. A missing,
 * negative, or unparseable amount is not usable data, and a zero limit would
 * divide by zero, so each is rejected on its own without discarding the other
 * windows.
 */
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

/**
 * The billing status reports the spendable balance as integer micro-cents in a
 * decimal string. A missing, negative, or unparseable amount is not a $0.00
 * balance, so it yields no credits row at all.
 */
export const parseConsoleBillingBalance = (payload) => {
  const microCents = toMicroCents(asObject(payload)?.availableMicroCents);
  if (microCents === null) return null;
  return microCents / MICRO_CENTS_PER_DOLLAR;
};

export const fetchOpenCodeGoUsage = async (apiKey, fetchImpl = fetch) => {
  const response = await fetchImpl(API_KEY_USAGE_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'x-opencode-session': 'openchamber-usage',
      'User-Agent': 'OpenChamber quota provider',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('OpenCode Go authentication failed');
  }
  if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`);
  const windows = parseOpenCodeGoUsage(await response.json().catch(() => null));
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

export const fetchConsoleGoUsage = async ({ access, orgID, expires }, fetchImpl = fetch) => {
  if (expires !== null && expires > 0 && expires <= Date.now()) {
    throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  }
  const response = await fetchImpl(CONSOLE_STATUS_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${access}`,
      'x-org-id': orgID,
      'User-Agent': 'OpenChamber quota provider',
    },
    // The bearer token belongs to opencode.ai/console; never follow a redirect
    // that would forward it to another origin.
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('OpenCode Console sign-in expired. Sign in again in Providers.');
  }
  if (!response.ok) throw new Error(`OpenCode Console Go status API returned HTTP ${response.status}`);
  const payload = await response.json().catch(() => null);
  if (!asObject(payload)) throw new Error('OpenCode Console Go status returned an unreadable response');
  if (!CONSOLE_PRODUCTS.has(payload.product)) {
    throw new Error('No active OpenCode Go subscription on the selected Console account');
  }
  const windows = parseConsoleGoUsage(payload);
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

/**
 * Best-effort. The Go meters are the authoritative result, so a billing read
 * that fails (network, HTTP, malformed, or an expired token) drops the credits
 * row instead of failing the refresh or reporting a $0.00 balance. It runs only
 * after a successful Go read, so the token is already known to be valid.
 */
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

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
};

/**
 * The active OpenCode Console OAuth credential, only when it is a Console
 * sign-in (`server` is the Console origin and an organization is selected).
 * OpenCode marks exactly one credential active per integration and credentials
 * are global, so this is the selected account and organization; reading it per
 * call follows a switch instead of caching the previous account.
 */
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

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch } = {}) => {
  try {
    deleteLegacyOpenCodeGoCredential();
    const auth = await readAuth();
    // A Console sign-in serves OpenCode Go once it exists; the `opencode-go`
    // service key is the fallback for accounts without one, and for a Console
    // read that fails (no Go in that org, an endpoint change, a hiccup).
    const consoleCredential = getConsoleCredential(auth);
    const apiKey = getApiKey(auth);
    if (consoleCredential) {
      try {
        const windows = await fetchConsoleGoUsage(consoleCredential, fetchImpl);
        const balance = await fetchConsoleBillingBalance(consoleCredential, fetchImpl);
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
      }
    }
    if (!apiKey) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
    const windows = await fetchOpenCodeGoUsage(apiKey, fetchImpl);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};
