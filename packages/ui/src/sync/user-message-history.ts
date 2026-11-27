import type { Message, Part } from "@/lib/opencode/model"
import type { State } from './types';
import { messagesBefore } from './message-ordering';

type UserMessageHistoryRecord = {
  message: Message;
  parts: Part[];
};

export type TranscriptPrompt = {
  text: string;
  createdAt: number;
};

export type UserMessageHistorySnapshot = {
  sessionID: string;
  revertMessageID?: string;
  records: UserMessageHistoryRecord[];
  history: TranscriptPrompt[];
  commands: TranscriptPrompt[];
};

const EMPTY_PARTS: Part[] = [];
const EMPTY_RECORDS: UserMessageHistoryRecord[] = [];
const EMPTY_HISTORY: TranscriptPrompt[] = [];

export const EMPTY_USER_MESSAGE_HISTORY_SNAPSHOT: UserMessageHistorySnapshot = {
  sessionID: '',
  revertMessageID: undefined,
  records: EMPTY_RECORDS,
  history: EMPTY_HISTORY,
  commands: EMPTY_HISTORY,
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

const arePromptsEqual = (left: readonly TranscriptPrompt[], right: readonly TranscriptPrompt[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.text !== right[index]?.text || left[index]?.createdAt !== right[index]?.createdAt) {
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
  const revertMessageID = session?.revert?.messageID;
  const records: UserMessageHistoryRecord[] = [];
  const commands: TranscriptPrompt[] = [];
  for (const message of messagesBefore(messages, revertMessageID)) {
    if (message.role === 'shell') {
      if (message.command.length > 0) commands.push({ text: message.command, createdAt: message.time.created });
      continue;
    }
    if (message.role !== 'user') {
      continue;
    }
    records.push({
      message,
      parts: state.part[message.id] ?? EMPTY_PARTS,
    });
  }

  if (
    previous.sessionID === sessionID
    && previous.revertMessageID === revertMessageID
    && areRecordsEqual(previous.records, records)
    && arePromptsEqual(previous.commands, commands)
  ) {
    return previous;
  }

  const history: TranscriptPrompt[] = [];
  for (const record of records) {
    const text = getFirstTextFromParts(record.parts);
    if (text.length > 0) {
      history.push({ text, createdAt: record.message.time.created });
    }
  }

  return { sessionID, revertMessageID, records, history, commands };
};
