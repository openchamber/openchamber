import fs from 'fs';
import os from 'os';
import path from 'path';

import { readAuthFile } from '../../opencode/auth.js';
import { asNonEmptyString, asObject, buildResult, getAuthEntry, normalizeAuthEntry, toNumber, toUsageWindow } from '../utils/index.js';

export const providerId = 'command-code';
export const providerName = 'Command Code';
export const aliases = ['command-code', 'commandcode', 'command_code', 'command code'];

const API_BASE_URL = 'https://api.commandcode.ai';
const COMMAND_CODE_AUTH_FILE = path.join(os.homedir(), '.commandcode', 'auth.json');

export const readCommandCodeCliApiKey = (authFile = COMMAND_CODE_AUTH_FILE) => {
  try {
    const auth = asObject(JSON.parse(fs.readFileSync(authFile, 'utf8')));
    return asNonEmptyString(auth?.apiKey);
  } catch {
    return null;
  }
};

const getApiKeys = (auth) => {
  let resolvedAuth = auth;
  if (resolvedAuth === undefined) {
    try {
      resolvedAuth = readAuthFile();
    } catch {
      resolvedAuth = {};
    }
  }
  const entry = normalizeAuthEntry(getAuthEntry(resolvedAuth, aliases));
  const stored = entry?.key ?? entry?.access ?? entry?.token;
  return [...new Set([
    typeof stored === 'string' ? stored.trim() : '',
    process.env.COMMAND_CODE_API_KEY?.trim(),
    readCommandCodeCliApiKey(),
  ].filter(Boolean))];
};

const requestJson = async (requestPath, apiKey, fetchImpl) => {
  const response = await fetchImpl(`${API_BASE_URL}${requestPath}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'OpenChamber quota provider',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    const error = new Error('Command Code authentication failed');
    error.status = response.status;
    throw error;
  }
  if (!response.ok) throw new Error(`Command Code usage API returned HTTP ${response.status}`);
  return response.json().catch(() => null);
};

const formatCredits = (value) => String(Math.round((value + Number.EPSILON) * 100) / 100);

const toBalanceWindow = (value) => toUsageWindow({
  usedPercent: null,
  windowSeconds: null,
  resetAt: null,
  valueLabel: formatCredits(value),
});

export const parseCommandCodeCredits = (payload) => {
  const root = asObject(payload);
  const credits = asObject(root?.credits);
  const limits = asObject(root?.windowLimits);
  const windows = {};

  for (const [label, field] of [['monthly_credits', 'monthlyCredits'], ['purchased_credits', 'purchasedCredits'], ['free_credits', 'freeCredits']]) {
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
  if (!identity || !Object.prototype.hasOwnProperty.call(identity, 'org')) {
    throw new Error('Command Code account could not be determined');
  }
  const org = identity.org === null ? null : asObject(identity.org);
  if (identity.org !== null && (!org || typeof org.id !== 'string' || !org.id.trim())) {
    throw new Error('Command Code account could not be determined');
  }
  const orgId = typeof org?.id === 'string' ? org.id.trim() : '';
  const creditsPath = orgId
    ? `/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}`
    : '/alpha/billing/credits';
  const credits = await requestJson(creditsPath, apiKey, fetchImpl);
  const windows = parseCommandCodeCredits(credits);
  if (Object.keys(windows).length === 0) throw new Error('Command Code usage data could not be parsed');
  return windows;
};

export const isConfigured = () => getApiKeys().length > 0;

export const fetchQuota = async (auth) => {
  const apiKeys = getApiKeys(auth);
  if (apiKeys.length === 0) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  for (const [index, apiKey] of apiKeys.entries()) {
    try {
      return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: await fetchCommandCodeUsage(apiKey) } });
    } catch (error) {
      if (error?.status && [401, 403].includes(error.status) && index < apiKeys.length - 1) continue;
      return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
    }
  }
};
