import fs from 'fs';
import path from 'path';

import { readAuthFile, OPENCODE_DATA_DIR } from '../../opencode/auth.js';
import { getAuthEntry, normalizeAuthEntry, buildResult, toUsageWindow, toNumber } from '../utils/index.js';
import { computeBurn } from './deepseek-burn.js';

export const providerId = 'deepseek';
export const providerName = 'DeepSeek';
const aliases = ['deepseek'];

const HISTORY_FILE = path.join(OPENCODE_DATA_DIR, 'deepseek-balance-history.json');
const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const HISTORY_MAX_SAMPLES = 200;

const getApiKey = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return entry?.key ?? entry?.token ?? null;
};

export const isConfigured = () => Boolean(getApiKey());

const currencySymbol = (currency) => {
  if (currency === 'USD') return '$';
  if (currency === 'CNY') return '\u00a5';
  return currency ? `${currency} ` : '';
};

const readHistory = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const recordSample = (balance, currency, now) => {
  const history = readHistory()
    .filter((s) => typeof s?.balance === 'number' && typeof s?.at === 'number' && now - s.at <= HISTORY_RETENTION_MS);
  history.push({ balance, currency, at: now });
  const trimmed = history.slice(-HISTORY_MAX_SAMPLES);
  try {
    if (!fs.existsSync(OPENCODE_DATA_DIR)) fs.mkdirSync(OPENCODE_DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed), 'utf8');
  } catch {
    // Persistence is best-effort; a write failure must not break the quota fetch.
  }
  return trimmed;
};

export const buildDeepseekWindow = (balanceInfo, history) => {
  const balance = toNumber(balanceInfo?.total_balance);
  const symbol = currencySymbol(balanceInfo?.currency);
  const valueLabel = balance !== null ? `${symbol}${balance.toFixed(2)}` : null;
  const { burnPerHour, runwaySeconds } = computeBurn(
    (Array.isArray(history) ? history : []).map((s) => ({ balanceUsd: s.balance, at: s.at }))
  );
  const credits = burnPerHour !== null ? { burnPerHour, runwaySeconds, symbol } : null;
  return toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel, credits });
};

export const fetchQuota = async () => {
  const apiKey = getApiKey();

  if (!apiKey) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  }

  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    });

    if (!response.ok) {
      return buildResult({ providerId, providerName, ok: false, configured: true, error: `API error: ${response.status}` });
    }

    const payload = await response.json();
    const balanceInfo = Array.isArray(payload?.balance_infos) ? payload.balance_infos[0] : null;
    const balance = toNumber(balanceInfo?.total_balance);

    if (!balanceInfo || balance === null) {
      return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows: {} } });
    }

    const history = recordSample(balance, balanceInfo.currency, Date.now());
    const windows = { credits_balance: buildDeepseekWindow(balanceInfo, history) };

    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
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
