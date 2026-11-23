import { z } from 'zod';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  formatMoney
} from '../utils/index.js';

interface DeepSeekFields {
  key?: unknown;
  token?: unknown;
  balance_infos?: unknown;
  total_balance?: unknown;
  currency?: unknown;
}

const hasFields = (value: unknown): value is DeepSeekFields => value !== null && value !== undefined;
const asFields = z.custom<DeepSeekFields | null>(hasFields).catch(null).parse;
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isString = (value: unknown): value is string => typeof value === 'string';

export const providerId = 'deepseek';
export const providerName = 'DeepSeek';
const aliases = ['deepseek'];
const DEEPSEEK_QUOTA_URL = 'https://api.deepseek.com/user/balance';

export const isConfigured = (auth: LegacyAuthFile) => {
  const entry = asFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async () => {
  const auth = await readOpenCodeCredentials();
  const entry = asFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
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

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(DEEPSEEK_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity'
      },
      signal: timeoutSignal
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with DeepSeek'
          : `API error: ${response.status}`
      });
    }

    const payload = asFields(await response.json());
    const balanceInfos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    const positiveBalances = balanceInfos.filter((info) => {
      const num = toNumber(asFields(info)?.total_balance);
      return num !== null && num > 0;
    });
    const balanceInfo = asFields(positiveBalances.find((info) => asFields(info)?.currency === 'USD')
      ?? positiveBalances.find((info) => asFields(info)?.currency === 'CNY')
      ?? balanceInfos.find((info) => asFields(info)?.currency === 'USD')
      ?? balanceInfos.find((info) => asFields(info)?.currency === 'CNY')
      ?? null);
    const rawBalance = balanceInfo?.total_balance;
    const totalBalance = (isNumber(rawBalance) || (isString(rawBalance) && rawBalance.trim() !== ''))
      ? toNumber(rawBalance)
      : null;

    if (totalBalance === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const isCny = balanceInfo?.currency === 'CNY';
    const symbol = isCny ? '¥' : '$';
    const valueLabel = `${symbol}${formatMoney(totalBalance)}`;

    const windows = {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel
      })
    };

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};
