import React from 'react';
import { create } from 'zustand';

import { useUIStore } from '@/stores/useUIStore';
import { selectWorkflowsShown } from '@/lib/workflows/availability';
import { fetchSavedWorkflows, type SavedWorkflow } from './api';

interface SavedWorkflowsState {
  byDirectory: Record<string, SavedWorkflow[]>;
  load: (directory: string) => Promise<void>;
}

const NONE: SavedWorkflow[] = [];

export const useSavedWorkflowsStore = create<SavedWorkflowsState>((set) => ({
  byDirectory: {},
  load: async (directory) => {
    const workflows = await fetchSavedWorkflows(directory).catch(() => null);
    if (workflows) set((state) => ({ byDirectory: { ...state.byDirectory, [directory]: workflows } }));
  },
}));

export const useSavedWorkflows = (directory: string | null): SavedWorkflow[] => {
  const available = useUIStore(selectWorkflowsShown);
  const saved = useSavedWorkflowsStore((state) => (directory ? state.byDirectory[directory] : undefined) ?? NONE);
  const load = useSavedWorkflowsStore((state) => state.load);
  React.useEffect(() => {
    if (available && directory) void load(directory);
  }, [available, directory, load]);
  return available ? saved : NONE;
};
