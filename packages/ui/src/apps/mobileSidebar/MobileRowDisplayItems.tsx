import React from 'react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { setPinnedInWork } from '@/lib/pinnedInWork';
import { updateDesktopSettings } from '@/lib/persistence';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';

const MENU_ITEM_CLASS = 'min-h-10 items-center justify-between';

export const MobileRowDisplayItems: React.FC = () => {
  const { t } = useI18n();
  const detailedZoneRows = useSessionDisplayStore((state) => state.detailedZoneRows);
  const setDetailedZoneRows = useSessionDisplayStore((state) => state.setDetailedZoneRows);
  const worktreeNameByBranch = useSessionDisplayStore((state) => state.worktreeNameByBranch);
  const setWorktreeNameByBranch = useSessionDisplayStore((state) => state.setWorktreeNameByBranch);
  const showSubagentSessions = useSessionDisplayStore((state) => state.showSubagentSessions);
  const setShowSubagentSessions = useSessionDisplayStore((state) => state.setShowSubagentSessions);
  const pinnedInWork = useSessionDisplayStore((state) => state.pinnedInWork);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);

  const item = (key: string, labelKey: I18nKey, checked: boolean, toggle: () => void): React.ReactNode => (
    <DropdownMenuItem key={key} onClick={toggle} className={MENU_ITEM_CLASS}>
      <span>{t(labelKey)}</span>
      {checked ? <Icon name="check" className="size-4 text-primary" /> : null}
    </DropdownMenuItem>
  );

  return (
    <>
      {sessionWorkEnabled ? item('pinned-in-work', 'sessions.sidebar.header.displayMode.pinnedInWork', pinnedInWork, () => { void setPinnedInWork(!pinnedInWork); }) : null}
      {item('detailed', 'sessions.sidebar.header.displayMode.detailedZoneRows', detailedZoneRows, () => {
        setDetailedZoneRows(!detailedZoneRows);
        void updateDesktopSettings({ sidebarDetailedZoneRows: !detailedZoneRows });
      })}
      {item('branch-names', 'sessions.sidebar.header.displayMode.worktreeNameByBranch', worktreeNameByBranch, () => {
        setWorktreeNameByBranch(!worktreeNameByBranch);
        void updateDesktopSettings({ sidebarWorktreeNameByBranch: !worktreeNameByBranch });
      })}
      {item('subagents', 'sessions.sidebar.header.displayMode.showSubagents', showSubagentSessions, () => {
        setShowSubagentSessions(!showSubagentSessions);
        void updateDesktopSettings({ sidebarShowSubagentSessions: !showSubagentSessions });
      })}
    </>
  );
};
