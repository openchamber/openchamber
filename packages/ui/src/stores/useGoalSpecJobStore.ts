import { create } from 'zustand';

import type { GoalSpecJob, GoalSpecJobRemoved } from '@/lib/goalSpecJobs';

/**
 * The goal writer jobs the server holds ("Send when ready"), as the server
 * last reported them: read in full when the app starts, the runtime changes
 * or the control stream reconnects, then kept current by its events. Failure
 * to read leaves the previous jobs in place: an unread list is not "none".
 */
interface GoalSpecJobStore {
  jobs: Record<string, GoalSpecJob>;
  replaceAll: (jobs: readonly GoalSpecJob[]) => void;
  upsert: (job: GoalSpecJob) => void;
  remove: (removed: Pick<GoalSpecJobRemoved, 'id'>) => void;
  reset: () => void;
}

export const useGoalSpecJobStore = create<GoalSpecJobStore>((set) => ({
  jobs: {},
  replaceAll: (jobs) => set({ jobs: Object.fromEntries(jobs.map((job) => [job.id, job])) }),
  // An update older than the job already held is a late event; it is dropped.
  upsert: (job) => set((state) => {
    const held = state.jobs[job.id];
    if (held && held.updatedAt > job.updatedAt) return state;
    return { jobs: { ...state.jobs, [job.id]: job } };
  }),
  remove: ({ id }) => set((state) => {
    if (!state.jobs[id]) return state;
    const jobs = { ...state.jobs };
    delete jobs[id];
    return { jobs };
  }),
  reset: () => set({ jobs: {} }),
}));
