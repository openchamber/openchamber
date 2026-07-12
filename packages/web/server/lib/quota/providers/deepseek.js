import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  formatMoney
} from '../utils/index.js';

export const providerId = 'deepseek';
export const providerName = 'DeepSeek';
const aliases = ['deepseek'];

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

const currencySymbol = (currency) => {
  if (currency === 'CNY') return 'CN\u00a5';
  if (currency === 'USD') return '$';
  return currency;
};

const formatBalanceLabel = (info) => {
  const symbol = currencySymbol(info.currency);
  const parts = [`${symbol}${formatMoney(Number(info.total_balance))}`];
  const topped = Number(info.topped_up_balance);
  const granted = Number(info.granted_balance);
  if (topped > 0 && granted > 0) {
    parts.push(`(${symbol}${formatMoney(topped)} topped up + ${symbol}${formatMoney(granted)} granted)`);
  } else if (topped > 0) {
    parts.push(`(${symbol}${formatMoney(topped)} topped up)`);
  } else if (granted > 0) {
    parts.push(`(${symbol}${formatMoney(granted)} granted)`);
  }
  return parts.join(' ');
};

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch(DEEPSEEK_BALANCE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Invalid API key \u2014 please re-authenticate with DeepSeek'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const balanceInfos = Array.isArray(payload?.balance_infos)
      ? payload.balance_infos
      : [];

    if (balanceInfos.length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No balance data returned'
      });
    }

    const windows = {};

    for (const info of balanceInfos) {
      if (!info || typeof info.currency !== 'string') continue;
      const key = info.currency.toUpperCase();
      windows[key] = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: formatBalanceLabel(info)
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
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
