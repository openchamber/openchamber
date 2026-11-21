import { z } from 'zod';
import { readManagedCredential } from '../credentials/providers.js';
import type { ZenmuxCredential } from '../credentials/contracts.js';
import {
  buildResult,
  toUsageWindow,
  toNumber,
  formatMoney,
  asObject,
  asNonEmptyString
} from '../utils/index.js';

interface ZenmuxFields {
  data?: unknown;
  total_credits?: unknown;
}

const isObject = (value: unknown): value is ZenmuxFields => asObject(value) !== null;
const asFields = z.custom<ZenmuxFields | null>(isObject).catch(null).parse;

export interface ZenmuxDependencies {
  readCredential?: () => ZenmuxCredential | null;
  fetchImpl?: typeof fetch;
}

export const providerId = 'zenmux';
export const providerName = 'ZenMux';
const ZENMUX_BALANCE_URL = 'https://zenmux.ai/api/v1/management/payg/balance';

const readStoredCredential = () => readManagedCredential(providerId);

const getPlatformApiKey = (credential: ZenmuxCredential | null) => asNonEmptyString(credential?.platformApiKey);

const parseCredits = z.unknown().transform((value) => toNumber(asNonEmptyString(value)
  ?? (Number.isFinite(value) ? value : null))).parse;

export const isConfigured = (readCredential = readStoredCredential) => Boolean(getPlatformApiKey(readCredential()));

export const fetchQuota = async ({
  readCredential = readStoredCredential,
  fetchImpl = fetch
}: ZenmuxDependencies = {}) => {
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

    const payload = asFields(await response.json());
    const data = asFields(payload?.data);
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
