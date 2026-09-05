import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { State } from './types';
import { messagesBefore } from './message-ordering';

type UserMessageHistoryRecord = {
  message: Message;
  parts: Part[];
};

/** One prompt the user sent in a session, as the visible transcript shows it. */
export type TranscriptPrompt = {
  text: string;
  /** `message.time.created`, milliseconds. */
  createdAt: number;
};

export type UserMessageHistorySnapshot = {
  sessionID: string;
  revertMessageID?: string;
  records: UserMessageHistoryRecord[];
  /** Oldest first. */
  history: TranscriptPrompt[];
};

const EMPTY_PARTS: Part[] = [];
const EMPTY_RECORDS: UserMessageHistoryRecord[] = [];
const EMPTY_HISTORY: TranscriptPrompt[] = [];

export const EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT: UserMessageHistorySnapshot = {
  sessionID: '',
  revertMessageID: undefined,
  records: EMPTY_RECORDS,
  history: EMPTY_HISTORY,
};

const getFirstTextFromParts = (parts: Part[]): string => {
  for (const part of parts) {
    if (part.type === 'text' && part.text.length > 0) return part.text;
  }
  return '';
};

const areRecordsEqual = (left: UserMessageHistoryRecord[], right: UserMessageHistoryRecord[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.message !== right[index]?.message || left[index]?.parts !== right[index]?.parts) {
      return false;
    }
  }
  return true;
};

/**
 * The user's prompts in a session, oldest first, limited to what the visible
 * transcript shows: messages at or after a revert marker are excluded. Returns
 * the previous snapshot when nothing relevant changed so subscribers can skip
 * work on assistant-only updates.
 */
export const buildUserMessageHistorySnapshot = (
  state: Pick<State, 'session' | 'message' | 'part'>,
  sessionID: string,
  previous: UserMessageHistorySnapshot = EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT,
): UserMessageHistorySnapshot => {
  if (!sessionID) {
    return EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT;
  }

  const messages = state.message[sessionID] ?? [];
  const session = state.session.find((candidate) => candidate.id === sessionID);
  const revertMessageID = session?.revert?.messageID;
  const records: UserMessageHistoryRecord[] = [];
  for (const message of messagesBefore(messages, revertMessageID)) {
    if (message.role !== 'user') {
      continue;
    }
    records.push({
      message,
      parts: state.part[message.id] ?? EMPTY_PARTS,
    });
  }

  if (records.length === 0) {
    return previous.sessionID === sessionID && previous.revertMessageID === revertMessageID && previous.records.length === 0
      ? previous
      : { sessionID, revertMessageID, records: EMPTY_RECORDS, history: EMPTY_HISTORY };
  }

  if (previous.sessionID === sessionID && previous.revertMessageID === revertMessageID && areRecordsEqual(previous.records, records)) {
    return previous;
  }

  const history: TranscriptPrompt[] = [];
  for (const record of records) {
    const text = getFirstTextFromParts(record.parts);
    if (text.length > 0) {
      history.push({ text, createdAt: record.message.time.created });
    }
  }

  return { sessionID, revertMessageID, records, history };
};
