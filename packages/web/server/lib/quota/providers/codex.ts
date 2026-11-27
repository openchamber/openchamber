import { z } from 'zod';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import type { UsageWindow } from '../utils/contracts.js';
import { retryAfterAt } from '../utils/retry-after.js';
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

interface CodexFields {
  access?: unknown;
  token?: unknown;
  accountId?: unknown;
  label?: unknown;
  rate_limit?: unknown;
  primary_window?: unknown;
  secondary_window?: unknown;
  credits?: unknown;
  limit_window_seconds?: unknown;
  used_percent?: unknown;
  reset_at?: unknown;
  balance?: unknown;
  unlimited?: unknown;
  spend_control?: unknown;
  individual_limit?: unknown;
  used?: unknown;
  limit?: unknown;
  unit?: unknown;
  email?: unknown;
  account_id?: unknown;
  plan_type?: unknown;
  error?: unknown;
  type?: unknown;
}

const hasFields = (value: unknown): value is CodexFields => value !== null && value !== undefined;
const asFields = z.custom<CodexFields | null>(hasFields).catch(null).parse;

interface UsageCredential {
  accessToken: unknown;
  accountId?: unknown;
}

type UsageHeaders = {
  Authorization: string;
  'Content-Type': string;
  'ChatGPT-Account-Id'?: string;
};

export const providerId = 'codex';
export const providerName = 'Codex';
const aliases = ['openai', 'codex', 'chatgpt'];

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REQUEST_TIMEOUT_MS = 15_000;

export const isConfigured = (auth: LegacyAuthFile) => {
  const entry = asFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  return Boolean(entry?.access || entry?.token);
};

const requestUsage = ({ accessToken, accountId }: UsageCredential, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)) => {
  const headers: UsageHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  if (accountId) headers['ChatGPT-Account-Id'] = `${accountId}`;
  return fetch(USAGE_URL, {
    method: 'GET',
    redirect: 'error',
    headers,
    signal
  });
};

const usageWindowsOf = (payload: CodexFields | null) => {
  const primary = asFields(asFields(payload?.rate_limit)?.primary_window) ?? null;
  const secondary = asFields(asFields(payload?.rate_limit)?.secondary_window) ?? null;
  const credits = asFields(payload?.credits) ?? null;

  const windows: Record<string, UsageWindow> = {};
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

  const spendLimit = asFields(asFields(payload?.spend_control)?.individual_limit);
  if (spendLimit) {
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

const usageResult = (payload: CodexFields | null, accountLabel: string | null, accountSource?: 'codex-cli') => buildResult({
  providerId,
  providerName,
  ok: true,
  configured: true,
  usage: { windows: usageWindowsOf(payload) },
  accountLabel,
  accountSource,
});

const numericUsage = z.unknown().refine((value) => toNumber(value) !== null);
const accountQuotaWindow = z.looseObject({ used_percent: numericUsage });
const accountSpendLimit = z.looseObject({
  used_percent: numericUsage.nullish(),
  used: numericUsage.nullish(),
  limit: numericUsage.nullish(),
}).refine(({ used_percent, used, limit }) =>
  toNumber(used_percent) !== null || (toNumber(used) !== null && toNumber(limit) !== null));
const accountQuotaPayload = z.looseObject({
  account_id: z.string().nullish(),
  plan_type: z.string().nullish(),
  rate_limit: z.object({ primary_window: accountQuotaWindow.nullish(), secondary_window: accountQuotaWindow.nullish() }).nullish(),
  credits: z.looseObject({ balance: numericUsage.nullish(), unlimited: z.boolean().optional() }).nullish(),
  spend_control: z.object({ individual_limit: accountSpendLimit.nullish() }).nullish(),
}).refine((payload) => 'rate_limit' in payload || 'credits' in payload || 'spend_control' in payload || 'plan_type' in payload);

export const readCodexAccountUsage = async (credential: { accessToken: string; accountId: string | null }, deadline: AbortSignal) => {
  const response = await requestUsage(credential, AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
  if (response.status === 401) {
    const body = asFields(await response.json().catch(unlessTimedOut));
    return { status: asFields(body?.error)?.type === 'rejected_by_access_enforcement' ? 'unsupported' : 'expired' } as const;
  }
  if (response.status === 403) return { status: 'unsupported' } as const;
  if (response.status === 429) return { status: 'cooldown', retryAt: retryAfterAt(response) } as const;
  if (!response.ok) return { status: 'transient' } as const;

  const parsed = accountQuotaPayload.safeParse(await response.json());
  if (!parsed.success) return { status: 'transient' } as const;
  const payload = parsed.data;
  const returnedId = asNonEmptyString(payload.account_id);
  if (credential.accountId && returnedId && returnedId !== credential.accountId) return { status: 'unsupported' } as const;
  return {
    status: 'fresh',
    usage: { windows: usageWindowsOf(payload) },
    planLabel: asNonEmptyString(payload.plan_type),
  } as const;
};

const failure = (error: string, configured = true) => buildResult({ providerId, providerName, ok: false, configured, error });

const isTimeout = (error: unknown): error is DOMException => error instanceof DOMException && error.name === 'TimeoutError';

const unlessTimedOut = (error: Error) => {
  if (isTimeout(error)) throw error;
  return null;
};

const usageFromCodexCli = async () => {
  const login = readCodexCliLogin();
  if (!login) return null;
  const response = await requestUsage(login).catch(unlessTimedOut);
  if (!response?.ok) return null;
  const payload = asFields(await response.json());
  return usageResult(payload, asNonEmptyString(payload?.email) ?? signInEmailOf(login.accessToken), 'codex-cli');
};

export const fetchQuota = async () => {
  const auth = await readOpenCodeCredentials();
  const entry = asFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  const accessToken = entry?.access ?? entry?.token;
  const accountId = entry?.accountId;

  if (!accessToken) return failure('Not configured', false);

  try {
    const response = await requestUsage({ accessToken, accountId });
    if (response.ok) {
      const payload = asFields(await response.json());
      const storedId = asNonEmptyString(accountId);
      const returnedId = asNonEmptyString(payload?.account_id);
      const label = storedId && returnedId && storedId !== returnedId ? null : asNonEmptyString(entry?.label);
      return usageResult(payload, label ?? asNonEmptyString(payload?.email));
    }
    if (response.status !== 401) return failure(`API error: ${response.status}`);

    const body = asFields(await response.json().catch(unlessTimedOut));
    if (asNonEmptyString(asFields(body?.error)?.type) !== 'rejected_by_access_enforcement') {
      return failure('Session expired — please re-authenticate with OpenAI');
    }
    return await usageFromCodexCli()
      ?? failure('OpenAI shows usage for Sign in with ChatGPT only at chatgpt.com/settings/usage. The legacy Codex sign-ins show it here.');
  } catch (error) {
    if (isTimeout(error)) return failure('Request timed out');
    return failure(error instanceof Error ? error.message : 'Request failed');
  }
};
