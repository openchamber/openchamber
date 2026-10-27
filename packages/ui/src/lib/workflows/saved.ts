import React from 'react';
import { create } from 'zustand';

import { useUIStore } from '@/stores/useUIStore';
import { fetchSavedWorkflows, type SavedWorkflow } from './api';

/**
 * The workflows saved in each project (`.openchamber/workflows/`), read when
 * a surface first shows the project. An agent saving one adds a file the panel
 * does not hear about; it shows the next time the panel opens.
 */
interface SavedWorkflowsState {
  byDirectory: Record<string, SavedWorkflow[]>;
  load: (directory: string) => Promise<void>;
}

const NONE: SavedWorkflow[] = [];

export const useSavedWorkflowsStore = create<SavedWorkflowsState>((set) => ({
  byDirectory: {},
  load: async (directory) => {
    // A failed read leaves what was there: no list is better than a wrong empty one.
    const workflows = await fetchSavedWorkflows(directory).catch(() => null);
    if (workflows) set((state) => ({ byDirectory: { ...state.byDirectory, [directory]: workflows } }));
  },
}));

/** A project's saved workflows, read again each time a surface that shows them mounts. */
export const useSavedWorkflows = (directory: string | null): SavedWorkflow[] => {
  const available = useUIStore((state) => state.agentWorkflowFeatureAvailable);
  const saved = useSavedWorkflowsStore((state) => (directory ? state.byDirectory[directory] : undefined) ?? NONE);
  const load = useSavedWorkflowsStore((state) => state.load);
  React.useEffect(() => {
    if (available && directory) void load(directory);
  }, [available, directory, load]);
  return available ? saved : NONE;
};
