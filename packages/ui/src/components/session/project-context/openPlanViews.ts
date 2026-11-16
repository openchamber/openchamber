type OpenPlanView = {
  setHeld: (held: boolean) => void;
  flush: () => Promise<boolean>;
};

const openPlans = new Map<string, OpenPlanView>();
const heldPlans = new Set<string>();

const keyOf = (projectId: string, planId: string): string => `${projectId}\u0000${planId}`;

export const registerOpenPlan = (projectId: string, planId: string, view: OpenPlanView): (() => void) => {
  const key = keyOf(projectId, planId);
  openPlans.set(key, view);
  view.setHeld(heldPlans.has(key));
  return () => {
    if (openPlans.get(key) === view) openPlans.delete(key);
  };
};

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
