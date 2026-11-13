/**
 * OpenCode Console budgets: the monthly spend limits a Console workspace sets
 * on its member, read from the running OpenCode (`GET
 * /api/experimental/usage/limits`, OpenCode 2.2) through
 * `../opencode/auth.js`. OpenCode resolves the active `opencode` Console
 * sign-in itself and answers `null` without one, so an API key shows none.
 *
 * Shared by the web server and the VS Code extension host, which both show
 * them on the OpenCode Go usage page only.
 */

import { z } from 'zod';

import { readOpenCodeUsageLimits } from '../opencode/auth.js';

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

/**
 * One budget as the usage page shows it. `sharing` is who spends against it:
 * the member alone, everyone in the workspace, or a group of members. `kind`
 * is what it counts, in the order the Console names it: all spend, a vendor's
 * models, models from an input price, picked models, or each model.
 */
const toBudget = (budget) => ({
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

/**
 * The OpenCode Go result with the Console budgets beside its windows. A failed
 * Go read stays a failure, so the page keeps the meters it last showed, unless
 * the workspace has no Go at all: then there are no meters to keep, and the
 * budgets show with the Go error stated beside them.
 */
export const withConsoleBudgets = (result, consoleBudgets) => {
  if (!consoleBudgets) return result;
  const { goSubscribed, ...shown } = consoleBudgets;
  if (result.ok) return { ...result, usage: { ...(result.usage ?? { windows: {} }), consoleBudgets: shown } };
  if (goSubscribed) return result;
  return { ...result, ok: true, configured: true, usage: { windows: {}, consoleBudgets: shown } };
};

/**
 * `{ workspace, budgets, goSubscribed }`, budgets ordered by what runs out
 * first, or null when there is no Console sign-in, no budget, or OpenCode
 * cannot be asked. Best-effort:
 * the Go meters on the same page never wait on or fail with it. A budget that
 * does not parse is dropped alone.
 */
export const readConsoleBudgets = async (readLimits = readOpenCodeUsageLimits) => {
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
