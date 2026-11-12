import type { SettingsDocument } from './settings-helpers.js';

interface SidebarRowDisplaySettings {
  sidebarDetailedZoneRows?: boolean;
  sidebarWorktreeNameByBranch?: boolean;
  sidebarRowDisplayMode?: 'sessions' | 'worktrees' | 'branches';
}

export const sanitizeSidebarRowDisplaySettings = (candidate: SettingsDocument): SidebarRowDisplaySettings => {
  const result: SidebarRowDisplaySettings = {};
  if (candidate.sidebarDetailedZoneRows === true || candidate.sidebarDetailedZoneRows === false) {
    result.sidebarDetailedZoneRows = candidate.sidebarDetailedZoneRows;
  }
  if (candidate.sidebarWorktreeNameByBranch === true || candidate.sidebarWorktreeNameByBranch === false) {
    result.sidebarWorktreeNameByBranch = candidate.sidebarWorktreeNameByBranch;
  }
  const mode = candidate.sidebarRowDisplayMode;
  if (mode === 'sessions' || mode === 'worktrees' || mode === 'branches') {
    result.sidebarRowDisplayMode = mode;
  }
  return result;
};
