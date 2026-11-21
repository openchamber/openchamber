export const DESKTOP_UPDATE_IDLE_REASONS = [
  'session',
  'command',
  'interactive-shell',
  'scheduled-task',
  'workflow',
  'goal',
  'message-queue',
  'wait',
  'review',
  'tunnel',
  'unreadable',
] as const;

export type DesktopUpdateIdleReason = typeof DESKTOP_UPDATE_IDLE_REASONS[number];

export type DesktopUpdateIdle =
  | { state: 'idle'; reason: null }
  | { state: 'busy' | 'unknown'; reason: DesktopUpdateIdleReason };

export interface DesktopUpdateTerminal {
  status: string;
  mode?: string | null;
}

export interface DesktopUpdateSession {
  type: string;
}

export interface DesktopUpdateIdleInput {
  sessions: Record<string, DesktopUpdateSession> | null;
  terminals: readonly DesktopUpdateTerminal[] | null;
  scheduledRunning: number;
  scheduledQueued: number;
  workflowLive: boolean;
  goalLive: boolean;
  queueLive: boolean;
  waitLive: boolean;
  reviewLive: boolean;
  tunnelActive: boolean;
}

const SESSION_BUSY = new Set(['running', 'retry', 'retrying']);

const unknown = (tunnelActive: boolean): DesktopUpdateIdle => ({
  state: 'unknown',
  reason: tunnelActive ? 'tunnel' : 'unreadable',
});

const busy = (reason: DesktopUpdateIdleReason): DesktopUpdateIdle => ({ state: 'busy', reason });

const countIsLive = (value: number) => Number.isFinite(value) && value > 0;

const sessionBlock = (sessions: Record<string, DesktopUpdateSession> | null, tunnelActive: boolean): DesktopUpdateIdle | null => {
  if (!sessions) return unknown(tunnelActive);
  for (const value of Object.values(sessions)) {
    if (!value.type) return unknown(tunnelActive);
    if (SESSION_BUSY.has(value.type)) return busy('session');
    if (value.type !== 'idle') return unknown(tunnelActive);
  }
  return null;
};

const terminalBlock = (terminals: readonly DesktopUpdateTerminal[] | null, tunnelActive: boolean): DesktopUpdateIdle | null => {
  if (!terminals) return unknown(tunnelActive);
  let command = false;
  for (const terminal of terminals) {
    if (terminal.status !== 'running') continue;
    if (terminal.mode === 'command') {
      command = true;
      continue;
    }
    if (terminal.mode === 'interactive' || terminal.mode == null || terminal.mode === '') return busy('interactive-shell');
    return unknown(tunnelActive);
  }
  return command ? busy('command') : null;
};

export const decideDesktopUpdateIdle = (input: DesktopUpdateIdleInput): DesktopUpdateIdle => {
  const session = sessionBlock(input.sessions, input.tunnelActive);
  if (session) return session;
  const terminal = terminalBlock(input.terminals, input.tunnelActive);
  if (terminal) return terminal;
  if (!Number.isFinite(input.scheduledRunning) || !Number.isFinite(input.scheduledQueued)) return unknown(input.tunnelActive);
  if (countIsLive(input.scheduledRunning) || countIsLive(input.scheduledQueued)) return busy('scheduled-task');
  if (input.workflowLive) return busy('workflow');
  if (input.goalLive) return busy('goal');
  if (input.queueLive) return busy('message-queue');
  if (input.waitLive) return busy('wait');
  if (input.reviewLive) return busy('review');
  return { state: 'idle', reason: null };
};
