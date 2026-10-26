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

// OpenCode Go has two credential shapes. An API key, stored under the
// `opencode-go` integration or the shared `opencode` one, reads the Console Go
// status and falls back to the legacy usage API. A Console sign-in lives on the
// shared `opencode` integration and its OAuth access token is not
// interchangeable with that key; it reads the Console Go status with its
// organization.
const API_KEY_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_STATUS_URL = 'https://opencode.ai/console/api/go/status';
// The Go status response carries only the three meters. The spendable credit
// balance that overage draws from lives on the Console billing status, read with
// the same Console token and organization.
const CONSOLE_BILLING_STATUS_URL = 'https://opencode.ai/console/api/billing/status';
// The Console counts one cent as 1_000_000 micro-cents, so a dollar is 100_000_000.
const MICRO_CENTS_PER_DOLLAR = 100_000_000;
const CONSOLE_SERVER = 'https://opencode.ai/console';
const CONSOLE_INTEGRATION_ID = 'opencode';
// Console workspaces carry a `wrk_` id on current sign-ins; older stored
// credentials still carry `org_`, so both prefixes count and nothing else.
const ORGANIZATION_ID_PATTERN = /^(?:org|wrk)_[A-Za-z0-9]+$/;
const CONSOLE_PRODUCTS = new Set(['go', 'go-plus']);
const NO_CONSOLE_SUBSCRIPTION = 'No active OpenCode Go subscription on the selected Console account';
// Console keys expire and nothing can renew them, while a Console sign-in is
// renewed by OpenCode and serves OpenCode Go too. Providers offers that sign-in
// as the "OpenCode Console account" row on the OpenCode card.
const API_KEY_EXPIRED = 'OpenCode Go key expired. Connect an OpenCode Console account on the OpenCode card in Providers.';
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

// The usage API answers an expired key with 401 and
// `{ error: { code: 'api_key_expired' } }`; any other 401 stays a plain
// authentication failure.
const isExpiredKeyResponse = async (response) => {
  const payload = asObject(await response.json().catch(() => null));
  return asObject(payload?.error)?.code === 'api_key_expired';
};

/**
 * `consoleKey` marks a key from the shared `opencode` integration. The usage
 * API accepts any key of a Console workspace and answers 403 when that
 * workspace has no Go subscription, so for such a key a 403 is an absent
 * subscription rather than a bad key.
 */
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

/**
 * An API key also opens the Console Go status, without `x-org-id`: the key
 * belongs to one workspace. Its meters carry the exact fraction the Console
 * page rounds, while the usage API reports a floored integer percent that sits
 * up to a point below the page. Best-effort: any failure returns null and the
 * usage API answers instead, so its error messages stay the API-key contract.
 */
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
    throw new Error(NO_CONSOLE_SUBSCRIPTION);
  }
  const windows = parseConsoleGoUsage(payload);
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

/**
 * Best-effort. The Go meters are the authoritative result, so a billing read
 * that fails (network, HTTP, malformed, or an expired token) drops the credits
 * row instead of failing the refresh or reporting a $0.00 balance. It runs
 * alongside the Go read, so a slow billing endpoint never delays the meters by
 * more than the slower of the two requests; its result is used only when the Go
 * read succeeds.
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

const readKey = (entry) => asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);

/**
 * The key for the usage API. A key on `opencode-go` comes first. Otherwise an
 * API key on the shared `opencode` integration serves Go too: OpenCode loads
 * the Console workspace's providers with it and binds OpenCode Go to that
 * integration when the workspace has Go. Providers lists it under OpenCode Go
 * too.
 */
const getApiKey = (auth) => {
  const own = readKey(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  if (own) return { key: own, consoleKey: false };
  const consoleEntry = normalizeAuthEntry(getAuthEntry(auth, [CONSOLE_INTEGRATION_ID]));
  if (!consoleEntry || consoleEntry.type === 'oauth') return null;
  const key = readKey(consoleEntry);
  return key ? { key, consoleKey: true } : null;
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
    // API key is the fallback for accounts without one, and for a Console read
    // that fails (no Go in that org, an endpoint change, a hiccup). An API key
    // on `opencode` cannot coexist with the sign-in: one credential is active
    // per integration.
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
        // The expired-key advice is to connect a Console account; with one
        // already connected, its own failure is the actionable error.
        throw consoleFailure && keyError.message === API_KEY_EXPIRED ? consoleFailure : keyError;
      });
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};
