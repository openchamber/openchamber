import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { State } from './types';

type UserMessageHistoryRecord = {
  message: Message;
  parts: Part[];
};

export type UserMessageHistorySnapshot = {
  sessionID: string;
  revertMessageID?: string;
  records: UserMessageHistoryRecord[];
  history: string[];
};

const EMPTY_PARTS: Part[] = [];
const EMPTY_RECORDS: UserMessageHistoryRecord[] = [];
const EMPTY_HISTORY: string[] = [];

export const EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT: UserMessageHistorySnapshot = {
  sessionID: '',
  revertMessageID: undefined,
  records: EMPTY_RECORDS,
  history: EMPTY_HISTORY,
};

const getPartText = (part: Part): string => {
  if (part?.type !== 'text') return '';
  const text = (part as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
};

const getFirstTextFromParts = (parts: Part[]): string => {
  for (const part of parts) {
    const text = getPartText(part);
    if (text.length > 0) return text;
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
  const revertMessageID = (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID;
  const records: UserMessageHistoryRecord[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') {
      continue;
    }
    if (revertMessageID && message.id >= revertMessageID) {
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

  const history: string[] = [];
  for (const record of records) {
    const text = getFirstTextFromParts(record.parts);
    if (text.length > 0) {
      history.push(text);
    }
  }

  return { sessionID, revertMessageID, records, history };
};
