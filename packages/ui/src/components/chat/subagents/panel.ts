import { useUIStore } from '@/stores/useUIStore';

export const openSubagentsPanel = (directory: string): void => {
  useUIStore.getState().openContextPanelTab(directory, { mode: 'subagents' });
};
