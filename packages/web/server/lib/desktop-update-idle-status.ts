import { decideDesktopUpdateIdle, type DesktopUpdateIdle, type DesktopUpdateTerminal } from './desktop-update-idle.js';
import type { SessionActivityProbe } from './opencode/session-activity.js';

type SessionStateReader = {
  getSessionStateSnapshot: () => Readonly<Record<string, { status: string }>>;
  getSessionActivitySnapshot: () => Readonly<Record<string, { type: string }>>;
  getPendingBlockingRequestsSnapshot: () => Readonly<Record<string, {
    permissions: readonly unknown[];
    forms: readonly unknown[];
    pages: readonly unknown[];
  }>>;
};

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
  return {
    disconnect: () => {
      generation += 1;
      reconciled = false;
    },
    connect: async () => {
      const current = ++generation;
      reconciled = false;
      const readAt = Date.now();
      const statuses = await readStatuses();
      if (current !== generation || !isConnected() || !statuses) return;
      adoptRunning(Object.keys(statuses), readAt);
      reconciled = true;
    },
    isReady: () => reconciled,
  };
};

export type DesktopUpdateIdleParts = {
  canReadSessions: () => boolean;
  sessionRuntime: SessionStateReader;
  terminalRuntime: { listTerminals: () => readonly DesktopUpdateTerminal[] } | null;
  scheduledTasksRuntime: {
    getStatus: () => { runningScheduledTasksCount: number; queuedScheduledTasksCount: number };
  };
  workflowRuntime: { hasLiveRun: () => boolean };
  sessionGoalRuntime: { hasLiveWork: () => boolean };
  sessionAssistRuntime: { hasLiveWork: () => boolean };
  messageQueueRuntime: LiveWork;
  extensionWaitsRuntime: LiveWork;
  prWatchRuntime: LiveWork;
  autoReviewRuntime: LiveWork;
};

export const collectDesktopUpdateIdle = async (parts: DesktopUpdateIdleParts): Promise<DesktopUpdateIdle> => {
  const unreadable: DesktopUpdateIdle = { state: 'unknown' };
  try {
    const { messageQueueRuntime, extensionWaitsRuntime, prWatchRuntime, autoReviewRuntime } = parts;
    await Promise.all([messageQueueRuntime, extensionWaitsRuntime, prWatchRuntime, autoReviewRuntime].map((owner) => owner.load()));
    if (!parts.canReadSessions()) return unreadable;
    const sessions: Record<string, { type: string }> = {};
    for (const [sessionId, state] of Object.entries(parts.sessionRuntime.getSessionStateSnapshot())) {
      sessions[sessionId] = {
        type: state.status === 'busy' || state.status === 'retry' ? 'running' : state.status === 'idle' ? 'idle' : 'unknown',
      };
    }
    for (const [sessionId, phase] of Object.entries(parts.sessionRuntime.getSessionActivitySnapshot())) {
      if (phase.type === 'busy') sessions[sessionId] = { type: 'running' };
    }
    for (const [sessionId, pending] of Object.entries(parts.sessionRuntime.getPendingBlockingRequestsSnapshot())) {
      if (pending.permissions.length > 0 || pending.forms.length > 0 || pending.pages.length > 0) {
        sessions[sessionId] = { type: 'running' };
      }
    }
    if (parts.sessionAssistRuntime.hasLiveWork()) return { state: 'busy' };
    const scheduled = parts.scheduledTasksRuntime.getStatus();
    return decideDesktopUpdateIdle({
      sessions,
      terminals: parts.terminalRuntime ? parts.terminalRuntime.listTerminals() : null,
      scheduledRunning: scheduled.runningScheduledTasksCount,
      scheduledQueued: scheduled.queuedScheduledTasksCount,
      workflowLive: parts.workflowRuntime.hasLiveRun(),
      goalLive: parts.sessionGoalRuntime.hasLiveWork(),
      queueLive: messageQueueRuntime.hasLiveWork(),
      waitLive: extensionWaitsRuntime.hasLiveWork() || prWatchRuntime.hasLiveWork(),
      reviewLive: autoReviewRuntime.hasLiveWork(),
    });
  } catch {
    return unreadable;
  }
};
