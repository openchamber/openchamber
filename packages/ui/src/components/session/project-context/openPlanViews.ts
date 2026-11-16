/**
 * The plans open in a `PlanView` right now. Moving a plan between the user's
 * and the team's folder moves its file and can change its id, so a move first
 * holds the plan: its open view stops taking typing, and what was typed is
 * written under the plan as it is before the move. The move runs only when
 * that write succeeded; otherwise the text would be lost with the old file.
 *
 * The hold belongs to the plan, not to one view: a view of it opened while
 * the move runs (closed and opened again) is held from the start.
 */
type OpenPlanView = {
  /** Makes the editor read-only (or writable again). */
  setHeld: (held: boolean) => void;
  /** Writes the typing so far; resolves true once it is on disk. */
  flush: () => Promise<boolean>;
};

const openPlans = new Map<string, OpenPlanView>();
const heldPlans = new Set<string>();

const keyOf = (projectId: string, planId: string): string => `${projectId}\u0000${planId}`;

export const registerOpenPlan = (projectId: string, planId: string, view: OpenPlanView): (() => void) => {
  const key = keyOf(projectId, planId);
  openPlans.set(key, view);
  // Set either way: one view is reused for the next plan, and the hold of the
  // plan it showed before must not carry over.
  view.setHeld(heldPlans.has(key));
  return () => {
    if (openPlans.get(key) === view) openPlans.delete(key);
  };
};

/**
 * Holds this plan and writes its open view's typing, if a view is open.
 * `saved` is false when that write failed; `release` gives whichever view is
 * open by then its editor back.
 */
export const holdOpenPlan = async (projectId: string, planId: string): Promise<{ saved: boolean; release: () => void }> => {
  const key = keyOf(projectId, planId);
  heldPlans.add(key);
  const release = () => {
    heldPlans.delete(key);
    openPlans.get(key)?.setHeld(false);
  };
  const view = openPlans.get(key);
  if (!view) return { saved: true, release };
  view.setHeld(true);
  try {
    return { saved: await view.flush(), release };
  } catch {
    return { saved: false, release };
  }
};
