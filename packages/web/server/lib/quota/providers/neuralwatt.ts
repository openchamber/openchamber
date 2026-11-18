import { z } from 'zod';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import type { UsageWindow } from '../utils/contracts.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  formatMoney,
  asNonEmptyString
} from '../utils/index.js';

interface NeuralWattFields {
  key?: unknown;
  token?: unknown;
  subscription?: unknown;
  in_overage?: unknown;
  allowance?: unknown;
  balance?: unknown;
  credits_remaining_usd?: unknown;
  kwh_included?: unknown;
  kwh_used?: unknown;
  plan?: unknown;
  kwh_reset_date?: unknown;
  current_period_end?: unknown;
  spent_usd?: unknown;
  limit_usd?: unknown;
  period?: unknown;
  blocked?: unknown;
  reset_at?: unknown;
}

const hasFields = (value: unknown): value is NeuralWattFields => value !== null && value !== undefined;
const asFields = z.custom<NeuralWattFields | null>(hasFields).catch(null).parse;

export const providerId = 'neuralwatt';
export const providerName = 'NeuralWatt';
const aliases = ['neuralwatt'];
const NEURALWATT_QUOTA_URL = 'https://api.neuralwatt.com/v1/quota';

const periodToWindowSeconds = (period: string) => {
  if (period === 'daily') return 86400;
  if (period === 'weekly') return 604800;
  if (period === 'monthly' || period === 'month') return 30 * 86400;
  if (period === 'yearly' || period === 'year') return 365 * 86400;
  return null;
};

export const isConfigured = (auth: LegacyAuthFile) => {
  const entry = asFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  return Boolean(entry?.key || entry?.token);
};

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
    const response = await fetch(NEURALWATT_QUOTA_URL, {
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
        error: response.status === 401
          ? 'Session expired — please re-authenticate with NeuralWatt'
          : `API error: ${response.status}`
      });
    }

    const payload = asFields(await response.json());
    const subscription = asFields(payload?.subscription) ?? null;
    const inOverage = Boolean(subscription?.in_overage);
    const allowance = asFields(asFields(payload?.key)?.allowance) ?? null;
    const creditsRemaining = toNumber(asFields(payload?.balance)?.credits_remaining_usd);

    const windows: Record<string, UsageWindow> = {};

    if (subscription) {
      const kwhIncluded = toNumber(subscription.kwh_included);
      const kwhUsed = toNumber(subscription.kwh_used);
      const plan = asNonEmptyString(subscription.plan);
      const subKey = plan ?? 'plan_limit';
      const usedPercent = inOverage
        ? 100
        : (kwhIncluded !== null && kwhIncluded > 0 && kwhUsed !== null
            ? Math.max(0, Math.min(100, (kwhUsed / kwhIncluded) * 100))
            : null);
      const subResetAt = toTimestamp(subscription.kwh_reset_date) ?? toTimestamp(subscription.current_period_end);
      windows[subKey] = toUsageWindow({
        usedPercent,
        windowSeconds: null,
        resetAt: subResetAt
      });
    }

    if (allowance) {
      const spent = toNumber(allowance.spent_usd);
      const limit = toNumber(allowance.limit_usd);
      const effectiveSpent = spent ?? 0;
      const effectiveLimit = limit !== null && creditsRemaining !== null
        ? Math.min(limit, creditsRemaining + effectiveSpent)
        : (limit ?? creditsRemaining);
      const period = asNonEmptyString(allowance.period);
      const blocked = Boolean(allowance.blocked);
      const usedPercent = blocked
        ? 100
        : (spent !== null && effectiveLimit !== null && effectiveLimit > 0
            ? Math.max(0, Math.min(100, (spent / effectiveLimit) * 100))
            : null);
      const periodKey = (period === 'daily' || period === 'weekly' || period === 'monthly' || period === 'month')
        ? (period === 'month' ? 'monthly' : period)
        : 'billing_cycle';
      const resetAt = toTimestamp(allowance.reset_at);
      const windowSeconds = period ? periodToWindowSeconds(period) : null;
      windows[periodKey] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt
      });
    } else if (creditsRemaining !== null) {
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(creditsRemaining)}`
      });
    }

    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError' && timeoutSignal.aborted;
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
