import type { UsageLimitsInfo } from '@opencode/client';

export type ConsoleBudget = {
  id: string;
  limit: number;
  spent: number;
  usedPercent: number;
  reached: boolean;
  resetsAt: number;
  sharing: 'you' | 'everyone' | 'group';
  perModel: boolean;
  kind: 'all' | 'vendors' | 'price' | 'models' | 'each';
  vendors: string[];
  models: string[];
  inputPriceAtLeast: number | null;
};

export type ConsoleBudgets = {
  workspace: string | null;
  budgets: ConsoleBudget[];
};

export type ConsoleBudgetsRead = ConsoleBudgets & { goSubscribed: boolean };

export function readConsoleBudgets(readLimits?: () => Promise<UsageLimitsInfo | null>): Promise<ConsoleBudgetsRead | null>;
export function withConsoleBudgets<Result extends { ok: boolean; configured: boolean; usage?: object | null }>(
  result: Result,
  consoleBudgets: ConsoleBudgetsRead | null,
): Result;
