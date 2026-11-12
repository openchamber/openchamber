/**
 * How many automatic turns a goal may take before it stops for the user. The
 * server applies the same bounds (`session-goal/runtime.js`).
 */
export const DEFAULT_SESSION_GOAL_MAX_AUTO_TURNS = 20;
export const SESSION_GOAL_MAX_AUTO_TURNS_LIMIT = 200;

export const isSessionGoalMaxAutoTurns = (value: number): boolean => (
  Number.isInteger(value) && value >= 1 && value <= SESSION_GOAL_MAX_AUTO_TURNS_LIMIT
);
