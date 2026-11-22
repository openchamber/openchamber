import { z } from 'zod';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/config-files.js';
import { isRecord } from '../../opencode/config-v2.js';
import { readQuotaJson } from '../utils/response-body.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import type { UsageWindow } from '../utils/contracts.js';
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
export const aliases = ['openai', 'codex', 'chatgpt'];

const clampPercent = (value: number | null) => value === null ? null : Math.min(100, Math.max(0, value));

const getAccessToken = (entry: CodexFields | null) => asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.token);

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REQUEST_TIMEOUT_MS = 15_000;

export const isConfigured = (auth: LegacyAuthFile) => {
  const entry = asFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  return Boolean(getAccessToken(entry));
};

const requestUsage = ({ accessToken, accountId }: UsageCredential) => {
  const headers: UsageHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
  if (accountId) headers['ChatGPT-Account-Id'] = `${accountId}`;
  return fetch(USAGE_URL, {
    method: 'GET',
    redirect: 'error',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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
      usedPercent: clampPercent(toNumber(primary.used_percent)),
      windowSeconds,
      resetAt: toTimestamp(primary.reset_at)
    });
  }
  if (secondary) {
    const windowSeconds = toNumber(secondary.limit_window_seconds);
    windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
      usedPercent: clampPercent(toNumber(secondary.used_percent)),
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
      usedPercent: clampPercent(toNumber(spendLimit.used_percent)),
      windowSeconds: null,
      resetAt: null,
      valueLabel
    });
  }
  return windows;
};

const usageResult = (payload: CodexFields | null, accountLabel: string | null = null) => buildResult({
  providerId,
  providerName,
  ok: true,
  configured: true,
  usage: { windows: usageWindowsOf(payload) },
  accountLabel
});

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
  const payload = asFields(await readQuotaJson(response));
  return usageResult(payload, asNonEmptyString(payload?.email) ?? signInEmailOf(login.accessToken));
};

const fetchQuotaForEntry = async (entry: CodexFields | null) => {
  const accessToken = getAccessToken(entry);
  const accountId = entry?.accountId;

  if (!accessToken) return failure('Not configured', false);

  try {
    const response = await requestUsage({ accessToken, accountId });
    if (response.ok) {
      const payload = asFields(await readQuotaJson(response));
      // The usage payload names the account it metered, so a per-credential
      // result can be told apart from another account's.
      return usageResult(payload, asNonEmptyString(payload?.email) ?? asNonEmptyString(payload?.account_id));
    }
    if (response.status !== 401) return failure(`API error: ${response.status}`);

    const body = asFields(await readQuotaJson(response).catch(unlessTimedOut));
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

/**
 * The ids of configured provider instances of a Codex base (`openai`, ...),
 * in merged-config order. Since the provider re-seat the ChatGPT accounts
 * live under instance integrations (`openai.main`, `openai.alternate`), so
 * the bare integration read finds nothing; the instances are discovered
 * from the merged config, never hardcoded. A config that cannot be read
 * answers none, mirroring the registry's config-facts read.
 */
const readCodexInstanceIds = () => {
  try {
    const { mergedConfig } = readConfigLayers();
    const ids: string[] = [];
    for (const sectionKey of ['providers', 'provider']) {
      const section = (mergedConfig as Record<string, unknown> | null | undefined)?.[sectionKey];
      if (!isRecord(section)) continue;
      for (const [id, definition] of Object.entries(section)) {
        const instanceOf = isRecord(definition) ? asNonEmptyString(definition.instanceOf) : null;
        if (instanceOf && aliases.includes(instanceOf)) ids.push(id);
      }
    }
    return ids;
  } catch (error) {
    console.warn('Quota: failed to read the OpenCode config; Codex instance credentials are not considered.', error);
    return [];
  }
};

const entryWithToken = (entry: unknown) => {
  const normalized = asFields(normalizeAuthEntry(entry));
  return normalized && getAccessToken(normalized) ? normalized : null;
};

/**
 * The credential the single Codex fetch uses: the bare integration's entry,
 * or, when the re-seat left the bare integration empty, the first usable
 * instance entry. The per-credential dispatch folds every instance into
 * the base row instead (see providers/index.ts).
 */
const resolveCodexEntry = (auth: LegacyAuthFile) => {
  const direct = entryWithToken(getAuthEntry(auth, aliases));
  if (direct) return direct;
  for (const instanceId of readCodexInstanceIds()) {
    const entry = entryWithToken(getAuthEntry(auth, [instanceId]));
    if (entry) return entry;
  }
  return null;
};

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials }: { readAuth?: () => Promise<LegacyAuthFile> } = {}) => {
  const auth = await readAuth();
  return fetchQuotaForEntry(resolveCodexEntry(auth));
};

/** Quota for one stored credential row, fetched with that row's own token. */
export const fetchQuotaForCredential = async (credential: { value?: unknown } | null | undefined) => (
  fetchQuotaForEntry(asFields(normalizeAuthEntry(credential?.value)))
);
