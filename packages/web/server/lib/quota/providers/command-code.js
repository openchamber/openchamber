import fs from 'fs';
import os from 'os';
import path from 'path';

import { readAuthFile } from '../../opencode/auth.js';
import {
  asNonEmptyString,
  asObject,
  buildResult,
  getAuthEntry,
  normalizeAuthEntry,
  toNumber,
  toUsageWindow
} from '../utils/index.js';

// Command Code quota provider for OpenChamber.
//
// The `/alpha/*` endpoints used here are unofficial CLI-internal APIs, so this
// integration is best-effort and opt-in: it only activates when a Command Code
// credential is present, and any failure is isolated to this provider's result.

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
  const stored = asNonEmptyString(entry?.key ?? entry?.access ?? entry?.token);
  const envKey = asNonEmptyString(process.env.COMMAND_CODE_API_KEY);
  const cliKey = readCommandCodeCliApiKey();
  return [...new Set([stored, envKey, cliKey].filter(Boolean))];
};

const requestJson = async (requestPath, apiKey, fetchImpl) => {
  const response = await fetchImpl(`${API_BASE_URL}${requestPath}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'OpenChamber quota provider'
    },
    signal: AbortSignal.timeout(15_000)
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
  valueLabel: formatCredits(value)
});

export const parseCommandCodeCredits = (payload) => {
  const root = asObject(payload);
  const limits = asObject(root?.windowLimits);
  const windows = {};

  for (const [label, field, windowSeconds] of [['5h', 'fiveHour', 5 * 60 * 60], ['weekly', 'weekly', 7 * 24 * 60 * 60]]) {
    const limit = asObject(limits?.[field]);
    const used = toNumber(limit?.used);
    const cap = toNumber(limit?.cap);
    if (used === null || cap === null || cap <= 0) continue;
    const resetAt = toNumber(limit?.resetAt);
    // No valueLabel: the UI then renders usedPercent as a percentage
    // (dk(valueLabel, percent) falls back to the percent when the label is absent),
    // matching how the other rate-limit providers display 5h/weekly windows.
    windows[label] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, used / cap * 100)),
      windowSeconds,
      resetAt: resetAt === null ? null : resetAt < 1_000_000_000_000 ? resetAt * 1000 : resetAt
    });
  }

  return windows;
};

export const fetchCommandCodeUsage = async (apiKey, fetchImpl = fetch) => {
  const identity = asObject(await requestJson('/alpha/whoami', apiKey, fetchImpl));
  if (!identity || !Object.prototype.hasOwnProperty.call(identity, 'org')) {
    throw new Error('Command Code account could not be determined');
  }
  const orgId = asNonEmptyString(asObject(identity.org)?.id);
  if (identity.org !== null && orgId === null) {
    throw new Error('Command Code account could not be determined');
  }
  const orgSuffix = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
  const credits = await requestJson(`/alpha/billing/credits${orgSuffix}`, apiKey, fetchImpl);
  const windows = parseCommandCodeCredits(credits);

  // Monthly credits: /alpha/usage/summary reports credits consumed in the current
  // billing period and /alpha/billing/credits reports what remains, so their sum
  // is the plan allowance. That lets the monthly window render as a percentage
  // like the 5h/weekly limits. Balance-only purchased/free credits are omitted.
  const remaining = toNumber(asObject(asObject(credits)?.credits)?.monthlyCredits);
  let monthlyWindow = null;
  try {
    const summary = asObject(await requestJson('/alpha/usage/summary', apiKey, fetchImpl));
    const used = toNumber(summary?.totalMonthlyCredits);
    if (used !== null && remaining !== null && used + remaining > 0) {
      monthlyWindow = toUsageWindow({
        usedPercent: Math.min(100, Math.max(0, used / (used + remaining) * 100)),
        windowSeconds: null,
        resetAt: null
      });
    }
  } catch {
    monthlyWindow = null;
  }
  if (monthlyWindow) windows.monthly_credits = monthlyWindow;
  else if (remaining !== null) windows.monthly_credits = toBalanceWindow(remaining);

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
