import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  asNonEmptyString,
  formatCredits,
  formatMoney
} from '../utils/index.js';
import { readCodexCliLogin, signInEmailOf } from './codex-cli.js';

export const providerId = 'codex';
export const providerName = 'Codex';
const aliases = ['openai', 'codex', 'chatgpt'];

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export const isConfigured = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

const requestUsage = (accessToken, accountId) => fetch(USAGE_URL, {
  method: 'GET',
  redirect: 'error',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {})
  }
});

const usageWindowsOf = (payload) => {
  const primary = payload?.rate_limit?.primary_window ?? null;
  const secondary = payload?.rate_limit?.secondary_window ?? null;
  const credits = payload?.credits ?? null;

  const windows = {};
  if (primary) {
    const windowSeconds = toNumber(primary.limit_window_seconds);
    windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
      usedPercent: toNumber(primary.used_percent),
      windowSeconds,
      resetAt: toTimestamp(primary.reset_at)
    });
  }
  if (secondary) {
    const windowSeconds = toNumber(secondary.limit_window_seconds);
    windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
      usedPercent: toNumber(secondary.used_percent),
      windowSeconds,
      resetAt: toTimestamp(secondary.reset_at)
    });
  }
  if (credits) {
    const balance = toNumber(credits.balance);
    const unlimited = Boolean(credits.unlimited);
    const label = unlimited
      ? 'Unlimited'
      : balance !== null
        ? formatCredits(balance)
        : null;
    windows.credits_balance = toUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: label
    });
  }

  if (payload?.spend_control?.individual_limit) {
    const spendLimit = payload.spend_control.individual_limit;
    const used = toNumber(spendLimit.used);
    const limit = toNumber(spendLimit.limit);
    const isUsd = spendLimit.unit === 'usd';
    const valueLabel = used !== null && limit !== null
      ? isUsd
        ? `$${formatMoney(used)} / $${formatMoney(limit)}`
        : `${used.toFixed(0)} / ${limit.toFixed(0)} used`
      : null;
    windows[isUsd ? 'usage' : 'credits'] = toUsageWindow({
      usedPercent: toNumber(spendLimit.used_percent),
      windowSeconds: null,
      resetAt: null,
      valueLabel
    });
  }
  return windows;
};

const usageResult = (payload, accountLabel = null) => buildResult({
  providerId,
  providerName,
  ok: true,
  configured: true,
  usage: { windows: usageWindowsOf(payload) },
  accountLabel
});

const failure = (error, configured = true) => buildResult({ providerId, providerName, ok: false, configured, error });

const usageFromCodexCli = async () => {
  const login = readCodexCliLogin();
  if (!login) return null;
  const response = await requestUsage(login.accessToken, login.accountId).catch(() => null);
  if (!response?.ok) return null;
  const payload = await response.json();
  return usageResult(payload, asNonEmptyString(payload?.email) ?? signInEmailOf(login.accessToken));
};

export const fetchQuota = async () => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;
  const accountId = entry?.accountId;

  if (!accessToken) return failure('Not configured', false);

  try {
    const response = await requestUsage(accessToken, accountId);
    if (response.ok) return usageResult(await response.json());
    if (response.status !== 401) return failure(`API error: ${response.status}`);

    const body = await response.json().catch(() => null);
    if (asNonEmptyString(body?.error?.type) !== 'rejected_by_access_enforcement') {
      return failure('Session expired — please re-authenticate with OpenAI');
    }
    return await usageFromCodexCli()
      ?? failure('OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.');
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Request failed');
  }
};
