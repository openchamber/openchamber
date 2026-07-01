import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow
} from '../utils/index.js';

export const providerId = 'zai-coding-plan';
export const providerName = 'z.ai';
const aliases = ['zai-coding-plan', 'zai', 'z.ai'];

const ZAI_BASE_URL = 'https://api.z.ai';

// Canonical unit -> label builder (mystatus.ts ZAI_UNIT_LABELS).
// unit 3: "<n>-hour rolling"; unit 5: "Monthly" (n<30) or "<n/30>-month";
// unit 6: "Weekly".
const ZAI_UNIT_LABELS = {
  3: (n) => `${n}-hour rolling`,
  5: (n) => (n >= 30 ? `${Math.round(n / 30)}-month` : 'Monthly'),
  6: () => 'Weekly'
};

function zaiUnitLabel(unit, number) {
  const fn = ZAI_UNIT_LABELS[unit];
  return fn ? fn(number) : `Unit ${unit}`;
}

// Robustly convert Z.AI's nextResetTime (epoch s or ms; may be missing/NaN) to
// an ISO string. Returns null instead of throwing on bad input — this is the
// fix for the long-standing "Invalid Date" failure that killed the card.
function zaiResetAt(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Sort limits by canonical unit weight: 3 (hourly) -> 6 (weekly) -> 5 (monthly)
// -> everything else last.
const UNIT_WEIGHT = (u) => (u === 3 ? 1 : u === 6 ? 2 : u === 5 ? 3 : 99);

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
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

  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'OpenCode-AllStatus/1.0'
    };

    const [quotaRes, subRes] = await Promise.all([
      fetch(`${ZAI_BASE_URL}/api/monitor/usage/quota/limit`, { method: 'GET', headers }),
      fetch(`${ZAI_BASE_URL}/api/biz/subscription/list`, { method: 'GET', headers })
    ]);

    if (!quotaRes.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${quotaRes.status}`
      });
    }

    const payload = await quotaRes.json();
    if (!payload?.success || !payload?.data?.limits) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: payload?.msg ? `Z.AI quota API returned non-success: ${payload.msg}` : 'No quota data'
      });
    }

    const limits = [...payload.data.limits].sort(
      (a, b) => UNIT_WEIGHT(a.unit) - UNIT_WEIGHT(b.unit)
    );

    // Subscription header (plan / price / validity / renewal).
    const header = [];
    let planLabel = `GLM Coding (${payload.data.level ?? 'unknown'})`;
    let priceLine = '';
    let validityLine = '';
    let renewalLine = '';

    if (subRes.ok) {
      try {
        const subData = await subRes.json();
        const active = (subData?.data ?? []).find(
          (s) => s?.status === 'VALID' && s?.inCurrentPeriod
        );
        if (active) {
          planLabel = active.productName ?? planLabel;
          const priceUsd = `$${typeof active.actualPrice === 'number' ? active.actualPrice.toFixed(2) : '?'}`;
          priceLine = `Price:           ${priceUsd}/${active.billingCycle ?? '?'}`;
          renewalLine = active.autoRenew
            ? `Auto-renews:     ${active.nextRenewTime ?? 'unknown'}`
            : `Expires:         ${active.nextRenewTime ?? 'unknown'}`;
          const parts = typeof active.valid === 'string' ? active.valid.split('-', 2) : [];
          if (parts.length === 2) {
            validityLine = `Valid:           ${parts[0].trim()} to ${parts[1].trim()}`;
          }
        }
      } catch {
        // Subscription endpoint is best-effort; ignore parse failures.
      }
    }

    header.push(`Plan:           ${planLabel}`);
    if (priceLine) header.push(priceLine);
    if (validityLine) header.push(validityLine);
    if (renewalLine) header.push(renewalLine);

    const windows = {};
    for (const limit of limits) {
      const usedPercent = typeof limit?.percentage === 'number' ? limit.percentage : null;
      const resetAt = zaiResetAt(limit?.nextResetTime);
      const label = zaiUnitLabel(limit?.unit, limit?.number);

      const detail = [];
      if (
        limit?.type === 'TIME_LIMIT' &&
        typeof limit.remaining === 'number' &&
        typeof limit.usage === 'number'
      ) {
        detail.push(`Used: ${limit.usage} / ${limit.remaining + limit.usage}`);
      }

      const extra = [];
      if (Array.isArray(limit?.usageDetails) && limit.usageDetails.length) {
        const withUsage = limit.usageDetails.filter((d) => d?.usage > 0);
        if (withUsage.length) {
          extra.push('  ' + withUsage.map((d) => `${d.modelCode}: ${d.usage}`).join(', '));
        }
      }

      windows[label] = toUsageWindow({
        usedPercent,
        resetAt,
        suffix: 'token quota',
        trendKey: `zai-coding-plan:${label}`,
        ...(detail.length ? { detail } : {}),
        ...(extra.length ? { extra } : {})
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows, header, subtitle: 'z.ai Coding Plan' }
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