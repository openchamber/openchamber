import { loadAssistContext } from '../session-assist/context.js';
import { HISTORY_LIMITS } from './defaults.js';
import type { OpenCode } from '@opencode/client';

export interface HistoryEntry { role: 'user' | 'assistant'; text: string }
export interface LastAnswer { providerID: string; modelID: string; completed: number }
export interface RoutingHistory { history: HistoryEntry[]; lastAnswer: LastAnswer | null }
interface HistoryTurn { user?: { text: string } | null; assistant?: { text: string } | null }
type Client = ReturnType<typeof OpenCode.make>;
export interface RoutingHistoryOptions {
  readPage: (options: { limit: number; cursor: string | undefined }) => ReturnType<Client['message']['list']>;
  signal: AbortSignal;
}

export const excerptHead = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit).trimEnd()} […]`);

export const excerptHeadTail = (text: string, head: number, tail: number) =>
  (text.length <= head + tail ? text : `${text.slice(0, head).trimEnd()} […] ${text.slice(-tail).trimStart()}`);

export const turnsToHistory = (turns: HistoryTurn[], limits = HISTORY_LIMITS) => {
  const history: HistoryEntry[] = [];
  for (const turn of turns.slice(-limits.turns)) {
    if (turn.user?.text) history.push({ role: 'user', text: excerptHead(turn.user.text, limits.user) });
    if (turn.assistant?.text) history.push({ role: 'assistant', text: excerptHeadTail(turn.assistant.text, limits.answerHead, limits.answerTail) });
  }
  return history;
};

const answeredBy = (message: { providerID?: string; modelID?: string; completed: number | null } | null) => (message?.providerID && message.modelID && message.completed
  ? { providerID: message.providerID, modelID: message.modelID, completed: message.completed }
  : null);

export const loadRoutingHistory = async ({ readPage, signal }: RoutingHistoryOptions): Promise<RoutingHistory> => {
  const context = await loadAssistContext({ readPage, signal });
  return context
    ? { history: turnsToHistory(context.turns), lastAnswer: answeredBy(context.last) }
    : { history: [], lastAnswer: null };
};
