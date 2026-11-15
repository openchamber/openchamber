import React from 'react';

import type { Message, Part } from '@/lib/opencode/model';
import { readForegroundSubagentRun, readSubagentRun, type SubagentRun } from '@/lib/opencode/subagent-run';
import { useDirectoryStore, useDirectorySync } from '@/sync/sync-context';
import type { State } from '@/sync/types';

const runsByParts = new WeakMap<Part[], SubagentRun[]>();
const runByMessage = new WeakMap<Message, SubagentRun | null>();
const NO_REPORTS: Map<string, SubagentRun> = new Map();
const NO_MESSAGES: readonly Message[] = [];

const runsInParts = (parts: Part[]): SubagentRun[] => {
  const cached = runsByParts.get(parts);
  if (cached) return cached;
  const runs = parts.flatMap((part) => {
    if (part.type !== 'tool') return [];
    const run = readForegroundSubagentRun(part);
    return run ? [run] : [];
  });
  runsByParts.set(parts, runs);
  return runs;
};

const syntheticRun = (message: Message): SubagentRun | null => {
  const cached = runByMessage.get(message);
  if (cached !== undefined) return cached;
  const run = readSubagentRun(message) ?? null;
  runByMessage.set(message, run);
  return run;
};

export const collectSubagentReports = (messages: readonly Message[] | undefined, partsByMessage: State['part']): Map<string, SubagentRun> => {
  const byChild = new Map<string, SubagentRun>();
  for (const message of messages ?? []) {
    if (message.role === 'synthetic') {
      const run = syntheticRun(message);
      if (run) byChild.set(run.childSessionID, run);
    } else if (message.role === 'assistant') {
      const parts = partsByMessage[message.id];
      if (parts) for (const run of runsInParts(parts)) byChild.set(run.childSessionID, run);
    }
  }
  return byChild;
};

export const useSubagentReports = (sessionId: string | null, directory: string | null, enabled: boolean): Map<string, SubagentRun> => {
  const store = useDirectoryStore(directory ?? undefined);
  const messages = useDirectorySync(
    React.useCallback((state: State) => (enabled && sessionId ? state.message[sessionId] ?? NO_MESSAGES : NO_MESSAGES), [enabled, sessionId]),
    directory ?? undefined,
  );
  return React.useMemo(() => {
    if (messages.length === 0) return NO_REPORTS;
    return collectSubagentReports(messages, store.getState().part);
  }, [messages, store]);
};
