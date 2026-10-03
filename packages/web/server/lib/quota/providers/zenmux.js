import { readManagedCredential } from '../credentials/providers.js';
import {
  buildResult,
  toUsageWindow,
  toNumber,
  formatMoney,
  asObject,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'zenmux';
export const providerName = 'ZenMux';
export const aliases = ['zenmux'];
const ZENMUX_BALANCE_URL = 'https://zenmux.ai/api/v1/management/payg/balance';

const readStoredCredential = () => readManagedCredential(providerId);

const getPlatformApiKey = (credential) => asNonEmptyString(credential?.platformApiKey);

const parseCredits = (value) => toNumber(asNonEmptyString(value)
  ?? (Number.isFinite(value) ? value : null));

export const isConfigured = (readCredential = readStoredCredential) => Boolean(getPlatformApiKey(readCredential()));

export const fetchQuota = async ({
  readCredential = readStoredCredential,
  fetchImpl = fetch
} = {}) => {
  const apiKey = getPlatformApiKey(readCredential());

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
    const response = await fetchImpl(ZENMUX_BALANCE_URL, {
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
          ? 'Invalid ZenMux Platform API key'
          : `API error: ${response.status}`
      });
    }

    const payload = asObject(await response.json());
    const data = asObject(payload?.data);
    const totalCredits = parseCredits(data?.total_credits);

    if (totalCredits === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const windows = {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(totalCredits)}`
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
