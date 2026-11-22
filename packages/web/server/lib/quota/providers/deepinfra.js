import { readQuotaJson } from '../utils/response-body.js';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  formatMoney,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'deepinfra';
export const providerName = 'DeepInfra';
export const aliases = ['deepinfra', 'deep-infra', 'deep_infra'];
const DEEPINFRA_ME_URL = 'https://api.deepinfra.com/v1/me?checklist=true';

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
};

export const isConfigured = (auth) => Boolean(getApiKey(auth));

export const fetchQuota = async ({ readCredentials = readOpenCodeCredentials } = {}) => {
  const apiKey = getApiKey(await readCredentials());

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
    const response = await fetch(DEEPINFRA_ME_URL, {
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
          ? 'Session expired — please re-authenticate with DeepInfra'
          : `API error: ${response.status}`
      });
    }

    const payload = await readQuotaJson(response);
    // Documented at https://docs.deepinfra.com/api-reference/account/me:
    // checklist.stripe_balance is negative when funds are ready to spend and
    // positive when money is owed, so the spendable credit is its negation.
    const rawBalance = payload?.checklist?.stripe_balance;
    // A blank or absent balance is missing data, not a $0.00 balance.
    const stripeBalance = String(rawBalance ?? '').trim() === '' ? null : toNumber(rawBalance);

    if (stripeBalance === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const availableCredits = -stripeBalance;
    const symbol = availableCredits < 0 ? '-$' : '$';
    const valueLabel = `${symbol}${formatMoney(Math.abs(availableCredits))}`;

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
