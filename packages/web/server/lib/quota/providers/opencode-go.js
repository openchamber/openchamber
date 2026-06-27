/**
 * OpenCode Go quota provider
 *
 * Cookie-based manual-auth provider for the OpenCode Go + Zen dashboard.
 * Credentials are stored via the credential registry (`getCredential`)
 * and dashboard HTML is fetched through `fetchWithRetry` for timeout,
 * retry, and backoff handling.
 *
 * Canonical API (ported from opencode.ai dashboard SSR, source of truth:
 * mystatus/plugin/mystatus.ts queryOpenCodeGoZenSingle):
 *   GET https://opencode.ai/workspace/<workspaceId>/go       (Go quota windows)
 *   GET https://opencode.ai/workspace/<workspaceId>/billing (Zen balance/payments)
 *   GET https://opencode.ai/workspace/<workspaceId>/usage    (Zen per-model spend)
 *
 * Auth shape (from credentials/schemas.js):
 *   - `workspaceId` (required)
 *   - `authCookie` (required): sent as `auth=<cookie>`
 *   - `accounts[]` (optional): multi-account, each with workspaceId + authCookie
 *
 * On retryable failures (429/5xx after retry exhaustion, network errors,
 * timeouts) the provider falls back to the last successful result marked
 * `isStale: true`. Auth failures (401/403) and parse errors do NOT trigger
 * cache fallback — a stale snapshot cannot confirm whether the credential
 * is still valid.
 *
 * Cookies are never included in error messages.
 *
 * @module quota/providers/opencode-go
 */

import { getCredential } from '../credentials/store.js';
import { fetchWithRetry } from '../utils/fetch.js';
import { buildResult, toUsageWindow } from '../utils/index.js';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode Go';

// Canonical constants (verbatim from mystatus/plugin/mystatus.ts).
const OPENCODE_DASHBOARD_PREFIX = 'https://opencode.ai/workspace/';
const OPENCODE_GO_SUFFIX = '/go';
const OPENCODE_ZEN_BILLING_SUFFIX = '/billing';
const OPENCODE_ZEN_USAGE_SUFFIX = '/usage';
const OPENCODE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0';
const ZEN_UNITS_PER_DOLLAR = 1e8;

// Go quota scrape patterns (verbatim from GO_SCRAPE_PATTERNS).
const GO_SCRAPE_PATTERNS = [
  {
    key: 'rolling',
    label: '5h (rolling)',
    pctFirst:
      /rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*\}/,
    resetFirst:
      /rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*\}/,
  },
  {
    key: 'weekly',
    label: 'Weekly',
    pctFirst:
      /weeklyUsage:\$R\[\d+\]=\{[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*\}/,
    resetFirst:
      /weeklyUsage:\$R\[\d+\]=\{[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*\}/,
  },
  {
    key: 'monthly',
    label: 'Monthly',
    pctFirst:
      /monthlyUsage:\$R\[\d+\]=\{[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*\}/,
    resetFirst:
      /monthlyUsage:\$R\[\d+\]=\{[^}]*resetInSec:(-?\d+(?:\.\d+)?)[^}]*usagePercent:(-?\d+(?:\.\d+)?)[^}]*\}/,
  },
];

/**
 * Parse a single Go quota window from SSR HTML (verbatim parseGoWindow).
 *
 * @param {string} html
 * @param {{ pctFirst: RegExp, resetFirst: RegExp }} pattern
 * @returns {{ usagePercent: number, resetInSec: number } | null}
 */
function parseGoWindow(html, pattern) {
  const pctMatch = pattern.pctFirst.exec(html);
  if (pctMatch) {
    const usagePercent = Number(pctMatch[1]);
    const resetInSec = Number(pctMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  const resetMatch = pattern.resetFirst.exec(html);
  if (resetMatch) {
    const resetInSec = Number(resetMatch[1]);
    const usagePercent = Number(resetMatch[2]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  return null;
}

/**
 * Parse Zen billing SSR HTML (verbatim parseZenBillingHtml).
 *
 * @param {string} html
 * @returns {{ balance: number, monthlyUsage: number, monthlyLimit: number|null, reloadAmount: number, reloadTrigger: number, paymentMethodType: string|null, paymentMethodLast4: string|null } | null}
 */
function parseZenBillingHtml(html) {
  const balance = html.match(/balance:(\d+)/);
  const monthlyUsage = html.match(/monthlyUsage:(\d+)/);
  const monthlyLimit = html.match(/monthlyLimit:(\d+|null)/);
  const reloadAmount = html.match(/reloadAmount:(\d+)/);
  const reloadTrigger = html.match(/reloadTrigger:(\d+)/);
  const payType = html.match(/paymentMethodType:"([^"]+)"/);
  const payLast4 = html.match(/paymentMethodLast4:"([^"]*)"/);

  if (!balance || !monthlyUsage || !reloadAmount || !reloadTrigger) return null;

  return {
    balance: Number(balance[1]),
    monthlyUsage: Number(monthlyUsage[1]),
    monthlyLimit: monthlyLimit ? (monthlyLimit[1] === 'null' ? null : Number(monthlyLimit[1])) : null,
    reloadAmount: Number(reloadAmount[1]),
    reloadTrigger: Number(reloadTrigger[1]),
    paymentMethodType: payType ? payType[1] : null,
    paymentMethodLast4: payLast4 ? payLast4[1] : null,
  };
}

/**
 * Format a Zen payment method label (verbatim zenPaymentLabel).
 *
 * @param {string|null} type
 * @param {string|null} last4
 * @returns {string}
 */
function zenPaymentLabel(type, last4) {
  if (!type) return 'unknown';
  const labels = { link: 'Stripe Link', card: 'Card', bank_account: 'Bank' };
  const name = labels[type] ?? type;
  return last4 ? `${name} \u00b7\u00b7\u00b7${last4}` : name;
}

/**
 * Parse Zen payments SSR HTML (verbatim parseZenPayments).
 *
 * @param {string} html
 * @returns {Array<{ amountUsd: number, timeCreated: string }>}
 */
function parseZenPayments(html) {
  const payments = [];
  const re = /id:"pay_[^"]+",[^]*?amount:(\d+),[^]*?timeCreated:\$R\[\d+\]=new Date\("([^"]+)"\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    payments.push({
      amountUsd: Number(m[1]) / ZEN_UNITS_PER_DOLLAR,
      timeCreated: m[2],
    });
  }
  return payments;
}

/**
 * Parse Zen per-model usage SSR HTML (verbatim parseZenUsageByModel).
 *
 * @param {string} html
 * @returns {Array<{ model: string, costUsd: number, requests: number }>}
 */
function parseZenUsageByModel(html) {
  const modelMap = new Map();
  const re = /model:"([^"]+)"[^}]*cost:(\d+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const model = m[1];
    const cost = Number(m[2]) / ZEN_UNITS_PER_DOLLAR;
    const existing = modelMap.get(model) ?? { cost: 0, requests: 0 };
    existing.cost += cost;
    existing.requests += 1;
    modelMap.set(model, existing);
  }
  return [...modelMap.entries()]
    .map(([model, v]) => ({ model, costUsd: v.cost, requests: v.requests }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Resolve all configured accounts from the credential store.
 *
 * @returns {Array<{ workspaceId: string, authCookie: string, id?: string, name?: string }>}
 */
function resolveConfigs() {
  const record = getCredential(providerId);
  if (!record?.credential) return [];
  const credential = record.credential;

  let configs = [];

  if (Array.isArray(credential.accounts) && credential.accounts.length > 0) {
    configs = credential.accounts
      .filter(
        (a) =>
          a && typeof a.workspaceId === 'string' && typeof a.authCookie === 'string',
      )
      .map((a) => ({
        id: a.id,
        name: a.name,
        workspaceId: a.workspaceId,
        authCookie: a.authCookie,
      }));
  } else if (typeof credential.workspaceId === 'string' && typeof credential.authCookie === 'string') {
    configs = [{ workspaceId: credential.workspaceId, authCookie: credential.authCookie }];
  }

  if (configs.length === 0) {
    return [];
  }

  const unique = new Map();
  for (const config of configs) {
    const key = `${config.workspaceId}\0${config.authCookie}`;
    if (!unique.has(key)) {
      unique.set(key, config);
    }
  }
  return [...unique.values()];
}

export const isConfigured = () => resolveConfigs().length > 0;

/**
 * In-memory cache of the last successful result, keyed by a stable
 * account-set key. Used for stale fallback on transient failures.
 */
const resultCache = new Map();

/**
 * Build a stable cache key from the resolved account set.
 *
 * @param {Array<{ workspaceId: string, id?: string, name?: string }>} configs
 * @returns {string}
 */
function accountSetKey(configs) {
  return configs.map((c) => c.id ?? c.workspaceId).join(',');
}

/**
 * Query a single OpenCode Go + Zen account (faithful to
 * queryOpenCodeGoZenSingle). Returns an account-shaped usage object or
 * null when no dashboard data could be parsed.
 *
 * @param {{ workspaceId: string, authCookie: string, id?: string, name?: string }} config
 * @returns {Promise<{ accountKey: string, label: string, subtitle: string, windows: object, footer?: string[] } | null>}
 */
async function querySingleAccount(config) {
  const label = config.name || config.id || 'OpenCode';
  const headers = {
    'User-Agent': OPENCODE_USER_AGENT,
    Accept: 'text/html',
    Cookie: `auth=${config.authCookie}`,
  };
  const base = OPENCODE_DASHBOARD_PREFIX + encodeURIComponent(config.workspaceId);

  // goRes is authoritative — propagate its failure to the outer catch
  // (stale fallback). billing/usage are best-effort.
  const [goRes, billingRes, usageRes] = await Promise.all([
    fetchWithRetry(base + OPENCODE_GO_SUFFIX, {
      method: 'GET',
      headers,
      maxRetries: 2,
      retryDelay: 1000,
    }),
    fetchWithRetry(base + OPENCODE_ZEN_BILLING_SUFFIX, {
      method: 'GET',
      headers,
      maxRetries: 2,
      retryDelay: 1000,
    }).catch(() => null),
    fetchWithRetry(base + OPENCODE_ZEN_USAGE_SUFFIX, {
      method: 'GET',
      headers,
      maxRetries: 2,
      retryDelay: 1000,
    }).catch(() => null),
  ]);

  const windows = {};

  // Go quota windows.
  if (goRes.ok) {
    const goHtml = await goRes.text();
    for (const pattern of GO_SCRAPE_PATTERNS) {
      const data = parseGoWindow(goHtml, pattern);
      if (!data) continue;
      windows[pattern.key] = toUsageWindow({
        usedPercent: Math.round(Math.max(0, data.usagePercent)),
        windowSeconds: null,
        resetAt: Date.now() + Math.max(0, data.resetInSec) * 1000,
        valueLabel: pattern.label,
      });
    }
  }

  // Zen balance / spend footer.
  const footer = [];
  let billing = null;
  let billingHtml = '';
  if (billingRes?.ok) {
    billingHtml = await billingRes.text();
    billing = parseZenBillingHtml(billingHtml);
  }

  if (billing) {
    const balanceUsd = billing.balance / ZEN_UNITS_PER_DOLLAR;
    const monthlyUsd = billing.monthlyUsage / ZEN_UNITS_PER_DOLLAR;

    footer.push(`Zen balance:    $${balanceUsd.toFixed(2)}`);

    if (billing.paymentMethodType) {
      footer.push(
        `Payment:        ${zenPaymentLabel(billing.paymentMethodType, billing.paymentMethodLast4)}`,
      );
    }

    if (billing.monthlyLimit !== null && billing.monthlyLimit > 0) {
      const limitUsd = billing.monthlyLimit / ZEN_UNITS_PER_DOLLAR;
      const pct = Math.max(0, Math.min(100, Math.round((monthlyUsd / limitUsd) * 100)));
      const remain = 100 - pct;
      footer.push(`${remain}% of $${limitUsd.toFixed(0)}/mo`);
    } else {
      footer.push(`Monthly spend:  $${monthlyUsd.toFixed(2)}`);
    }

    const payments = parseZenPayments(billingHtml);
    if (payments.length > 0) {
      const latest = payments.slice(0, 2);
      footer.push('Payments:       ' + latest.map((p) => `+$${p.amountUsd.toFixed(2)}`).join(', '));
    }

    // Zen per-model cost breakdown (footer only — not forced into usage.models).
    if (usageRes?.ok) {
      const usageHtml = await usageRes.text();
      const modelCosts = parseZenUsageByModel(usageHtml);
      if (modelCosts.length > 0) {
        const top = modelCosts.slice(0, 5);
        const totalCost = modelCosts.reduce((s, m) => s + m.costUsd, 0);
        footer.push('', `Zen spend:      $${totalCost.toFixed(2)} across ${modelCosts.length} models`);
        for (const m of top) {
          footer.push(`  ${m.model.padEnd(22)} $${m.costUsd.toFixed(4)} (${m.requests})`);
        }
      }
    }
  }

  // Skip accounts that yielded neither windows nor footer (canonical behavior).
  if (Object.keys(windows).length === 0 && footer.length === 0) {
    return null;
  }

  return {
    accountKey: config.id ?? label,
    label,
    subtitle: label,
    windows,
    footer: footer.length ? footer : undefined,
  };
}

export const fetchQuota = async () => {
  const configs = resolveConfigs();

  if (configs.length === 0) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const cacheKey = accountSetKey(configs);

  try {
    const accountResults = await Promise.all(configs.map((c) => querySingleAccount(c)));
    const accounts = accountResults.filter((a) => a !== null);

    if (accounts.length === 0) {
      // No account yielded any data — treat as a non-recoverable parse
      // failure (no stale fallback, mirrors canonical "could not parse
      // any dashboard data").
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Could not parse any dashboard data',
      });
    }

    const first = accounts[0];
    const usage = {
      windows: first.windows,
      subtitle: first.label,
      footer: first.footer,
    };

    if (accounts.length > 1) {
      usage.accounts = accounts;
    }

    const result = buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage,
    });

    resultCache.set(cacheKey, { ...result, cachedAt: Date.now() });
    return result;
  } catch (error) {
    // Retryable failure (429/5xx exhausted, network error, timeout).
    // Fall back to cached result if available.
    const cached = resultCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        ok: true,
        isStale: true,
        fetchedAt: Date.now(),
      };
    }
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};
