import { asNonEmptyString, toNumber, toTimestamp } from '../utils/transformers.js';
import { formatMoney } from '../utils/formatters.js';
import { numericUsageWindow, propertySource, readField } from './fields.js';

import type { FieldSource } from './fields.js';

const toMeterNumber = (source: FieldSource<'used' | 'limit'> | null, key: 'used' | 'limit') => {
  const value = readField(source, key);
  return /^\s*$/.test(`${value}`) ? null : toNumber(value);
};

export const fetchCursorSummaryWindow = async (accessToken: string) => {
  let subject;
  try {
    const part = accessToken.split('.')[1];
    if (part === undefined) return null;
    const claims = propertySource(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
    subject = asNonEmptyString(readField(claims, 'sub'));
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
  const summary = propertySource(await response.json());
  const individualUsage = propertySource(readField(summary, 'individualUsage'));
  const overall = propertySource(readField(individualUsage, 'overall'));
  const used = toMeterNumber(overall, 'used');
  const limit = toMeterNumber(overall, 'limit');
  if (readField(overall, 'enabled') !== true || used === null || used < 0 || limit === null || limit <= 0) return null;

  const resetAt = toTimestamp(readField(summary, 'billingCycleEnd'));
  const windowSeconds = resetAt ? Math.max(0, Math.floor((resetAt - Date.now()) / 1000)) : null;
  return numericUsageWindow({
    usedPercent: Math.min(100, (used / limit) * 100),
    windowSeconds,
    resetAt,
    valueLabel: `$${formatMoney(used / 100)} / $${formatMoney(limit / 100)}`,
  });
};
