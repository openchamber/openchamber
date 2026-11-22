import { readQuotaJson } from '../utils/response-body.js';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { asNonEmptyString, asObject, buildResult, getAuthEntry, normalizeAuthEntry, toNumber, toUsageWindow } from '../utils/index.js';

export const providerId = 'command-code';
export const providerName = 'Command Code';
export const aliases = ['command-code', 'commandcode', 'command_code', 'command code'];

const API_BASE_URL = 'https://api.commandcode.ai';

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth ?? {}, aliases));
  const stored = asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.token);
  return stored ?? asNonEmptyString(process.env.COMMAND_CODE_API_KEY) ?? null;
};

const requestJson = async (path, apiKey, fetchImpl) => {
  const response = await fetchImpl(`${API_BASE_URL}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'OpenChamber quota provider',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Command Code authentication failed');
  if (!response.ok) throw new Error(`Command Code usage API returned HTTP ${response.status}`);
  return readQuotaJson(response).catch(() => null);
};

const formatCredits = (value) => String(Math.round((value + Number.EPSILON) * 100) / 100);

const toBalanceWindow = (value) => toUsageWindow({
  usedPercent: null,
  windowSeconds: null,
  resetAt: null,
  valueLabel: formatCredits(value),
});

// The Go plan's included monthly credits (Drew's quota READ RULE,
// 2026-11-01: Command Code reads report the PLAN windows only -
// monthly is "$ used of the $10 included credits"). The credits
// payload's monthlyCredits is the REMAINING balance of that bucket,
// so the monthly plan window is derived from it. The top-up balance
// (purchasedCredits) is never a quota figure.
const MONTHLY_INCLUDED_CREDITS = 10;

export const parseCommandCodeCredits = (payload) => {
  const root = asObject(payload);
  const credits = asObject(root?.credits);
  const limits = asObject(root?.windowLimits);
  const windows = {};

  const monthlyRemaining = toNumber(credits?.monthlyCredits);
  if (monthlyRemaining !== null && monthlyRemaining >= 0 && monthlyRemaining <= MONTHLY_INCLUDED_CREDITS) {
    const monthlyUsed = MONTHLY_INCLUDED_CREDITS - monthlyRemaining;
    windows.monthly = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, monthlyUsed / MONTHLY_INCLUDED_CREDITS * 100)),
      windowSeconds: null,
      resetAt: null,
      valueLabel: `${formatCredits(monthlyUsed)} / ${formatCredits(MONTHLY_INCLUDED_CREDITS)}`,
    });
  }

  for (const [label, field] of [['purchased_credits', 'purchasedCredits'], ['free_credits', 'freeCredits']]) {
    const value = toNumber(credits?.[field]);
    if (value !== null) windows[label] = toBalanceWindow(value);
  }

  for (const [label, field, windowSeconds] of [['5h', 'fiveHour', 5 * 60 * 60], ['weekly', 'weekly', 7 * 24 * 60 * 60]]) {
    const limit = asObject(limits?.[field]);
    const used = toNumber(limit?.used);
    const cap = toNumber(limit?.cap);
    if (used === null || cap === null || cap <= 0) continue;
    const resetAt = toNumber(limit?.resetAt);
    windows[label] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, used / cap * 100)),
      windowSeconds,
      resetAt: resetAt === null ? null : resetAt < 1_000_000_000_000 ? resetAt * 1000 : resetAt,
      valueLabel: `${formatCredits(used)} / ${formatCredits(cap)}`,
    });
  }

  return windows;
};

export const fetchCommandCodeUsage = async (apiKey, fetchImpl = fetch) => {
  const identity = asObject(await requestJson('/alpha/whoami', apiKey, fetchImpl));
  const org = asObject(identity?.org);
  const orgId = asNonEmptyString(org?.id) ?? '';
  const creditsPath = orgId
    ? `/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}`
    : '/alpha/billing/credits';
  const credits = await requestJson(creditsPath, apiKey, fetchImpl);
  const windows = parseCommandCodeCredits(credits);
  if (Object.keys(windows).length === 0) throw new Error('Command Code usage data could not be parsed');
  return windows;
};

export const isConfigured = (auth) => Boolean(getApiKey(auth));

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch } = {}) => {
  const apiKey = getApiKey(await readAuth());
  if (!apiKey) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  try {
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: await fetchCommandCodeUsage(apiKey, fetchImpl) } });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};
