import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  durationToLabel,
  durationToSeconds,
  asNonEmptyString,
  formatMoney,
  asObject
} from '../utils/index.js';

const MOONSHOT_BALANCE_URL = 'https://api.moonshot.ai/v1/users/me/balance';

// A pay-as-you-go Moonshot platform key (prepaid vouchers, no Kimi Code
// subscription) is refused by the Kimi Code usage address. Its balance is read
// from the platform instead: USD, what remains, with no spent figure.
// Resolves to the credits_balance windows, or null when they cannot be read.
const fetchMoonshotBalanceWindows = async (apiKey, fetchImpl) => {
  try {
    const response = await fetchImpl(MOONSHOT_BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return null;
    const balance = asObject(asObject(await response.json())?.data)?.available_balance;
    if (!Number.isFinite(balance)) return null;
    return {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(balance)}`
      })
    };
  } catch {
    return null;
  }
};

export const providerId = 'kimi-for-coding';
export const providerName = 'Kimi for Coding';
// OpenCode stores the Kimi For Coding plans as `kimi-code-plan-cn` (kimi.com)
// and `kimi-code-plan-global` (kimi.ai). The China plan comes first: its key
// works at the api.kimi.com usage address, and a pre-split `kimi-for-coding`
// key left behind with a dead credential must not shadow it. The global plan
// stays last, as before, since its key is not known to work at that address.
const aliases = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global'];

// The ratio-based `usages` block, in the order Kimi's own CLI renders it.
// `limit_month_code` is deliberately absent: it is the code-typed share of
// `limit_month_total` rather than a second allowance, so it renders inside that
// row's value label. `limit_7d` arrives only on plans that still have a weekly
// quota, and Kimi documents the client as rendering whichever entries are served.
const RATIO_WINDOWS = [
  { key: 'limit_5h', label: '5h', windowSeconds: 5 * 60 * 60 },
  { key: 'limit_7d', label: 'weekly', windowSeconds: 7 * 24 * 60 * 60 },
  { key: 'limit_month_total', label: 'monthly', windowSeconds: null, codeKey: 'limit_month_code' }
];

// `used_ratio` is a 0-1 fraction. An entry without a finite ratio carries no
// information, so it is skipped rather than shown as an unknown percentage.
const toRatioPercent = (entry) => {
  const ratio = toNumber(entry?.used_ratio);
  return ratio === null ? null : Math.max(0, Math.min(100, ratio * 100));
};

const codeShareLabel = (totalPercent, codePercent) => {
  if (totalPercent === null || codePercent === null) return null;
  return `${Math.round(totalPercent)}% · Code ${Math.round(codePercent)}%`;
};

const ratioWindows = (usages) => {
  const windows = {};
  for (const { key, label, windowSeconds, codeKey } of RATIO_WINDOWS) {
    const entry = asObject(usages[key]);
    const usedPercent = toRatioPercent(entry);
    if (usedPercent === null) continue;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds,
      resetAt: toTimestamp(entry.reset_time),
      valueLabel: codeKey ? codeShareLabel(usedPercent, toRatioPercent(asObject(usages[codeKey]))) : null
    });
  }
  return windows;
};

// The pre-ratio payload: one counted weekly `usage` block plus `limits[]`
// rate-limit entries. Plans that have not migrated still answer this way. Its
// `usage` block reports `used`; the `limits[].detail` blocks report `remaining`
// instead. Neither field is guaranteed present, so derive usedPercent from
// whichever one the API actually returned.
const computeUsedPercent = (total, used, remaining) => {
  if (!total) return null;
  if (used !== null) {
    return Math.max(0, Math.min(100, (used / total) * 100));
  }
  if (remaining !== null) {
    return Math.max(0, Math.min(100, 100 - (remaining / total) * 100));
  }
  return null;
};

const legacyWindows = (payload) => {
  const windows = {};
  const usage = asObject(payload?.usage);
  if (usage) {
    windows.weekly = toUsageWindow({
      usedPercent: computeUsedPercent(toNumber(usage.limit), toNumber(usage.used), toNumber(usage.remaining)),
      windowSeconds: null,
      resetAt: toTimestamp(usage.resetTime)
    });
  }

  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  for (const limit of limits) {
    const window = limit?.window;
    const detail = limit?.detail;
    const rawLabel = durationToLabel(window?.duration, window?.timeUnit);
    const windowSeconds = durationToSeconds(window?.duration, window?.timeUnit);
    const label = windowSeconds === 5 * 60 * 60 ? `Rate Limit (${rawLabel})` : rawLabel;
    windows[label] = toUsageWindow({
      usedPercent: computeUsedPercent(toNumber(detail?.limit), toNumber(detail?.used), toNumber(detail?.remaining)),
      windowSeconds,
      resetAt: toTimestamp(detail?.resetTime)
    });
  }
  return windows;
};

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
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

  try {
    const response = await fetchImpl('https://api.kimi.com/coding/v1/usages', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const balanceWindows = await fetchMoonshotBalanceWindows(apiKey, fetchImpl);
        if (balanceWindows) {
          return buildResult({
            providerId,
            providerName,
            ok: true,
            configured: true,
            usage: { windows: balanceWindows }
          });
        }
      }
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    // Kimi replaced the counted payload with a ratio-based `usages` map. Its own
    // client reads only `usages`, so when that block is present the `limits[]`
    // entry for the same 5-hour window is a coarser duplicate and is not read.
    const usages = asObject(asObject(payload)?.usages);
    const windows = usages ? ratioWindows(usages) : legacyWindows(payload);

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
