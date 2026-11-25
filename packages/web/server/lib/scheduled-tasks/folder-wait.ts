import { directoryReachability, directoryUnreachableError } from '../directory-reachability/index.js';
import type { ScheduledTask, ScheduledTaskStatePatch, ScheduledTaskStore } from '../projects/contracts.js';

const RECHECK_MS = 15_000;

export type DueMs = (task: ScheduledTask) => number | null;

const isOnce = (task: ScheduledTask) => task.schedule.kind === 'once';

export const createFolderWait = ({ store, dueMsOf, folderOf, isUnreachable = directoryReachability.isUnreachable, recheckMs = RECHECK_MS }: {
  store: ScheduledTaskStore;
  dueMsOf: DueMs;
  folderOf: (projectID: string) => Promise<string | null>;
  isUnreachable?: ((directory: string) => Promise<boolean>) | undefined;
  recheckMs?: number | undefined;
}) => {
  const pendingFor = (task: ScheduledTask): number | null => {
    const due = task.state?.waitingForFolder;
    return due !== undefined && task.enabled && isOnce(task) && dueMsOf(task) === due ? due : null;
  };

  const offlineFolder = async (projectID: string) => {
    const folder = await folderOf(projectID);
    return folder && await isUnreachable(folder) ? folder : null;
  };

  const wait = async (projectID: string, task: ScheduledTask, due: number, { claimed = false } = {}) => {
    const folder = await folderOf(projectID);
    const patch: ScheduledTaskStatePatch = {
      waitingForFolder: due,
      lastStatus: 'queued',
      lastError: directoryUnreachableError(folder ?? '').message,
      nextRunAt: undefined,
    };
    if (claimed) patch.lastScheduledFor = undefined;
    const belongs = (candidate: ScheduledTask) => (
      candidate.enabled && isOnce(candidate) && dueMsOf(candidate) === due
      && (claimed || candidate.state.lastScheduledFor !== due)
    );
    if (store.updateScheduledTaskStateIf) return store.updateScheduledTaskStateIf(projectID, task.id, belongs, patch);
    const result = await store.updateScheduledTaskState(projectID, task.id, patch);
    return { ...result, updated: Boolean(result.task) };
  };

  const staleWaitPatch = (task: ScheduledTask): ScheduledTaskStatePatch => (
    task.state?.waitingForFolder !== undefined && pendingFor(task) === null
      ? { waitingForFolder: undefined, lastStatus: 'idle', lastError: undefined }
      : {}
  );

  return { pendingFor, offlineFolder, wait, staleWaitPatch, recheckMs };
};
