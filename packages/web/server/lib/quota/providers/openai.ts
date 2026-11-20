import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow
} from '../utils/index.js';
import { asAuthFields, propertySource, readField } from './fields.js';
import type { QuotaResult, UsageWindow } from '../utils/contracts.js';

const providerId = 'openai';
const providerName = 'OpenAI';
const aliases = ['openai', 'codex', 'chatgpt'];

type OpenAiWindows = Partial<Record<'5h' | 'weekly', UsageWindow<unknown, unknown>>>;
export type OpenAiQuotaResult = QuotaResult<typeof providerId, typeof providerName, { windows: OpenAiWindows }>;

const formatWindow = (window: NonNullable<ReturnType<typeof propertySource>>) => {
  const usedPercent = readField(window, 'used_percent') ?? null;
  const windowSeconds = readField(window, 'limit_window_seconds') ?? null;
  const resetAt = readField(window, 'reset_at');
  return toUsageWindow({
    usedPercent,
    windowSeconds,
    resetAt: resetAt ? +resetAt * 1000 : null
  });
};

export const fetchQuota = async (): Promise<OpenAiQuotaResult> => {
  const auth = await readOpenCodeCredentials();
  const entry = asAuthFields(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  const accessToken = entry?.access ?? entry?.token;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload: unknown = await response.json();
    const rateLimit = propertySource(readField(propertySource(payload), 'rate_limit'));
    const primary = readField(rateLimit, 'primary_window');
    const secondary = readField(rateLimit, 'secondary_window');

    const windows: OpenAiWindows = {};
    const primaryFields = primary ? propertySource(primary) : null;
    if (primaryFields) windows['5h'] = formatWindow(primaryFields);
    const secondaryFields = secondary ? propertySource(secondary) : null;
    if (secondaryFields) windows.weekly = formatWindow(secondaryFields);

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
