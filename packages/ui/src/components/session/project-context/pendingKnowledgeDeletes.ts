import React from 'react';

import { toast } from '@/components/ui';
import type { AgentMemoryScope } from '@/lib/agentMemoryApi';
import { resolveProjectContextId, type ProjectRef } from '@/lib/projectContextApi';

/** How long a deleted entry can still be brought back. */
const UNDO_WINDOW_MS = 5000;

/**
 * Deletes that wait out an undo window before they reach the server.
 *
 * The entry disappears from its list at once and the delete is only sent when
 * the toast's Undo was not pressed. Waiting beats re-creating on undo: a note
 * or plan created again would get a new id and lose its pins, its origin and
 * its place, and a deleted plan file has no other way back.
 *
 * Module state on purpose: the delete has to go through even when the panel
 * that started it unmounts mid-window. If the app closes inside the window the
 * delete is simply never sent, so the entry stays, which is the safe side.
 */
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

/** Memory ids are unique per store, and the global store is shared by every project. */
export const memoryDeleteKey = (scope: AgentMemoryScope, memoryId: string) => `memory:${scope}:${memoryId}`;

/** Keys of entries hidden while their delete waits for the undo window. */
export const usePendingKnowledgeDeletes = (): ReadonlySet<string> => (
  React.useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
);

export const scheduleKnowledgeDelete = ({ key, message, undoLabel, run, onFailure, undoWindowMs = UNDO_WINDOW_MS }: {
  /** From `noteDeleteKey`, `planDeleteKey` or `memoryDeleteKey`. */
  key: string;
  message: string;
  undoLabel: string;
  /** Sends the delete; resolves false when it failed. */
  run: () => Promise<boolean>;
  /** Called after a failed delete, once the entry is visible again. */
  onFailure: () => void;
  undoWindowMs?: number;
}): void => {
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);
  publish();

  let settled = false;
  let toastId: string | number | null = null;
  // The timer is the clock, not the toast: Sonner pauses a hovered toast, and
  // without a mounted Toaster it would never close at all. When the delete
  // goes out the toast goes with it, so Undo never outlives the window.
  const timer = setTimeout(() => {
    settled = true;
    if (toastId !== null) toast.dismiss(toastId);
    void run().then((ok) => {
      // Shown until the store has dropped the entry, so it does not flash back
      // between the timer and the refreshed list.
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
