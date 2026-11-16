import { asNonEmptyString, asObject, toNumber, toTimestamp } from '../utils/transformers.js';
import { formatMoney, toUsageWindow } from '../utils/formatters.js';

// Mistral's billing routes are the ones its own Vibe CLI reads with a plain API
// key (`vibe/app_server/_billing.py`); they are not in the public API docs.
const BILLING_API_BASE = 'https://api.mistral.ai/v1/billing';
const REQUEST_TIMEOUT_MS = 15_000;
// The plan only names the card, so a slow answer is not worth holding the usage for.
const PLAN_TIMEOUT_MS = 3_000;

// The names the billing API gives the plans, titled the way Vibe titles them.
const PLAN_TITLES = { FREE: 'Free', INDIVIDUAL: 'Pro', EDU: 'Student', TEAM: 'Team' };
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€' };

const formatAmount = (amount, currency) => {
  const value = formatMoney(amount);
  if (!currency) return value;
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol ? `${symbol}${value}` : `${value} ${currency}`;
};

/**
 * One monthly allowance from `/billing/budget`. Without a positive
 * `initial_budget` the plan has no allowance of that kind, so there is no row.
 */
const parseMistralBudget = (value, { payg = false } = {}) => {
  const budget = asObject(value);
  if (!budget) return null;
  const initial = toNumber(budget.initial_budget);
  const percent = toNumber(budget.usage_percentage);
  if (initial === null || initial <= 0 || percent === null) return null;

  // Past 100% is real: pay-as-you-go bills the overage, so the share is not capped.
  const usedPercent = Math.max(0, percent);
  const currency = asNonEmptyString(budget.currency)?.toUpperCase() ?? null;
  const spent = formatAmount((initial * usedPercent) / 100, currency);
  const limit = formatAmount(initial, currency);
  return toUsageWindow({
    usedPercent,
    windowSeconds: null,
    resetAt: toTimestamp(budget.reset_at),
    valueLabel: `${spent} / ${limit}${payg ? ' · PAYG' : ''}`
  });
};

const parseMistralPlan = (value) => {
  const planName = asNonEmptyString(asObject(value)?.plan_name)?.toUpperCase();
  if (!planName) return null;
  return PLAN_TITLES[planName] ?? planName.charAt(0) + planName.slice(1).toLowerCase();
};

const budgetError = (status) => {
  if (status === 401) return new Error('Mistral rejected the API key');
  if (status === 403) return new Error('This Mistral API key has no permission to see the organization usage');
  if (status === 404) return new Error('Mistral does not report usage for this account');
  return new Error(`API error: ${status}`);
};

/**
 * Reads the monthly allowances of the organization behind `apiKey`: the Vibe
 * one and the API one, each a `monthly`-style window. The plan name is
 * best-effort; a failed budget read fails the refresh.
 */
export const fetchMistralUsage = async (apiKey, fetchImpl = fetch) => {
  const request = (path, signal) => fetchImpl(`${BILLING_API_BASE}/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    redirect: 'error',
    signal
  });

  // The budget body is read inside its own task, so a slow plan read cannot
  // run its deadline out while the budget is already here.
  const readBudget = async () => {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const response = await request('budget', signal);
      if (!response.ok) throw budgetError(response.status);
      const payload = asObject(await response.json());
      if (!payload) throw new SyntaxError('budget is not an object');
      return payload;
    } catch (error) {
      if (signal.aborted) throw new Error('Request timed out');
      if (error instanceof SyntaxError) throw new Error('Invalid response from provider');
      throw error instanceof Error ? error : new Error('Request failed');
    }
  };
  const readPlan = async () => {
    try {
      const response = await request('subscription', AbortSignal.timeout(PLAN_TIMEOUT_MS));
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };

  const [payload, subscription] = await Promise.all([readBudget(), readPlan()]);

  const vibePayg = asObject(payload.vibe_budget)?.payg_enabled ?? asObject(subscription)?.vibe_payg_enabled;
  const windows = {};
  const vibe = parseMistralBudget(payload.vibe_budget, { payg: vibePayg === true });
  if (vibe) windows.vibe = vibe;
  const api = parseMistralBudget(payload.api_budget);
  if (api) windows.api = api;

  if (Object.keys(windows).length === 0) {
    throw new Error('This Mistral plan has no monthly allowance');
  }
  return { windows, planLabel: parseMistralPlan(subscription) };
};
