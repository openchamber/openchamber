import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  formatMoney,
  normalizeTimestamp
} from '../utils/index.js';

export const providerId = 'commandcode';
export const providerName = 'Command Code';
const aliases = ['commandcode'];

const COMMANDCODE_CREDITS_URL = 'https://api.commandcode.ai/alpha/billing/credits';

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

const computeUsedPercent = (used, cap) => {
  const usedValue = toNumber(used);
  const capValue = toNumber(cap);
  if (usedValue === null || capValue === null || capValue <= 0) return null;
  return Math.max(0, Math.min(100, (usedValue / capValue) * 100));
};

const toWindow = (windowEntry, windowSeconds) => {
  if (!windowEntry || typeof windowEntry !== 'object') return null;
  const used = toNumber(windowEntry.used);
  const cap = toNumber(windowEntry.cap);
  const rawResetAt = windowEntry.resetAt;
  // resetAt === 0 means the window was never activated — omit it entirely
  if (rawResetAt === 0) return null;
  const resetAt = normalizeTimestamp(rawResetAt);
  const usedPercent = computeUsedPercent(used, cap);
  return toUsageWindow({ usedPercent, windowSeconds, resetAt });
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

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
    const response = await fetch(COMMANDCODE_CREDITS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'cli',
        'x-cli-environment': 'production'
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
          ? 'Session expired — please re-authenticate with Command Code'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const credits = payload && typeof payload === 'object' ? payload.credits : null;
    const windowLimits = payload && typeof payload === 'object' ? payload.windowLimits : null;

    const windows = {};

    if (windowLimits && typeof windowLimits === 'object' && windowLimits.limited !== false) {
      const fiveHour = toWindow(windowLimits.fiveHour, 5 * 60 * 60);
      const weekly = toWindow(windowLimits.weekly, 7 * 24 * 60 * 60);
      if (fiveHour) windows['5h'] = fiveHour;
      if (weekly) windows.weekly = weekly;
    }

    if (credits && typeof credits === 'object') {
      const monthlyCredits = toNumber(credits.monthlyCredits);
      const purchasedCredits = toNumber(credits.purchasedCredits);
      const freeCredits = toNumber(credits.freeCredits);
      const creditValues = [monthlyCredits, purchasedCredits, freeCredits];

      // Only render the balance row when the API actually reports a balance;
      // a fully-missing credits block must not show a literal $0.00.
      if (creditValues.some((value) => value !== null)) {
        const totalCredits = creditValues.reduce((sum, value) => sum + value, 0);

        windows.credits_balance = toUsageWindow({
          usedPercent: null,
          windowSeconds: null,
          resetAt: null,
          valueLabel: `$${formatMoney(totalCredits)}`
        });
      }
    }

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
