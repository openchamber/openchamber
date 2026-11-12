/**
 * The conversation Jev sees next to the new request: the last settled turns,
 * read the same way session assist reads them (text parts only, attached
 * quotes included, tool payloads and files never), then cut down per message.
 * A user message keeps its head, where the task usually sits; an answer keeps
 * head and tail, where the finding and the outcome sit. The new request itself
 * is never cut.
 */
import { loadAssistContext } from '../session-assist/context.js';
import { HISTORY_LIMITS } from './defaults.js';

export const excerptHead = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit).trimEnd()} […]`);

export const excerptHeadTail = (text, head, tail) =>
  (text.length <= head + tail ? text : `${text.slice(0, head).trimEnd()} […] ${text.slice(-tail).trimStart()}`);

export const turnsToHistory = (turns, limits = HISTORY_LIMITS) => {
  const history = [];
  for (const turn of turns.slice(-limits.turns)) {
    if (turn.user?.text) history.push({ role: 'user', text: excerptHead(turn.user.text, limits.user) });
    if (turn.assistant?.text) history.push({ role: 'assistant', text: excerptHeadTail(turn.assistant.text, limits.answerHead, limits.answerTail) });
  }
  return history;
};

/** The model that wrote a settled answer and when it finished, or null when the record lacks either. */
const answeredBy = (message) => (message?.providerID && message.modelID && message.completed
  ? { providerID: message.providerID, modelID: message.modelID, completed: message.completed }
  : null);

/**
 * `history` is empty and `lastAnswer` null when the session has no settled
 * answer yet (a new session, or one interrupted mid-turn): routing then judges
 * the request on its own and has no cache to preserve. A read failure is
 * thrown so the caller can decide; it is not an empty history.
 */
export const loadRoutingHistory = async ({ readPage, signal }) => {
  const context = await loadAssistContext({ readPage, signal });
  return context
    ? { history: turnsToHistory(context.turns), lastAnswer: answeredBy(context.last) }
    : { history: [], lastAnswer: null };
};
