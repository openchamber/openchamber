import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/shared.js';
import {
  resolveConfigApiKey,
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  formatMoney,
  formatCredits,
  asObject,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'anymodel';
export const providerName = 'AnyModel';
const aliases = ['anymodel'];

// https://anymodel.org/api-docs.md documents the balance payload; the FAQ
// defines one million balance tokens as $0.05.
const ANYMODEL_BALANCE_URL = 'https://anymodel.org/v1/balance';
const TOKEN_TO_USD = 0.05 / 1_000_000;

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKeyFromAuth = asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);

  if (asNonEmptyString(apiKeyFromAuth)) {
    return apiKeyFromAuth;
  }

  try {
    const { mergedConfig } = readConfigLayers();

    for (const alias of aliases) {
      const providerConfig = mergedConfig?.provider?.[alias];
      if (providerConfig?.options?.apiKey) {
        return resolveConfigApiKey(providerConfig.options.apiKey);
      }
    }
  } catch {
    // Ignore config read errors; the provider will be treated as not configured.
  }

  return null;
};

export const isConfigured = (auth) => Boolean(getApiKey(auth));

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch } = {}) => {
  const apiKey = getApiKey(await readAuth());

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
    const response = await fetchImpl(ANYMODEL_BALANCE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity'
      },
      redirect: 'error',
      signal: timeoutSignal
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with AnyModel'
          : `API error: ${response.status}`
      });
    }

    const payload = asObject(await response.json());
    const unlimited = payload?.unlimited === true;
    const rawBalance = payload?.balance;
    const balance = toNumber(asNonEmptyString(rawBalance)
      ?? (Number.isFinite(rawBalance) ? rawBalance : null));

    if (unlimited) {
      return buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: {
          windows: {
            credits_balance: toUsageWindow({
              usedPercent: null,
              windowSeconds: null,
              resetAt: null,
              valueLabel: 'Unlimited'
            })
          }
        }
      });
    }

    if (balance === null) {
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
        valueLabel: `$${formatMoney(balance * TOKEN_TO_USD)}`
      }),
      tokens: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: formatCredits(balance)
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
