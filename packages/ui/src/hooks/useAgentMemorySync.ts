
import React from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectContextOwner } from '@/hooks/useProjectContextOwner';

const AGENT_MEMORY_FRESH_MS = 60_000;

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
    void load(projectPath, { maxAgeMs: AGENT_MEMORY_FRESH_MS });
  }, [enabled, load, projectPath]);

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
