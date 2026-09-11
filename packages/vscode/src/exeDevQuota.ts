type ExeDevUsageWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: null;
  resetAfterSeconds: number | null;
  resetAt: number;
  resetAtFormatted: string;
  resetAfterFormatted: string | null;
  valueLabel: string;
};

type ExeDevUsagePayload = {
  total_cost_usd?: number | null;
  monthly_allowance_usd?: number | null;
  period_end?: string | null;
};

const EXEC_URL = 'https://exe.dev/exec';
const USAGE_COMMAND = 'billing credits usage --group=day --json';

const numberValue = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value;
};

export const parseExeDevUsage = (payload: ExeDevUsagePayload | null): Record<string, ExeDevUsageWindow> | null => {
  if (!payload) return null;
  const totalCost = numberValue(payload.total_cost_usd);
  const monthlyAllowance = numberValue(payload.monthly_allowance_usd);
  const resetAt = payload.period_end ? Date.parse(payload.period_end) : Number.NaN;
  if (totalCost === null || monthlyAllowance === null || monthlyAllowance < 0 || !Number.isFinite(resetAt)) return null;
  const usedPercent = monthlyAllowance > 0 ? Math.min(100, Math.max(0, (totalCost / monthlyAllowance) * 100)) : null;
  const remainingPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const resetAfterSeconds = Math.max(0, Math.floor((resetAt - Date.now()) / 1000));
  return {
    monthly: {
      usedPercent,
      remainingPercent,
      windowSeconds: null,
      resetAfterSeconds,
      resetAt,
      resetAtFormatted: new Date(resetAt).toLocaleString(),
      resetAfterFormatted: null,
      valueLabel: `$${totalCost.toFixed(2)} / $${monthlyAllowance.toFixed(2)}`,
    },
  };
};

export const fetchExeDevUsage = async (usageToken: string, fetchImpl: typeof fetch = fetch) => {
  const response = await fetchImpl(EXEC_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${usageToken}`,
      'Content-Type': 'text/plain',
      'User-Agent': 'OpenChamber quota provider',
    },
    body: USAGE_COMMAND,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('exe.dev authentication failed');
  if (!response.ok) throw new Error(`exe.dev usage API returned HTTP ${response.status}`);
  const payload: ExeDevUsagePayload | null = await response.text().then((text) => JSON.parse(text)).catch(() => null);
  const windows = parseExeDevUsage(payload);
  if (!windows) throw new Error('exe.dev usage data could not be parsed');
  return windows;
};
