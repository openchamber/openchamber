import React from 'react';
import type { IconName } from '@/components/icon/icons';
import { useGuestPages } from '@/hooks/useGuestSurfaces';
import { useI18n } from '@/lib/i18n';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import type { ShortcutActionId } from '@/lib/shortcuts';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useUIStore } from '@/stores/useUIStore';

type BuiltinPageId = 'overview' | 'source-board' | 'scheduled' | 'archive' | 'stats' | 'integrations';

function builtinPageIcon(id: BuiltinPageId): IconName {
  switch (id) {
    case 'overview': return 'compass-3';
    case 'source-board': return 'git-pull-request';
    case 'scheduled': return 'calendar-schedule';
    case 'archive': return 'archive';
    case 'stats': return 'bar-chart';
    case 'integrations': return 'store-2';
  }
}

/**
 * One of the app's pages the sidebar's Pages section lists. `toggle` opens it,
 * or closes it while it is `open`. `shortcut`: the action that opens it from
 * the keyboard, shown in the row's tooltip when it has a key. `iconSrc`: an
 * extension's own icon file, drawn instead of `icon`.
 */
export type SidebarPage = {
  id: string;
  label: string;
  icon: IconName;
  iconSrc: string | null;
  open: boolean;
  toggle: () => void;
  shortcut: ShortcutActionId | null;
};

/**
 * The pages the sidebar opens in the main area, in their order: the built-in
 * ones available here, then each extension page. Only for the surfaces that
 * list them (`enabled`: the desktop layout outside VS Code); elsewhere empty.
 */
export const useSidebarPages = (enabled: boolean): readonly SidebarPage[] => {
  const { t } = useI18n();
  const overviewAvailable = useUIStore((state) => state.overviewFeatureAvailable);
  const isOverviewOpen = useUIStore((state) => state.isOverviewOpen);
  const isSourceBoardOpen = useUIStore((state) => state.isSourceBoardOpen);
  const isScheduledOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveOpen = useUIStore((state) => state.isArchivePageOpen);
  const isUsageOpen = useUIStore((state) => state.isUsageStatsPageOpen);
  const isIntegrationsCatalogOpen = useUIStore((state) => state.isIntegrationsCatalogOpen);
  const openGuestPageId = useUIStore((state) => state.openGuestPageId);
  const enterpriseMode = useEnterpriseMode();
  const guestPages = useGuestPages();

  return React.useMemo((): readonly SidebarPage[] => {
    if (!enabled) return [];
    const ui = useUIStore.getState;
    const builtin = (id: BuiltinPageId, label: string, open: boolean, set: (open: boolean) => void, shortcut: ShortcutActionId | null = null): SidebarPage => (
      { id, label, icon: builtinPageIcon(id), iconSrc: null, open, toggle: () => set(!open), shortcut }
    );
    const pages: SidebarPage[] = [];
    if (overviewAvailable) {
      pages.push(builtin('overview', t('overview.title'), isOverviewOpen, (open) => ui().setOverviewOpen(open), 'open_overview'));
    }
    pages.push(
      builtin('source-board', t('sourceBoard.title'), isSourceBoardOpen, (open) => ui().setSourceBoardOpen(open), 'toggle_source_board'),
      builtin('scheduled', t('sessions.sidebar.header.actions.scheduledTasks'), isScheduledOpen, (open) => ui().setScheduledTasksDialogOpen(open)),
      builtin('archive', t('sessions.sidebar.nav.archive'), isArchiveOpen, (open) => ui().setArchivePageOpen(open), 'open_archive'),
      builtin('stats', t('usageStats.openAction'), isUsageOpen, (open) => ui().setUsageStatsPageOpen(open)),
    );
    // The bundled catalog offers outside services; enterprise mode waits for
    // administrator-curated sources instead.
    if (!enterpriseMode) {
      pages.push(builtin('integrations', t('integrationsCatalog.sidebar.open'), isIntegrationsCatalogOpen, (open) => ui().setIntegrationsCatalogOpen(open)));
    }
    for (const guest of guestPages) {
      const open = openGuestPageId === guest.id;
      pages.push({
        id: `guest:${guest.id}`,
        label: guest.pageTitle ?? guest.name,
        icon: resolveGuestIconName(guest.icon),
        iconSrc: guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset) ?? null,
        open,
        toggle: () => ui().setOpenGuestPage(open ? null : guest.id),
        shortcut: null,
      });
    }
    return pages;
  }, [enabled, enterpriseMode, guestPages, isArchiveOpen, isIntegrationsCatalogOpen, isOverviewOpen, isScheduledOpen, isSourceBoardOpen, isUsageOpen, openGuestPageId, overviewAvailable, t]);
};
