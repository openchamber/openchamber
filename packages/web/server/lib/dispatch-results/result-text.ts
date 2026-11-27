import type { DispatchEntry, DispatchOutcome, FollowedTurn } from './runtime.js';

const ANSWER_CHAR_LIMIT = 50_000;
export const WAIT_LIMIT_MS = 30 * 60_000;
const SHOWN_WORK = 5;
const CUT_NOTE_ROOM = 200;
const MAX_CUT_BODIES = 50;

const HELD_FOR = `Held for ${WAIT_LIMIT_MS / 60_000} minutes`;
export const NOTHING_LEFT_NOTICE = 'Its background work ended without waking it, and nothing it runs is left to wake it.';
export const NEXT_TURN_NOTICE = `${HELD_FOR}; it is working on its next turn.`;

export const stillRunningNotice = (running: readonly string[]) => {
  const more = running.length > SHOWN_WORK ? [`- ${running.length - SHOWN_WORK} more`] : [];
  return [`${HELD_FOR} because its own work still runs:`, ...running.slice(0, SHOWN_WORK).map((item) => `- ${item}`), ...more].join('\n');
};

export const joinBodies = (bodies: readonly string[], sessionId: string) => {
  const joined = bodies.join('\n\n');
  if (joined.length <= ANSWER_CHAR_LIMIT) return joined;
  const kept = bodies.slice(-MAX_CUT_BODIES);
  const share = Math.floor(ANSWER_CHAR_LIMIT / (kept.length + 1)) - CUT_NOTE_ROOM;
  const cut = kept.map((body) => (body.length > share ? `${body.slice(0, share)}\n\n[Cut; read the rest with session.messages for ${sessionId}.]` : body));
  const omitted = bodies.length - kept.length;
  return (omitted > 0 ? [`[${omitted} earlier answers are left out; read them with session.messages for ${sessionId}.]`, ...cut] : cut).join('\n\n');
};

export const outcomeBody = ({ state, text, errorMessage }: DispatchOutcome, sessionId: string) => {
  const answer = text.length > ANSWER_CHAR_LIMIT
    ? `${text.slice(0, ANSWER_CHAR_LIMIT)}\n\n[Cut at ${ANSWER_CHAR_LIMIT} characters; read the rest with session.messages for ${sessionId}.]`
    : text;
  if (state === 'completed') return answer || 'The session finished without a text reply.';
  if (state === 'error') {
    const failure = errorMessage ? `The session failed: ${errorMessage}` : 'The session failed.';
    return answer ? `${failure}\n\nIts last reply:\n${answer}` : failure;
  }
  const stopped = 'The session was stopped before it finished.';
  return answer ? `${stopped}\n\nIts last reply:\n${answer}` : stopped;
};

export const DELETED_OUTCOME: DispatchOutcome = { state: 'cancelled', text: '', errorMessage: '' };
const HELD_OUTCOME: DispatchOutcome = { state: 'completed', text: '', errorMessage: '' };

export const combinedOutcome = (turns: readonly FollowedTurn[], entry: Pick<DispatchEntry, 'held' | 'sessionId'>, notice: string) => {
  const held = entry.held?.bodies ?? [];
  const last = turns.at(-1)?.outcome ?? (held.length > 0 || notice ? HELD_OUTCOME : DELETED_OUTCOME);
  const outcome = turns.some((turn) => turn.outcome.state === 'error') ? { ...last, state: 'error' as const } : last;
  if (turns.length === 0 && held.length === 0 && !notice) return { outcome, body: outcomeBody(outcome, entry.sessionId) };
  const bodies = [...held, ...turns.map((turn) => outcomeBody(turn.outcome, entry.sessionId)), ...(notice ? [notice] : [])];
  return { outcome, body: bodies.length === 1 ? bodies.join('') : joinBodies(bodies, entry.sessionId) };
};
