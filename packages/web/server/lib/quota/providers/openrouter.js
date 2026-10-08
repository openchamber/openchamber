import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/shared.js';
import { isRecord, toProviderEntity } from '../../opencode/config-v2.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  asObject,
  asNonEmptyString,
  formatMoney
} from '../utils/index.js';

export const providerId = 'openrouter';
export const providerName = 'OpenRouter';
const aliases = ['openrouter'];
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const PERIOD_SECONDS = { daily: 86400, weekly: 604800, monthly: 30 * 86400 };

// The stored key is valid for whichever gateway the configured baseURL points
// at, so the usage lookup must ride the same base as chat. The endpoint shape
// stays `<base>/key`; with nothing configured the base is OpenRouter itself.
// OpenCode takes the address from `settings.baseURL`, legacy `options.baseURL`
// or legacy `api`, and toProviderEntity folds all three. Each section is read
// on its own so a v2 entry without an address cannot hide a v1 address that
// another config file sets.
const resolveQuotaBase = () => {
  try {
    const { mergedConfig } = readConfigLayers();
    const readBaseURL = (sectionKey) => {
      const section = mergedConfig?.[sectionKey];
      return isRecord(section) ? asNonEmptyString(toProviderEntity(section.openrouter).settings?.baseURL) : null;
    };
    const base = readBaseURL('providers') ?? readBaseURL('provider');
    return base?.replace(/\/+$/, '') || null;
  } catch {
    // A config read failure must not take the default-endpoint lookup down.
    return null;
  }
};

export const resolveResetAt = (limitReset, nowMs) => {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (limitReset === 'daily') return Date.UTC(y, m, d + 1);
  if (limitReset === 'weekly') {
    const dow = now.getUTCDay();
    return Date.UTC(y, m, d + ((8 - dow) % 7 || 7));
  }
  if (limitReset === 'monthly') return Date.UTC(y, m + 1, 1);
  return null;
};

export const isConfigured = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async () => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(`${resolveQuotaBase() ?? OPENROUTER_API_BASE}/key`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity'
      },
      signal: timeoutSignal
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with OpenRouter'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const data = asObject(payload?.data);

    if (data === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    if (data.is_management_key === true) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Management key configured — quota needs an inference API key'
      });
    }

    const limit = toNumber(data.limit);
    const limitRemaining = toNumber(data.limit_remaining);
    if (limit !== null && limitRemaining === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const usageMonthly = toNumber(data.usage_monthly);
    if (limit === null && usageMonthly === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const nowMs = Date.now();
    let windowKey;
    let windowSeconds;
    let resetAt;
    let usedPercent;
    let valueLabel;

    if (limit === null) {
      windowKey = 'monthly';
      windowSeconds = PERIOD_SECONDS.monthly;
      resetAt = resolveResetAt('monthly', nowMs);
      usedPercent = null;
      valueLabel = `$${formatMoney(usageMonthly)} spent`;
    } else {
      const used = Math.max(0, limit - limitRemaining);
      const percent = limit > 0 ? (used / limit) * 100 : null;
      usedPercent = percent === null ? null : Math.min(100, percent);
      valueLabel = `$${formatMoney(used)} / $${formatMoney(limit)}`;

      if (Object.hasOwn(PERIOD_SECONDS, data.limit_reset)) {
        windowKey = data.limit_reset;
        windowSeconds = PERIOD_SECONDS[data.limit_reset];
        resetAt = resolveResetAt(data.limit_reset, nowMs);
      } else {
        windowKey = 'credits';
        windowSeconds = null;
        resetAt = null;
      }
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: {
        windows: {
          [windowKey]: toUsageWindow({
            usedPercent,
            windowSeconds,
            resetAt,
            valueLabel
          })
        }
      }
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
