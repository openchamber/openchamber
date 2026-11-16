
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { deleteLegacyOllamaCloudCredential } from '../credentials/store.js';
import { asNonEmptyString, asObject, buildResult, formatMoney, getAuthEntry, normalizeAuthEntry, toNumber, toTimestamp, toUsageWindow } from '../utils/index.js';

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
const aliases = ['ollama-cloud', 'ollamacloud'];

const BALANCE_URL = 'https://ollama.com/api/balance';
const ME_URL = 'https://ollama.com/api/me';

const apiKeyFromAuth = (auth) => {
  const entry = asObject(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  if (!entry) return null;
  return asNonEmptyString(entry.key) ?? asNonEmptyString(entry.token);
};

export const toUsageWindows = (payload) => {
  const windows = {};
  const included = asObject(asObject(payload)?.included);
  const allowance = toNumber(included?.allowance_usd);
  const remaining = toNumber(included?.balance_usd);
  if (allowance !== null && allowance > 0 && remaining !== null) {
    windows.monthly = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, ((allowance - remaining) / allowance) * 100)),
      windowSeconds: null,
      resetAt: toTimestamp(asObject(included?.period)?.until),
    });
  }

  for (const name of ['session', 'weekly']) {
    const limit = asObject(included?.[name]);
    const remainingPercent = toNumber(limit?.remaining_percent);
    if (remainingPercent === null) continue;
    windows[name] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, 100 - remainingPercent)),
      windowSeconds: null,
      resetAt: toTimestamp(limit?.resets_at),
    });
  }

  const purchased = toNumber(asObject(asObject(payload)?.purchased)?.balance_usd);
  if (purchased !== null && purchased > 0) {
    windows.purchased_credits = toUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `$${formatMoney(purchased)}`,
    });
  }
  return windows;
};

export const isConfigured = (auth) => Boolean(apiKeyFromAuth(auth));

export const fetchOllamaCloudUsage = async (apiKey, fetchImpl = fetch) => {
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

export const fetchOllamaCloudPlan = async (apiKey, fetchImpl = fetch) => {
  const response = await fetchImpl(ME_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  return asNonEmptyString(asObject(await response.json())?.Plan);
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
