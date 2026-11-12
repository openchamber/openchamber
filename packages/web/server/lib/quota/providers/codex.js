import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  formatMoney,
  asNonEmptyString
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

// A fixed origin with a bearer token: a redirect would carry the token elsewhere.
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
        ? String(balance)
        : null;
    windows.credits_balance = toUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: label
    });
  }

  // Only an explicit USD unit makes this allowance a dollar amount.
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

/**
 * Usage read with the Codex CLI's sign-in when OpenCode's cannot read it. The
 * numbers are always named by the CLI account's email (from the answer, else
 * from the CLI token): OpenCode's token-sharing token says nothing about whose
 * it is, so another account's limits could otherwise pass for the user's own.
 * A CLI read that fails in any way leaves the message.
 */
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

    // A 401 is not always an expired token. OpenCode's `chatgpt-token-sharing`
    // sign-in ("Sign in with ChatGPT") holds a token that only reaches the
    // Responses route, and the usage endpoint refuses it with an
    // access-enforcement body (`rejected_by_access_enforcement`). OpenAI has no
    // usage endpoint for that sign-in, so the numbers come from the Codex CLI's
    // own sign-in on this machine when it has one; without it the message
    // sends the user to the ChatGPT usage page instead of asking to sign in again.
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
