export type DesktopUpdateIdle = { state: 'idle' | 'busy' | 'unknown' };

export type DesktopUpdateTerminal = { status: string; mode?: string | null };

export type DesktopUpdateIdleInput = {
  sessions: Record<string, { type: string }> | null;
  terminals: readonly DesktopUpdateTerminal[] | null;
  scheduledRunning: number;
  scheduledQueued: number;
  workflowLive: boolean;
  goalLive: boolean;
  queueLive: boolean;
  waitLive: boolean;
  reviewLive: boolean;
};

const IDLE: DesktopUpdateIdle = { state: 'idle' };
const BUSY: DesktopUpdateIdle = { state: 'busy' };
const UNKNOWN: DesktopUpdateIdle = { state: 'unknown' };
const RUNNING = new Set(['running', 'retry', 'retrying']);

export const decideDesktopUpdateIdle = (input: DesktopUpdateIdleInput): DesktopUpdateIdle => {
  if (!input.sessions || !input.terminals) return UNKNOWN;
  const sessions = Object.values(input.sessions);
  if (sessions.some((session) => !session?.type || (!RUNNING.has(session.type) && session.type !== 'idle'))) return UNKNOWN;
  if (sessions.some((session) => RUNNING.has(session.type))) return BUSY;

  const terminals = input.terminals.filter((terminal) => terminal.status === 'running');
  if (terminals.some((terminal) => terminal.mode != null && terminal.mode !== '' && terminal.mode !== 'interactive' && terminal.mode !== 'command')) return UNKNOWN;
  if (terminals.length > 0) return BUSY;

  if (![input.scheduledRunning, input.scheduledQueued].every(Number.isFinite)) return UNKNOWN;
  if (input.scheduledRunning > 0 || input.scheduledQueued > 0 ||
    input.workflowLive || input.goalLive || input.queueLive || input.waitLive || input.reviewLive) return BUSY;
  return IDLE;
};
