
import { z } from 'zod';

import { readOpenCodeUsageLimits } from '../opencode/auth.js';

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

const money = z.number().finite().nonnegative();

const budgetSchema = z.object({
  id: z.string(),
  limit: money,
  spent: money,
  scope: z.enum(['each', 'combined']),
  per: z.enum(['set', 'model']),
  coverage: z.enum(['all', 'models']),
  models: z.array(z.object({ name: z.string() })),
  vendors: z.array(z.string()),
  inputPriceAtLeast: money.optional(),
  picked: z.boolean(),
  shared: z.boolean(),
  resetsAt: z.number().finite(),
});

const limitsSchema = z.object({
  workspace: z.object({ name: z.string().optional() }),
  go: z.unknown().optional(),
  budgets: z.array(z.unknown()),
}).nullable();

const toBudget = (budget: z.infer<typeof budgetSchema>): ConsoleBudget => ({
  id: budget.id,
  limit: budget.limit,
  spent: budget.spent,
  usedPercent: budget.limit > 0 ? Math.min(100, (budget.spent / budget.limit) * 100) : 100,
  reached: budget.spent >= budget.limit,
  resetsAt: budget.resetsAt,
  sharing: budget.scope === 'each' ? 'you' : budget.shared ? 'everyone' : 'group',
  perModel: budget.per === 'model',
  kind: budget.coverage === 'all'
    ? 'all'
    : budget.vendors.length > 0
      ? 'vendors'
      : budget.inputPriceAtLeast !== undefined
        ? 'price'
        : budget.picked ? 'models' : 'each',
  vendors: budget.vendors,
  models: budget.models.map((model) => model.name),
  inputPriceAtLeast: budget.inputPriceAtLeast ?? null,
});

export const withConsoleBudgets = <Result extends { ok: boolean; configured: boolean; usage?: object | null }>(result: Result, consoleBudgets: ConsoleBudgetsRead | null) => {
  if (!consoleBudgets) return result;
  const { goSubscribed, ...shown } = consoleBudgets;
  if (result.ok) return { ...result, usage: { ...(result.usage ?? { windows: {} }), consoleBudgets: shown } };
  if (goSubscribed) return result;
  return { ...result, ok: true, configured: true, usage: { windows: {}, consoleBudgets: shown } };
};

export const readConsoleBudgets = async (readLimits = readOpenCodeUsageLimits): Promise<ConsoleBudgetsRead | null> => {
  try {
    const parsed = limitsSchema.safeParse(await readLimits());
    if (!parsed.success || !parsed.data) return null;
    const budgets = parsed.data.budgets
      .map((entry) => budgetSchema.safeParse(entry))
      .filter((result) => result.success)
      .map((result) => toBudget(result.data))
      .sort((a, b) => (a.limit - a.spent) - (b.limit - b.spent));
    if (budgets.length === 0) return null;
    return { workspace: parsed.data.workspace.name ?? null, budgets, goSubscribed: parsed.data.go !== undefined };
  } catch {
    return null;
  }
};
