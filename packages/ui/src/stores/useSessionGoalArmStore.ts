import { create } from 'zustand';
import type { GoalSubmitChoice } from '@/lib/goalWriter';

// Narrow store for the "next message starts a goal" flag. Armed by the
// composer target button (works for existing sessions AND session drafts)
// and by the run-as-goal flows (fork dialog, plan send); consumed by
// sendMessage in session-ui-store, which turns the sent prompt into the
// goal objective — unless the arming flow supplied a richer objective
// override (e.g. the plan content instead of "Implement this plan: X").
interface SessionGoalArm {
  armed: boolean;
  objectiveOverride: string | null;
  /**
   * The objective is settled: the goal writer produced it, or the user chose
   * their own text over it. "Rewrite every goal" leaves a settled objective alone.
   */
  settled: boolean;
  /**
   * The sent message is not the objective (a written spec sent with the
   * original message), so the goal reminder carries the objective to the agent.
   */
  briefAgent: boolean;
  /** The user switched the goal length limit off for this goal. */
  ignoreLimit: boolean;
}

interface SessionGoalArmStore extends SessionGoalArm {
  setArmed: (
    armed: boolean,
    objectiveOverride?: string | null,
    options?: { settled?: boolean; briefAgent?: boolean; ignoreLimit?: boolean },
  ) => void;
  /** Read-and-clear in one step at send time. */
  consume: () => SessionGoalArm;
}

const DISARMED: SessionGoalArm = { armed: false, objectiveOverride: null, settled: false, briefAgent: false, ignoreLimit: false };

export const useSessionGoalArmStore = create<SessionGoalArmStore>((set, get) => ({
  ...DISARMED,
  setArmed: (armed, objectiveOverride = null, options = {}) => set(armed
    ? {
        armed,
        objectiveOverride,
        settled: options.settled === true,
        briefAgent: options.briefAgent === true && Boolean(objectiveOverride),
        ignoreLimit: options.ignoreLimit === true,
      }
    : DISARMED),
  consume: () => {
    const { armed, objectiveOverride, settled, briefAgent, ignoreLimit } = get();
    if (armed) set(DISARMED);
    return { armed, objectiveOverride, settled, briefAgent, ignoreLimit };
  },
}));

/**
 * Arms the composer again with a goal that left with a queued message: when the
 * message comes back to the composer to be edited, or when queueing it failed.
 * The flags come back with it, so a retry neither rewrites a settled spec nor
 * drops the briefing or the length choice.
 */
export const rearmQueuedGoal = (goal: {
  objective?: string | null;
  settled?: boolean;
  briefAgent?: boolean;
  ignoreLimit?: boolean;
}): void => {
  useSessionGoalArmStore.getState().setArmed(true, goal.objective ?? null, {
    settled: goal.settled === true,
    briefAgent: goal.briefAgent === true,
    ignoreLimit: goal.ignoreLimit === true,
  });
};

/**
 * The goal writer's choice for a send, as the composer arm. ChatInput applies
 * it right before the message leaves, sent or queued, so an early return that
 * sends nothing never leaves a stale arm behind. A spec choice is settled: the
 * writer produced the objective, so nothing rewrites it. It briefs the agent
 * only when the original message goes with it; sent as the message itself, the
 * spec needs no briefing.
 */
export const applyGoalChoice = (choice: GoalSubmitChoice | undefined): void => {
  if (!choice) return;
  const goalArm = useSessionGoalArmStore.getState();
  if (choice.kind === 'none') goalArm.setArmed(false);
  else if (choice.kind === 'unchanged') goalArm.setArmed(true, null, { settled: true });
  else goalArm.setArmed(true, choice.spec, { settled: true, briefAgent: choice.sendMode === 'with-message', ignoreLimit: choice.ignoreLimit });
};
