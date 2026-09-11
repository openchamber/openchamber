import { readAuthFile } from '../../opencode/auth.js';
import {
  asNonEmptyString,
  buildResult,
  formatMoney,
  getAuthEntry,
  normalizeAuthEntry,
  toUsageWindow
} from '../utils/index.js';

export const providerId = 'fireworks-ai';
export const providerName = 'Fireworks AI';
export const aliases = ['fireworks-ai', 'fireworks', 'fireworks_ai'];

const FIREWORKS_API_BASE_URL = 'https://api.fireworks.ai/v1';
const MONTHLY_SPEND_QUOTA_ID = 'monthly-spend-usd';

class FireworksProviderError extends Error {}

const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parseNonNegativeNumber = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const isValidAccountId = (value) => /^[^/?#\s]+$/.test(value);

export const extractFireworksAccountId = (resourceName) => {
  const name = asNonEmptyString(resourceName);
  if (!name) return null;
  const match = /^accounts\/([^/?#\s]+)$/.exec(name);
  return match?.[1] ?? null;
};

const multipleAccountsError = () => new FireworksProviderError(
  'Multiple Fireworks AI accounts are accessible. Configure accountId or account_id in the Fireworks auth entry.'
);

export const parseFireworksAccountsResponse = (payload) => {
  if (!isJsonObject(payload) || !Array.isArray(payload.accounts)) {
    throw new FireworksProviderError('Invalid accounts response from Fireworks AI');
  }

  if (Object.hasOwn(payload, 'nextPageToken') && typeof payload.nextPageToken !== 'string') {
    throw new FireworksProviderError('Invalid accounts response from Fireworks AI');
  }
  if (Object.hasOwn(payload, 'totalSize')
    && (!Number.isSafeInteger(payload.totalSize) || payload.totalSize < 0)) {
    throw new FireworksProviderError('Invalid accounts response from Fireworks AI');
  }

  const accountIds = payload.accounts.map((account) => {
    if (!isJsonObject(account)) {
      throw new FireworksProviderError('Invalid accounts response from Fireworks AI');
    }
    const accountId = extractFireworksAccountId(account.name);
    if (!accountId) {
      throw new FireworksProviderError('Invalid accounts response from Fireworks AI');
    }
    return accountId;
  });

  const hasNextPage = typeof payload.nextPageToken === 'string' && payload.nextPageToken.trim() !== '';
  if (accountIds.length > 1 || payload.totalSize > 1 || hasNextPage) {
    throw multipleAccountsError();
  }
  if (accountIds.length === 0) {
    throw new FireworksProviderError('No Fireworks AI accounts are accessible');
  }
  if (Object.hasOwn(payload, 'totalSize') && payload.totalSize !== 1) {
    throw new FireworksProviderError('Invalid accounts response from Fireworks AI');
  }

  return accountIds[0];
};

export const parseFireworksMonthlySpendQuota = (payload, accountId) => {
  if (!isJsonObject(payload)) {
    throw new FireworksProviderError('Invalid monthly spend quota response from Fireworks AI');
  }

  const expectedName = `accounts/${accountId}/quotas/${MONTHLY_SPEND_QUOTA_ID}`;
  if (payload.name !== expectedName) {
    throw new FireworksProviderError('Invalid monthly spend quota response from Fireworks AI');
  }

  const usage = parseNonNegativeNumber(payload.usage);
  if (usage === null) {
    throw new FireworksProviderError('Invalid monthly spend quota response from Fireworks AI');
  }

  const hasLimit = payload.value !== undefined && payload.value !== null;
  const limit = hasLimit ? parseNonNegativeNumber(payload.value) : null;
  if (hasLimit && limit === null) {
    throw new FireworksProviderError('Invalid monthly spend quota response from Fireworks AI');
  }

  if (limit === null) {
    return {
      usedPercent: null,
      remaining: null,
      usage,
      valueLabel: `$${formatMoney(usage)} spent`
    };
  }

  const remaining = Math.max(0, limit - usage);
  const usedPercent = limit > 0
    ? Math.max(0, Math.min(100, (usage / limit) * 100))
    : null;

  return {
    usedPercent,
    remaining,
    usage,
    valueLabel: `$${formatMoney(remaining)} left · $${formatMoney(usage)} spent`
  };
};

const resolveApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return {
    entry,
    apiKey: asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token)
  };
};

const resolveConfiguredAccountId = (entry) => {
  for (const value of [entry?.accountId, entry?.account_id]) {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) continue;
    const accountId = asNonEmptyString(value);
    if (!accountId || !isValidAccountId(accountId)) {
      throw new FireworksProviderError('Configured Fireworks AI account ID is invalid');
    }
    return accountId;
  }
  return null;
};

const apiError = (status) => status === 401 || status === 403
  ? 'Session expired — please re-authenticate with Fireworks AI'
  : `API error: ${status}`;

export const isConfigured = (auth = readAuthFile()) => Boolean(resolveApiKey(auth).apiKey);

export const fetchQuota = async ({ readAuth = readAuthFile, fetchImpl = fetch } = {}) => {
  const { entry, apiKey } = resolveApiKey(readAuth());

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
  const requestInit = {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Encoding': 'identity'
    },
    signal: timeoutSignal
  };

  try {
    let accountId = resolveConfiguredAccountId(entry);
    if (!accountId) {
      const accountsResponse = await fetchImpl(`${FIREWORKS_API_BASE_URL}/accounts?pageSize=200`, requestInit);
      if (!accountsResponse.ok) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: apiError(accountsResponse.status)
        });
      }
      accountId = parseFireworksAccountsResponse(await accountsResponse.json());
    }

    const quotaResponse = await fetchImpl(
      `${FIREWORKS_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/quotas/${MONTHLY_SPEND_QUOTA_ID}`,
      requestInit
    );
    if (!quotaResponse.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: apiError(quotaResponse.status)
      });
    }

    const quota = parseFireworksMonthlySpendQuota(await quotaResponse.json(), accountId);
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: {
        windows: {
          monthly: toUsageWindow({
            usedPercent: quota.usedPercent,
            windowSeconds: null,
            resetAt: null,
            valueLabel: quota.valueLabel
          })
        }
      }
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
          : error instanceof FireworksProviderError
            ? error.message
            : 'Request failed'
    });
  }
};
