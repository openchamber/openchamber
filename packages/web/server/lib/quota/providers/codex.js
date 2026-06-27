import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  formatMoney
} from '../utils/index.js';

export const providerId = 'codex';
export const providerName = 'Codex';
const aliases = ['openai', 'codex', 'chatgpt'];

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;
  const accountId = entry?.accountId;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {})
    };
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired \u2014 please re-authenticate with OpenAI'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const primary = payload?.rate_limit?.primary_window ?? null;
    const secondary = payload?.rate_limit?.secondary_window ?? null;
    const credits = payload?.credits ?? null;

    const windows = {};
    if (primary) {
      windows['5h'] = toUsageWindow({
        usedPercent: toNumber(primary.used_percent),
        windowSeconds: toNumber(primary.limit_window_seconds),
        resetAt: primary.reset_after_seconds != null ? Date.now() + Number(primary.reset_after_seconds) * 1000 : null,
        suffix: 'primary',
        trendKey: 'codex:5h'
      });
    }
    if (secondary) {
      windows['weekly'] = toUsageWindow({
        usedPercent: toNumber(secondary.used_percent),
        windowSeconds: toNumber(secondary.limit_window_seconds),
        resetAt: secondary.reset_after_seconds != null ? Date.now() + Number(secondary.reset_after_seconds) * 1000 : null,
        suffix: 'weekly cap',
        trendKey: 'codex:weekly'
      });
    }
    if (credits) {
      const balance = toNumber(credits.balance);
      const unlimited = Boolean(credits.unlimited);
      const label = unlimited
        ? 'Unlimited'
        : balance !== null
          ? `$${formatMoney(balance)}`
          : null;
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: label,
        suffix: 'balance',
        trendKey: 'codex:credits_balance'
      });
    }

    const usage = { windows, subtitle: 'ChatGPT subscription' };
    if (credits?.unlimited) {
      usage.note = 'Unlimited plan';
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage,
      accountKey: accountId ?? undefined
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
