import { z } from 'zod';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/config-files.js';
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
import type { UsageWindow } from '../utils/contracts.js';

interface OpenRouterFields {
  key?: unknown;
  token?: unknown;
  data?: unknown;
  is_management_key?: unknown;
  limit?: unknown;
  limit_remaining?: unknown;
  usage_monthly?: unknown;
  byok_usage_monthly?: unknown;
  limit_reset?: unknown;
}

const hasFields = (value: unknown): value is OpenRouterFields => value !== null && value !== undefined;
const asFields = z.custom<OpenRouterFields | null>(hasFields).catch(null).parse;
const isObject = (value: unknown): value is OpenRouterFields => asObject(value) !== null;
const asData = z.custom<OpenRouterFields | null>(isObject).catch(null).parse;

export const providerId = 'openrouter';
export const providerName = 'OpenRouter';
const aliases = ['openrouter'];
const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const PERIOD_SECONDS = { daily: 86400, weekly: 604800, monthly: 30 * 86400 };
const isPeriodKey = (key: string): key is keyof typeof PERIOD_SECONDS => Object.hasOwn(PERIOD_SECONDS, key);

const resolveQuotaBase = () => {
  try {
    const { mergedConfig } = readConfigLayers();
    const readBaseURL = (sectionKey: string) => {
      const section = mergedConfig?.[sectionKey];
      return isRecord(section) ? asNonEmptyString(toProviderEntity(section.openrouter).settings?.baseURL) : null;
    };
    const base = readBaseURL('providers') ?? readBaseURL('provider');
    return base?.replace(/\/+$/, '') || null;
  } catch {
    return null;
  }
};

export const resolveResetAt = <Period>(limitReset: Period, nowMs: number) => {
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

export const isConfigured = (auth: LegacyAuthFile) => {
  const entry = asFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  return Boolean(entry?.key || entry?.token);
};

const toAmount = z.unknown().transform((value) => (String(value).trim() === '' ? null : toNumber(value))).parse;

const toSpendAmount = z.unknown().transform((value) => {
  const amount = toAmount(value);
  return amount !== null && amount >= 0 ? amount : null;
}).parse;

const spendWindow = (spent: number | null) => toUsageWindow({
  usedPercent: null,
  windowSeconds: null,
  resetAt: null,
  value: { kind: 'spend', spent, limit: null }
});

export const fetchQuota = async () => {
  const auth = await readOpenCodeCredentials();
  const entry = asFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
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

    const payload = asFields(await response.json());
    const data = asData(payload?.data);

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

    const limit = toAmount(data.limit);
    const limitRemaining = toAmount(data.limit_remaining);
    const usageMonthly = toSpendAmount(data.usage_monthly);
    const byokMonthly = toSpendAmount(data.byok_usage_monthly);
    if ((limit === null || limitRemaining === null) && usageMonthly === null && byokMonthly === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const nowMs = Date.now();
    const windows: Record<string, UsageWindow> = {};

    if (limit !== null && (limitRemaining !== null || limit > 0)) {
      let windowKey: string;
      let windowSeconds: number | null;
      let resetAt: number | null;

      const periodKey = String(data.limit_reset);
      if (isPeriodKey(periodKey)) {
        windowKey = periodKey;
        windowSeconds = PERIOD_SECONDS[periodKey];
        resetAt = resolveResetAt(periodKey, nowMs);
      } else {
        windowKey = 'key_limit';
        windowSeconds = null;
        resetAt = null;
      }

      if (limitRemaining === null) {
        windows[windowKey] = toUsageWindow({
          usedPercent: null,
          windowSeconds,
          resetAt,
          value: { kind: 'spend', spent: null, limit }
        });
      } else {
        const used = Math.max(0, limit - limitRemaining);
        const percent = limit > 0 ? (used / limit) * 100 : null;
        windows[windowKey] = toUsageWindow({
          usedPercent: percent === null ? null : Math.min(100, percent),
          windowSeconds,
          resetAt,
          valueLabel: `$${formatMoney(used)} / $${formatMoney(limit)}`
        });
      }
    }

    windows.monthly_total = toUsageWindow({
      usedPercent: null,
      windowSeconds: PERIOD_SECONDS.monthly,
      resetAt: resolveResetAt('monthly', nowMs),
      value: {
        kind: 'spend',
        spent: usageMonthly !== null && byokMonthly !== null ? usageMonthly + byokMonthly : null,
        limit: null
      }
    });
    if (usageMonthly !== 0) windows.monthly_credits = spendWindow(usageMonthly);
    if (byokMonthly !== 0) windows.monthly_byok = spendWindow(byokMonthly);

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
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
