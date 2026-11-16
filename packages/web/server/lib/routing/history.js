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

const answeredBy = (message) => (message?.providerID && message.modelID && message.completed
  ? { providerID: message.providerID, modelID: message.modelID, completed: message.completed }
  : null);

export const loadRoutingHistory = async ({ readPage, signal }) => {
  const context = await loadAssistContext({ readPage, signal });
  return context
    ? { history: turnsToHistory(context.turns), lastAnswer: answeredBy(context.last) }
    : { history: [], lastAnswer: null };
};
