import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { PostRevertBranchOverlay, State } from './types';
import { getEffectiveVisibleMessages, getSessionRevertMessageID } from './message-visibility';

type UserMessageHistoryRecord = {
  message: Message;
  parts: Part[];
};

export type UserMessageHistorySnapshot = {
  sessionID: string;
  revertMessageID?: string;
  postRevertBranch?: PostRevertBranchOverlay;
  records: UserMessageHistoryRecord[];
  history: string[];
};

const EMPTY_PARTS: Part[] = [];
const EMPTY_RECORDS: UserMessageHistoryRecord[] = [];
const EMPTY_HISTORY: string[] = [];

export const EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT: UserMessageHistorySnapshot = {
  sessionID: '',
  revertMessageID: undefined,
  postRevertBranch: undefined,
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
  state: Pick<State, 'session' | 'message' | 'part' | 'postRevertBranch'>,
  sessionID: string,
  previous: UserMessageHistorySnapshot = EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT,
): UserMessageHistorySnapshot => {
  if (!sessionID) {
    return EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT;
  }

  const messages = state.message[sessionID] ?? [];
  const session = state.session.find((candidate) => candidate.id === sessionID);
  const revertMessageID = getSessionRevertMessageID(session);
  const postRevertBranch = state.postRevertBranch[sessionID];
  const visibleMessages = getEffectiveVisibleMessages(messages, session, postRevertBranch);
  const records: UserMessageHistoryRecord[] = [];
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const message = visibleMessages[index];
    if (message.role !== 'user') {
      continue;
    }
    records.push({
      message,
      parts: state.part[message.id] ?? EMPTY_PARTS,
    });
  }

  if (records.length === 0) {
    return previous.sessionID === sessionID
      && previous.revertMessageID === revertMessageID
      && previous.postRevertBranch === postRevertBranch
      && previous.records.length === 0
      ? previous
      : { sessionID, revertMessageID, postRevertBranch, records: EMPTY_RECORDS, history: EMPTY_HISTORY };
  }

  if (
    previous.sessionID === sessionID
    && previous.revertMessageID === revertMessageID
    && previous.postRevertBranch === postRevertBranch
    && areRecordsEqual(previous.records, records)
  ) {
    return previous;
  }

  const history: string[] = [];
  for (const record of records) {
    const text = getFirstTextFromParts(record.parts);
    if (text.length > 0) {
      history.push(text);
    }
  }

  return { sessionID, revertMessageID, postRevertBranch, records, history };
};
