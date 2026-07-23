import { TunnelCliError, EXIT_CODE } from './cli-errors.js';

export const parseGoalTokenBudget = (options) => {
  if (options.goalTokenBudget === undefined) return undefined;
  if (options.goal !== true) {
    throw new TunnelCliError('--goal-token-budget requires --goal.', EXIT_CODE.USAGE_ERROR);
  }
  const raw = String(options.goalTokenBudget).trim();
  if (!/^\d+$/.test(raw)) {
    throw new TunnelCliError('--goal-token-budget must be an integer from 1000 to 100000000.', EXIT_CODE.USAGE_ERROR);
  }
  const budget = Number(raw);
  if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 100000000) {
    throw new TunnelCliError('--goal-token-budget must be an integer from 1000 to 100000000.', EXIT_CODE.USAGE_ERROR);
  }
  return budget;
};
