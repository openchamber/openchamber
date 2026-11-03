/**
 * One Provider quota fetch
 *
 * API: https://api.oneprovider.dev/v1/usage
 *
 * One Provider is a prepaid, quota-limited gateway: the account holds a USD
 * balance and every request draws from it. `GET /v1/usage` answers the whole
 * picture in one read:
 *
 *   { mode: "quota_limited", isValid, status, planName,
 *     quota: { limit, used, remaining, unit: "USD" },
 *     remaining, unit, expires_at, days_until_expiry, usage: {...} }
 *
 * The USD balance becomes a `credits_balance` window (a money valueLabel, no
 * percent, no reset) so the panel renders it exactly like the Codex credit
 * row. The spend against the allowance becomes a `monthly` window: used
 * percent of `quota.limit`, resetting when the quota expires.
 *
 * Anything missing or non-finite drops its own window instead of reporting a
 * `$0.00` balance. An expired or exhausted account still answers 200 with
 * `isValid: false`; that is a successful read of a spent account, not an
 * error, so the numbers stay visible.
 */
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/shared.js';
import {
  resolveConfigApiKey,
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  asNonEmptyString,
  formatMoney
} from '../utils/index.js';

export const providerId = 'one-provider';
export const providerName = 'One Provider';
const aliases = ['one-provider', 'oneprovider', 'one_provider'];
const DEFAULT_BASE_URL = 'https://api.oneprovider.dev';
const USAGE_PATH = '/v1/usage';
const MONTH_SECONDS = 30 * 24 * 60 * 60;

const readProviderConfig = () => {
  try {
    const { mergedConfig } = readConfigLayers();
    for (const alias of aliases) {
      const providerConfig = mergedConfig?.provider?.[alias];
      if (providerConfig) return providerConfig;
    }
  } catch {
    // Ignore config read errors; the defaults below still work.
  }
  return null;
};

const resolveBaseUrl = (providerConfig) => {
  const configured = asNonEmptyString(providerConfig?.settings?.baseURL)
    ?? asNonEmptyString(providerConfig?.options?.baseURL);
  const base = configured ?? DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
};

function getApiKey(auth, providerConfig) {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const fromAuth = entry?.key ?? entry?.token;
  if (fromAuth) return fromAuth;

  const apiKey = providerConfig?.options?.apiKey;
  if (apiKey) return resolveConfigApiKey(apiKey);

  return null;
}

export const isConfigured = (auth) => {
  try {
    return Boolean(getApiKey(auth, readProviderConfig()));
  } catch {
    return false;
  }
};

const buildWindows = (payload) => {
  const quota = payload?.quota ?? null;
  const windows = {};

  const remaining = toNumber(quota?.remaining ?? payload?.remaining);
  const limit = toNumber(quota?.limit);
  const used = toNumber(quota?.used);

  const remainingLabel = remaining !== null ? formatMoney(remaining) : null;
  if (remainingLabel !== null) {
    windows.credits_balance = toUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `$${remainingLabel}`
    });
  }

  if (limit !== null && limit > 0) {
    const spent = used !== null ? used : Math.max(0, limit - (remaining ?? 0));
    windows.monthly = toUsageWindow({
      usedPercent: Math.round((spent / limit) * 100),
      windowSeconds: MONTH_SECONDS,
      resetAt: payload?.expires_at ?? null
    });
  }

  return windows;
};

export const fetchQuota = async ({ readCredentials = readOpenCodeCredentials } = {}) => {
  const auth = await readCredentials();
  const providerConfig = readProviderConfig();
  const apiKey = getApiKey(auth, providerConfig);

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const url = `${resolveBaseUrl(providerConfig)}${USAGE_PATH}`;
  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Accept-Encoding': 'identity'
      },
      redirect: 'error',
      signal: timeoutSignal
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with One Provider'
          : `API error: ${response.status}`
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Invalid response from provider'
      });
    }

    const windows = buildWindows(payload);

    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const planLabel = asNonEmptyString(payload?.planName) ?? undefined;

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      planLabel
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};
