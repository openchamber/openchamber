import React from 'react';

import { toast } from '@/components/ui';
import type { AgentMemoryScope } from '@/lib/agentMemoryApi';
import { resolveProjectContextId, type ProjectRef } from '@/lib/projectContextApi';

const UNDO_WINDOW_MS = 5000;

const pendingKeys = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

const publish = () => {
  snapshot = new Set(pendingKeys);
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const noteDeleteKey = (projectRef: ProjectRef, noteId: string) => (
  `note:${resolveProjectContextId(projectRef)}:${noteId}`
);

export const planDeleteKey = (projectRef: ProjectRef, planId: string) => (
  `plan:${resolveProjectContextId(projectRef)}:${planId}`
);

export const memoryDeleteKey = (scope: AgentMemoryScope, memoryId: string) => `memory:${scope}:${memoryId}`;

export const usePendingKnowledgeDeletes = (): ReadonlySet<string> => (
  React.useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
);

export const scheduleKnowledgeDelete = ({ key, message, undoLabel, run, onFailure, undoWindowMs = UNDO_WINDOW_MS }: {
  key: string;
  message: string;
  undoLabel: string;
  run: () => Promise<boolean>;
  onFailure: () => void;
  undoWindowMs?: number;
}): void => {
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);
  publish();

  let settled = false;
  let toastId: string | number | null = null;
  // external: https://github.com/emilkowalski/sonner/blob/main/src/index.tsx Toast hover pauses expiry, so the undo deadline uses its own timer.
  const timer = setTimeout(() => {
    settled = true;
    if (toastId !== null) toast.dismiss(toastId);
    void run().then((ok) => {
      pendingKeys.delete(key);
      publish();
      if (!ok) onFailure();
    });
  }, undoWindowMs);

  toastId = toast.message(message, {
    duration: undoWindowMs,
    action: {
      label: undoLabel,
      onClick: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingKeys.delete(key);
        publish();
      },
    },
  });
};
