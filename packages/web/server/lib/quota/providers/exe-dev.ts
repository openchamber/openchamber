import { z } from 'zod';
import { readManagedCredential } from '../credentials/providers.js';
import type { ExeDevCredential } from '../credentials/contracts.js';
import { asObject, buildResult, formatMoney, toNumber, toTimestamp, toUsageWindow } from '../utils/index.js';

interface ExeDevFields {
  total_cost_usd?: unknown;
  monthly_allowance_usd?: unknown;
  period_end?: unknown;
}

const isObject = (value: unknown): value is ExeDevFields => asObject(value) !== null;
const asFields = z.custom<ExeDevFields | null>(isObject).catch(null).parse;

export const providerId = 'exe-dev';
export const providerName = 'exe.dev';
const EXEC_URL = 'https://exe.dev/exec';
const USAGE_COMMAND = 'billing credits usage --group=day --json';

export const parseExeDevUsage = z.unknown().transform((payload) => {
  const data = asFields(payload);
  if (!data) return null;

  const totalCost = toNumber(data.total_cost_usd);
  const monthlyAllowance = toNumber(data.monthly_allowance_usd);
  const resetAt = toTimestamp(data.period_end);
  if (totalCost === null || monthlyAllowance === null || monthlyAllowance < 0 || resetAt === null) return null;

  const usedPercent = monthlyAllowance > 0
    ? Math.min(100, Math.max(0, (totalCost / monthlyAllowance) * 100))
    : null;
  const spent = formatMoney(totalCost);
  const allowance = formatMoney(monthlyAllowance);
  if (spent === null || allowance === null) return null;

  return {
    monthly: toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel: `$${spent} / $${allowance}`,
    }),
  };
}).parse;

export const fetchExeDevUsage = async (credential: ExeDevCredential, fetchImpl = fetch) => {
  const response = await fetchImpl(EXEC_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${credential.usageToken}`,
      'Content-Type': 'text/plain',
      'User-Agent': 'OpenChamber quota provider',
    },
    body: USAGE_COMMAND,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('exe.dev authentication failed');
  if (!response.ok) throw new Error(`exe.dev usage API returned HTTP ${response.status}`);
  const windows = parseExeDevUsage(await response.json().catch(() => null));
  if (!windows) throw new Error('exe.dev usage data could not be parsed');
  return windows;
};

export const isConfigured = () => Boolean(readManagedCredential(providerId));

export const fetchQuota = async () => {
  const credential = readManagedCredential(providerId);
  if (!credential) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  }

  try {
    const windows = await fetchExeDevUsage(credential);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};
