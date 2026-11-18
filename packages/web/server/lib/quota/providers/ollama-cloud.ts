
import { z } from 'zod';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import type { UsageWindow } from '../utils/contracts.js';
import { deleteLegacyOllamaCloudCredential } from '../credentials/store.js';
import { asNonEmptyString, asObject, buildResult, formatMoney, getAuthEntry, normalizeAuthEntry, toNumber, toTimestamp, toUsageWindow } from '../utils/index.js';

interface OllamaFields {
  key?: unknown;
  token?: unknown;
  included?: unknown;
  allowance_usd?: unknown;
  balance_usd?: unknown;
  period?: unknown;
  until?: unknown;
  session?: unknown;
  weekly?: unknown;
  remaining_percent?: unknown;
  resets_at?: unknown;
  purchased?: unknown;
  Plan?: unknown;
}

const isObject = (value: unknown): value is OllamaFields => asObject(value) !== null;
const asFields = z.custom<OllamaFields | null>(isObject).catch(null).parse;

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
const aliases = ['ollama-cloud', 'ollamacloud'];

const BALANCE_URL = 'https://ollama.com/api/balance';
const ME_URL = 'https://ollama.com/api/me';

const apiKeyFromAuth = (auth: LegacyAuthFile) => {
  const entry = asFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  if (!entry) return null;
  return asNonEmptyString(entry.key) ?? asNonEmptyString(entry.token);
};

export const toUsageWindows = z.unknown().transform((payload) => {
  const windows: Record<string, UsageWindow> = {};
  const included = asFields(asFields(payload)?.included);
  const allowance = toNumber(included?.allowance_usd);
  const remaining = toNumber(included?.balance_usd);
  if (allowance !== null && allowance > 0 && remaining !== null) {
    windows.monthly = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, ((allowance - remaining) / allowance) * 100)),
      windowSeconds: null,
      resetAt: toTimestamp(asFields(included?.period)?.until),
    });
  }

  for (const name of ['session', 'weekly'] as const) {
    const limit = asFields(included?.[name]);
    const remainingPercent = toNumber(limit?.remaining_percent);
    if (remainingPercent === null) continue;
    windows[name] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, 100 - remainingPercent)),
      windowSeconds: null,
      resetAt: toTimestamp(limit?.resets_at),
    });
  }

  const purchased = toNumber(asFields(asFields(payload)?.purchased)?.balance_usd);
  if (purchased !== null && purchased > 0) {
    windows.purchased_credits = toUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `$${formatMoney(purchased)}`,
    });
  }
  return windows;
}).parse;

export const isConfigured = (auth: LegacyAuthFile) => Boolean(apiKeyFromAuth(auth));

export const fetchOllamaCloudUsage = async (apiKey: string, fetchImpl = fetch) => {
  const response = await fetchImpl(BALANCE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);

  const windows = toUsageWindows(await response.json());
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};

export const fetchOllamaCloudPlan = async (apiKey: string, fetchImpl = fetch) => {
  const response = await fetchImpl(ME_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  return asNonEmptyString(asFields(await response.json())?.Plan);
};

export const fetchQuota = async () => {
  deleteLegacyOllamaCloudCredential();

  const apiKey = apiKeyFromAuth(await readOpenCodeCredentials());
  if (!apiKey) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  }

  try {
    const [windows, plan] = await Promise.all([
      fetchOllamaCloudUsage(apiKey),
      fetchOllamaCloudPlan(apiKey).catch(() => null),
    ]);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows }, planLabel: plan });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};
