
interface PlanSaveQueue {
  schedule: (key: string, revision: number, write: () => Promise<void>) => Promise<void>;
  pendingFor: (key: string) => Promise<void>;
  reset: (key: string) => void;
}

export const createPlanSaveQueue = (): PlanSaveQueue => {
  const chains = new Map<string, Promise<void>>();
  const lastRevision = new Map<string, number>();

  return {
    schedule: (key, revision, write) => {
      if (revision <= (lastRevision.get(key) ?? Number.NEGATIVE_INFINITY)) {
        return chains.get(key) ?? Promise.resolve();
      }
      lastRevision.set(key, revision);
      const previous = chains.get(key) ?? Promise.resolve();
      const next = previous.then(write, write);
      chains.set(key, next.catch(() => {
        if (lastRevision.get(key) === revision) {
          lastRevision.delete(key);
        }
      }));
      return next;
    },
    pendingFor: async (key) => {
      await chains.get(key);
    },
    reset: (key) => {
      lastRevision.delete(key);
    },
  };
};
