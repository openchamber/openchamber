import { readAuthFile } from '../../opencode/auth.js';
import { readConfig } from '../../opencode/shared.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  formatMoney,
  asObject,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'kilo';
export const providerName = 'Kilo Code';
const aliases = ['kilo', 'kilocode', 'kilo-code'];
const KILO_BALANCE_URL = 'https://api.kilo.ai/api/profile/balance';

const getAuthEntryForKilo = (auth) => normalizeAuthEntry(getAuthEntry(auth, aliases));

const getApiKey = (auth) => {
  const entry = getAuthEntryForKilo(auth);
  return asNonEmptyString(entry?.key)
    ?? asNonEmptyString(entry?.token)
    ?? asNonEmptyString(entry?.access);
};

const organizationIdFromEntry = (entry) => asNonEmptyString(entry?.kilocodeOrganizationId)
  ?? asNonEmptyString(entry?.organizationId)
  ?? asNonEmptyString(entry?.accountId);

const organizationIdFromConfig = (config) => {
  const provider = asObject(asObject(config)?.provider);
  const kilo = asObject(provider?.kilo) ?? asObject(provider?.kilocode);
  const options = asObject(kilo?.options);
  return asNonEmptyString(options?.kilocodeOrganizationId)
    ?? asNonEmptyString(options?.organizationId);
};

const parseBalance = (value) => toNumber(asNonEmptyString(value)
  ?? (Number.isFinite(value) ? value : null));

export const isConfigured = (auth = readAuthFile()) => Boolean(getApiKey(auth));

export const fetchQuota = async ({
  readAuth = readAuthFile,
  readOpencodeConfig = readConfig,
  fetchImpl = fetch
} = {}) => {
  const auth = readAuth();
  const entry = getAuthEntryForKilo(auth);
  const apiKey = getApiKey(auth);

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  let organizationId = organizationIdFromEntry(entry);
  if (!organizationId) {
    try {
      organizationId = organizationIdFromConfig(readOpencodeConfig());
    } catch {
      organizationId = null;
    }
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'identity'
    };
    if (organizationId) {
      headers['x-kilocode-organizationid'] = organizationId;
    }

    const response = await fetchImpl(KILO_BALANCE_URL, {
      method: 'GET',
      headers,
      signal: timeoutSignal
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with Kilo Code'
          : `API error: ${response.status}`
      });
    }

    const payload = asObject(await response.json());
    const balance = parseBalance(payload?.balance);

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
        valueLabel: `$${formatMoney(balance)}`
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
