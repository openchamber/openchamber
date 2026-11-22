/**
 * How long an agent's question waits for an answer before OpenChamber closes
 * it, so the agent goes on without one. `0` keeps a question open until the
 * user answers or dismisses it. The clock starts when this client first sees
 * the question (`sync/question-timeouts.ts`).
 */
export const QUESTION_TIMEOUT_MINUTES_DEFAULT = 0;
export const QUESTION_TIMEOUT_MINUTES_MIN = 0;
/** One day: a question nobody answers in a day is not waiting for this client. */
export const QUESTION_TIMEOUT_MINUTES_MAX = 1440;

export const clampQuestionTimeoutMinutes = (value: number): number => (
  Number.isFinite(value)
    ? Math.max(QUESTION_TIMEOUT_MINUTES_MIN, Math.min(QUESTION_TIMEOUT_MINUTES_MAX, Math.round(value)))
    : QUESTION_TIMEOUT_MINUTES_DEFAULT
);

/** When a question first seen at `seenAt` times out; null when questions never time out. */
export const questionDeadline = (seenAt: number, timeoutMinutes: number): number | null => (
  timeoutMinutes > 0 ? seenAt + timeoutMinutes * 60_000 : null
);

/** Whole minutes left before `deadline`, rounded up, never below 0. */
export const minutesUntil = (deadline: number, now: number): number => Math.max(0, Math.ceil((deadline - now) / 60_000));

/**
 * How the agent should treat answers given after its question ended:
 * `exact` overrides what it did meanwhile, `fyi` only informs, and
 * `consider` applies where the agent has not settled the point yet.
 */
export const LATE_ANSWER_MODES = ['consider', 'exact', 'fyi'] as const;
export type LateAnswerMode = (typeof LATE_ANSWER_MODES)[number];
export const DEFAULT_LATE_ANSWER_MODE: LateAnswerMode = 'consider';
