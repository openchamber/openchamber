import { asNonEmptyString, toNumber, toTimestamp } from '../utils/transformers.js';
import { formatMoney, toUsageWindow } from '../utils/formatters.js';

const toMeterNumber = (value) => (/^\s*$/.test(value) ? null : toNumber(value));

export const fetchCursorSummaryWindow = async (accessToken) => {
  let subject;
  try {
    subject = asNonEmptyString(JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')).sub);
  } catch {
    return null;
  }
  if (!subject) return null;
  const parts = subject.split('|');
  const userId = parts.length > 1 ? parts[1] : parts[0];
  if (!userId) return null;

  const response = await fetch('https://cursor.com/api/usage-summary', {
    redirect: 'error',
    headers: {
      Cookie: `WorkosCursorSessionToken=${encodeURIComponent(userId)}%3A%3A${encodeURIComponent(accessToken)}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const summary = await response.json();
  const overall = summary?.individualUsage?.overall;
  const used = toMeterNumber(overall?.used);
  const limit = toMeterNumber(overall?.limit);
  if (overall?.enabled !== true || used === null || used < 0 || limit === null || limit <= 0) return null;

  const resetAt = toTimestamp(summary.billingCycleEnd);
  const windowSeconds = resetAt ? Math.max(0, Math.floor((resetAt - Date.now()) / 1000)) : null;
  return toUsageWindow({
    usedPercent: Math.min(100, (used / limit) * 100),
    windowSeconds,
    resetAt,
    valueLabel: `$${formatMoney(used / 100)} / $${formatMoney(limit / 100)}`,
  });
};
