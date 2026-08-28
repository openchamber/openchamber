/**
 * Keeps agent memory loaded for whatever project the session belongs to.
 *
 * This does not belong to the Memory tab. The session index is built from the
 * loaded snapshot, so leaving the load to the panel meant a user who never
 * opened Project notes sent every message with no memory index at all — the
 * agent had memories it was never told about.
 *
 * The session directory is resolved to its project first. A session in a
 * worktree has the worktree's path, and loading by that path reads a store the
 * agent does not write to, which is the same mismatch in the other direction.
 */

import React from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectContextOwner } from '@/hooks/useProjectContextOwner';

/**
 * The directory is a parameter rather than read from `useEffectiveDirectory`,
 * because this runs above `SyncProvider` — that hook reads the sync context and
 * throws outside it, which took the whole app down with a blank window.
 */
export const useAgentMemorySync = (directory: string | null): void => {
  const enabled = useUIStore((state) => (
    state.agentMemoryFeatureAvailable && state.agentMemoryToolEnabled
  ));
  const load = useAgentMemoryStore((state) => state.load);
  const owner = useProjectContextOwner(directory);
  const projectPath = owner?.path ?? null;

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    void load(projectPath);
  }, [enabled, load, projectPath]);

  // The agent writes memory mid-turn through its own tool, so the index for the
  // next message has to come from a fresh read rather than the snapshot taken
  // before the turn started.
  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    return subscribeOpenchamberEvents((event) => {
      if (event.type === 'agent-memory-changed') {
        void load(projectPath);
      }
    });
  }, [enabled, load, projectPath]);
};
