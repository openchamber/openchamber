/**
 * The notification side of the turn-end verdict: pure mapping from the
 * battery's shared answer to the event worth announcing, plus the pause check.
 *
 * The question itself lives in session-work's battery (`questions.js`): one
 * Jev call per turn answers the composer hints and these notifications from
 * the same scores — one request, one truth. This module never asks anything;
 * it decides what the notification runtime announces:
 *
 * - `decideVerdictEvent` maps `turnEndScores` onto one event, in priority
 *   order (done outranks waiting which outranks a review offer), through the
 *   same measured thresholds the hints use. Exclusive by construction: one
 *   notification per turn, and the two silent states (a part-way stop, a
 *   plain answer) never fire.
 * - `readRunningTools` reads the pause flag: a turn that handed work to the
 *   session's own background tasks — a shell sent to the background, a tool
 *   call still running — is a pause, not a turn end. OpenCode wakes the
 *   session when the task lands, and that turn's end is the one to announce.
 *   A backgrounded call settles at once with a `{status: 'running', shellID}`
 *   marker in its metadata, and the shell reports its end in a later synthetic
 *   message with a `{source: 'shell', shellID}` metadata — the unmatched marker
 *   is the running shell (same shapes as the chat's `background-shell`).
 */
import { isString } from '../shared/guards.js';
import {
  NEEDS_YOU_THRESHOLD,
  REVIEW_READY_THRESHOLD,
  WRAP_UP_THRESHOLD,
} from '../session-work/questions.js';

/** Recent messages examined for a running tool part at each turn end. */
export const TURN_END_CONTEXT_MESSAGE_LIMIT = 20;

/**
 * The one event the scores announce, or null. `on` gates each event by its
 * own checkbox; the caller already knows which are enabled. A score that was
 * never asked (null) can never fire.
 */
export const decideVerdictEvent = (scores, on = {}) => {
  if (!scores) return null;
  if (on.workDone && scores.wrapUp !== null && scores.wrapUp >= WRAP_UP_THRESHOLD) return 'workDone';
  if (on.waitingOnYou && scores.needsYou !== null && scores.needsYou >= NEEDS_YOU_THRESHOLD) return 'waitingOnYou';
  if (on.reviewReady && scores.review !== null && scores.review >= REVIEW_READY_THRESHOLD) return 'reviewReady';
  return null;
};

const isRunningTool = (part) => part?.type === 'tool' && part?.state?.status === 'running';

/**
 * The shell a call sent to the background, from the marker a backgrounded
 * call settles with. A call that waited for its command carries no marker.
 */
const backgroundedShellID = (part) => {
  if (part?.type !== 'tool' || part?.state?.status !== 'completed') return null;
  const { status, shellID } = part.state.metadata ?? {};
  return status === 'running' && isString(shellID) && shellID ? shellID : null;
};

/**
 * Whether the session still has work of its own in flight: a tool call still
 * running, or a background shell whose completion has not landed yet. A page
 * that could not be read answers false: the pause check consults, it never
 * vetoes on "could not look".
 */
export const readRunningTools = (messages) => {
  if (!Array.isArray(messages)) return false;
  let running = false;
  const backgrounded = new Set();
  const ended = new Set();
  for (const message of messages) {
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (isRunningTool(part)) running = true;
        const shellID = backgroundedShellID(part);
        if (shellID) backgrounded.add(shellID);
      }
    }
    const { source, shellID } = message?.metadata ?? {};
    if (source === 'shell' && isString(shellID)) ended.add(shellID);
  }
  return running || [...backgrounded].some((shellID) => !ended.has(shellID));
};
