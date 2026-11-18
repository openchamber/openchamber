import { z } from 'zod';
import { asNonEmptyString, asObject, toNumber, toTimestamp } from '../utils/transformers.js';
import { formatMoney, toUsageWindow } from '../utils/formatters.js';
import type { UsageWindow } from '../utils/contracts.js';

interface MistralFields {
  initial_budget?: unknown;
  usage_percentage?: unknown;
  currency?: unknown;
  reset_at?: unknown;
  plan_name?: unknown;
  vibe_budget?: unknown;
  api_budget?: unknown;
  payg_enabled?: unknown;
  vibe_payg_enabled?: unknown;
}

interface MistralLabels {
  [name: string]: string | undefined;
}

export interface MistralUsageWindow extends UsageWindow {
  usedPercent: number;
  resetAt: number | null;
}

const isObject = (value: unknown): value is MistralFields => asObject(value) !== null;
const asFields = z.custom<MistralFields | null>(isObject).catch(null).parse;

const BILLING_API_BASE = 'https://api.mistral.ai/v1/billing';
const REQUEST_TIMEOUT_MS = 15_000;
const PLAN_TIMEOUT_MS = 3_000;

const PLAN_TITLES: MistralLabels = { FREE: 'Free', INDIVIDUAL: 'Pro', EDU: 'Student', TEAM: 'Team' };
const CURRENCY_SYMBOLS: MistralLabels = { USD: '$', EUR: '€' };

const formatAmount = (amount: number, currency: string | null) => {
  const value = formatMoney(amount);
  if (!currency) return value;
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol ? `${symbol}${value}` : `${value} ${currency}`;
};

const parseMistralBudget = (value: MistralFields | null, { payg = false } = {}) => {
  const budget = asFields(value);
  if (!budget) return null;
  const initial = toNumber(budget.initial_budget);
  const percent = toNumber(budget.usage_percentage);
  if (initial === null || initial <= 0 || percent === null) return null;

  const usedPercent = Math.max(0, percent);
  const currency = asNonEmptyString(budget.currency)?.toUpperCase() ?? null;
  const spent = formatAmount((initial * usedPercent) / 100, currency);
  const limit = formatAmount(initial, currency);
  const resetAt = toTimestamp(budget.reset_at);
  return { ...toUsageWindow({
    usedPercent,
    windowSeconds: null,
    resetAt,
    valueLabel: `${spent} / ${limit}${payg ? ' · PAYG' : ''}`
  }), resetAt };
};

const parseMistralPlan = (value: MistralFields | null | undefined) => {
  const planName = asNonEmptyString(asFields(value)?.plan_name)?.toUpperCase();
  if (!planName) return null;
  return PLAN_TITLES[planName] ?? planName.charAt(0) + planName.slice(1).toLowerCase();
};

const budgetError = (status: number) => {
  if (status === 401) return new Error('Mistral rejected the API key');
  if (status === 403) return new Error('This Mistral API key has no permission to see the organization usage');
  if (status === 404) return new Error('Mistral does not report usage for this account');
  return new Error(`API error: ${status}`);
};

export const fetchMistralUsage = async (apiKey: string, fetchImpl = fetch) => {
  const request = (path: string, signal: AbortSignal) => fetchImpl(`${BILLING_API_BASE}/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    redirect: 'error',
    signal
  });

  const readBudget = async () => {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const response = await request('budget', signal);
      if (!response.ok) throw budgetError(response.status);
      const payload = asFields(await response.json());
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
      return response.ok ? asFields(await response.json()) : undefined;
    } catch {
      return undefined;
    }
  };

  const [payload, subscription] = await Promise.all([readBudget(), readPlan()]);

  const vibePayg = asFields(payload.vibe_budget)?.payg_enabled ?? asFields(subscription)?.vibe_payg_enabled;
  const windows: Record<string, MistralUsageWindow> = {};
  const vibe = parseMistralBudget(asFields(payload.vibe_budget), { payg: vibePayg === true });
  if (vibe) windows.vibe = vibe;
  const api = parseMistralBudget(asFields(payload.api_budget));
  if (api) windows.api = api;

  if (Object.keys(windows).length === 0) {
    throw new Error('This Mistral plan has no monthly allowance');
  }
  return { windows, planLabel: parseMistralPlan(subscription) };
};
