import type { SessionActivityProbe } from './opencode/session-activity.js';
import { readSessionActivity, type SessionStateReader, type DesktopUpdateIdle } from './desktop-update-idle.js';

type DesktopUpdateTerminal = { status: string; mode?: string | null };

type LiveWork = {
  load: () => Promise<void>;
  hasLiveWork: () => boolean;
};

export const createDesktopUpdateActiveSessionReadiness = ({
  readStatuses,
  isConnected,
  adoptRunning,
}: {
  readStatuses: SessionActivityProbe['fetchActiveSessionStatuses'];
  isConnected: () => boolean;
  adoptRunning: (ids: string[], readAt: number) => void;
}) => {
  let generation = 0;
  let reconciled = false;
  let inFlight: Promise<void> | null = null;

  const reconcile = async () => {
    const current = ++generation;
    reconciled = false;
    const readAt = Date.now();
    const statuses = await readStatuses();
    if (current !== generation || !isConnected() || !statuses) return;
    adoptRunning(Object.keys(statuses), readAt);
    reconciled = true;
  };

  const connect = () => {
    const run = reconcile().finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  };

  return {
    disconnect: () => {
      generation += 1;
      reconciled = false;
      inFlight = null;
    },
    connect,
    ensureReady: async () => {
      if (reconciled) return true;
      if (!isConnected()) return false;
      await (inFlight ?? connect());
      return reconciled;
    },
    isReady: () => reconciled,
  };
};

export type DesktopUpdateIdleParts = {
  canReadSessions: () => boolean | Promise<boolean>;
  sessionRuntime: SessionStateReader;
  readBackgroundJobs?: SessionActivityProbe['fetchAllRunningBackgroundJobs'];
  terminalRuntime: { listTerminals: () => readonly DesktopUpdateTerminal[] } | null;
  scheduledTasksRuntime: {
    getStatus: () => { runningScheduledTasksCount: number; queuedScheduledTasksCount: number };
  };
  workflowRuntime: { hasLiveRun: () => boolean };
  sessionGoalRuntime: { hasLiveWork: () => boolean };
  sessionAssistRuntime: { hasLiveWork: () => boolean };
  messageQueueRuntime: LiveWork;
  autoReviewRuntime: LiveWork;
};

export const collectDesktopUpdateIdle = async (parts: DesktopUpdateIdleParts): Promise<DesktopUpdateIdle> => {
  const unreadable: DesktopUpdateIdle = { state: 'unknown' };
  try {
    const catalogs = [parts.messageQueueRuntime, parts.autoReviewRuntime];
    await Promise.all(catalogs.map((owner) => owner.load()));
    if (!(await parts.canReadSessions())) return unreadable;
    const sessions = readSessionActivity(parts.sessionRuntime);
    if (parts.sessionAssistRuntime.hasLiveWork()) return { state: 'busy' };
    const scheduled = parts.scheduledTasksRuntime.getStatus();
    const terminals = parts.terminalRuntime?.listTerminals();
    const background = [
      parts.workflowRuntime.hasLiveRun(),
      parts.sessionGoalRuntime.hasLiveWork(),
      parts.messageQueueRuntime.hasLiveWork(),
      parts.autoReviewRuntime.hasLiveWork(),
    ];
    if (!terminals) return unreadable;
    if (sessions !== 'idle') return { state: sessions };
    const running = terminals.filter((terminal) => terminal.status === 'running');
    if (running.some(({ mode }) => mode && mode !== 'command' && mode !== 'interactive')) return unreadable;
    if (running.length) return { state: 'busy' };
    const counts = [scheduled.runningScheduledTasksCount, scheduled.queuedScheduledTasksCount];
    if (!counts.every(Number.isFinite)) return unreadable;
    if (counts.some((count) => count > 0) || background.some(Boolean)) return { state: 'busy' };
    if (parts.readBackgroundJobs) {
      const jobs = await parts.readBackgroundJobs();
      if (jobs === null) return unreadable;
      if (jobs && jobs.length > 0) return { state: 'busy' };
    }
    return { state: 'idle' };
  } catch {
    return unreadable;
  }
};
