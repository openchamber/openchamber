import { create } from 'zustand';

export type ProjectSettingsTab = 'general' | 'actions' | 'worktrees' | 'environment';

/**
 * The tab the Settings project page shows. It lives outside the page so a
 * Settings search result can open the tab that holds its target before the
 * page highlights it, and so switching projects keeps the tab.
 */
export const useProjectSettingsTabStore = create<{
  tab: ProjectSettingsTab;
  setTab: (tab: ProjectSettingsTab) => void;
}>((set) => ({
  tab: 'general',
  setTab: (tab) => set({ tab }),
}));

/** Search targets inside a tab. The name and the icon sit in the page header, above every tab. */
const SEARCH_TARGET_TABS = new Map<string, ProjectSettingsTab>([
  ['projects.default-agent', 'general'],
  ['projects.default-model', 'general'],
  ['projects.default-thinking', 'general'],
  ['projects.shared', 'general'],
  ['projects.shared.plansDir', 'general'],
  ['projects.actions', 'actions'],
  ['projects.worktree', 'worktrees'],
  ['projects.worktree.setup.wait', 'worktrees'],
  ['projects.worktree.setup.replace', 'worktrees'],
  ['projects.environment', 'environment'],
]);

export const projectSettingsTabForSearchTarget = (id: string): ProjectSettingsTab | null => SEARCH_TARGET_TABS.get(id) ?? null;
