import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { resolveSidebarRowDisplayMode, useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

export const MobileSidebarDisplayModes = () => {
  const { t } = useI18n();
  const selected = useSessionDisplayStore(resolveSidebarRowDisplayMode);
  const setRowDisplayMode = useSessionDisplayStore((state) => state.setRowDisplayMode);
  return <>
    <DropdownMenuSeparator />
    <DropdownMenuLabel>{t('sessions.sidebar.header.displayMode.displayAs')}</DropdownMenuLabel>
    {([
      ['sessions', 'sessions.sidebar.header.displayMode.sessions'],
      ['worktrees', 'sessions.sidebar.header.displayMode.worktrees'],
      ['branches', 'sessions.sidebar.header.displayMode.branches'],
    ] as const).map(([mode, labelKey]) => <DropdownMenuItem key={mode} className="min-h-10 items-center justify-between" onClick={() => {
      setRowDisplayMode(mode);
      void updateDesktopSettings({ sidebarRowDisplayMode: mode });
    }}>
      <span className="min-w-0 truncate" dir="auto">{t(labelKey)}</span>
      {selected === mode ? <Icon name="check" className="size-4 text-primary" /> : null}
    </DropdownMenuItem>)}
  </>;
};
