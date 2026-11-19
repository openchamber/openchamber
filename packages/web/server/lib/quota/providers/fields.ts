import { z } from 'zod';
import { toUsageWindow } from '../utils/formatters.js';
import type { UsageWindowInput } from '../utils/contracts.js';

export const hasObjectFields = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

export interface AuthFields {
  key?: unknown;
  token?: unknown;
  type?: unknown;
  access?: unknown;
  orgID?: unknown;
  server?: unknown;
  accountId?: unknown;
  organizationId?: unknown;
  kilocodeOrganizationId?: unknown;
}

export const asAuthFields = z.custom<AuthFields>(hasObjectFields).nullish().parse;

export const asArray = (value: unknown): value is unknown[] => Array.isArray(value);
export const isNumber = (value: unknown): value is number => typeof value === 'number';
export const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

export const propertySource = z.unknown().transform((value): object | null => value == null ? null : Object(value)).parse;

interface ProviderFields {
  Plan?: unknown;
  allowance_usd?: unknown;
  api_budget?: unknown;
  balance?: unknown;
  balance_infos?: unknown;
  balance_usd?: unknown;
  billingCycleEnd?: unknown;
  checklist?: unknown;
  credits?: unknown;
  currency?: unknown;
  current_period_used_percent?: unknown;
  data?: unknown;
  email?: unknown;
  enabled?: unknown;
  error?: unknown;
  included?: unknown;
  included_request_limit?: unknown;
  individualUsage?: unknown;
  individual_limit?: unknown;
  initial_budget?: unknown;
  is_management_key?: unknown;
  items?: unknown;
  kilo?: unknown;
  kilocode?: unknown;
  kilocodeOrganizationId?: unknown;
  limit?: unknown;
  limitMicroCents?: unknown;
  limit_remaining?: unknown;
  limit_reset?: unknown;
  limit_window_seconds?: unknown;
  limits?: unknown;
  model?: unknown;
  monthly_allowance_usd?: unknown;
  name?: unknown;
  options?: unknown;
  organizationId?: unknown;
  overage_request_count?: unknown;
  overall?: unknown;
  pageCount?: unknown;
  pageInfo?: unknown;
  payg_enabled?: unknown;
  percentUsed?: unknown;
  period?: unknown;
  period_end?: unknown;
  plan_name?: unknown;
  plan_tier?: unknown;
  primary_window?: unknown;
  provider?: unknown;
  purchased?: unknown;
  rate_limit?: unknown;
  remaining_included_requests?: unknown;
  remaining_percent?: unknown;
  reset_at?: unknown;
  resetsAt?: unknown;
  resets_at?: unknown;
  secondary_window?: unknown;
  serviceAccountId?: unknown;
  session?: unknown;
  spend_control?: unknown;
  spentMicroCents?: unknown;
  stripe_balance?: unknown;
  sub?: unknown;
  totalRequests?: unknown;
  total_balance?: unknown;
  total_cost_usd?: unknown;
  total_credits?: unknown;
  type?: unknown;
  unit?: unknown;
  unlimited?: unknown;
  until?: unknown;
  usage_monthly?: unknown;
  usage_percentage?: unknown;
  used?: unknown;
  used_percent?: unknown;
  vibe_budget?: unknown;
  vibe_payg_enabled?: unknown;
  weekly?: unknown;
  window_end?: unknown;
  window_start?: unknown;
}

export type FieldSource<Key extends keyof ProviderFields> = Pick<ProviderFields, Key>;

export const readField = <Key extends keyof ProviderFields>(source: FieldSource<NoInfer<Key>> | null | undefined, key: Key) => source?.[key];

export type NumericWindowInput = UsageWindowInput & { usedPercent: number | null; resetAt: number | null };

export const numericUsageWindow = (input: NumericWindowInput) => ({
  ...toUsageWindow(input),
  usedPercent: input.usedPercent,
  resetAt: input.resetAt,
});
