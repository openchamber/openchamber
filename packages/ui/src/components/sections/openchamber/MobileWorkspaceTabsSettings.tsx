import React from 'react';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsSortableVisibilityList } from '@/components/sections/shared/SettingsSortableVisibilityList';
import { useGuestPanelTabs } from '@/hooks/useGuestSurfaces';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  guestMobileWorkspaceTabId,
  isBuiltInMobileWorkspaceTab,
  isMobileWorkspaceTab,
  orderMobileWorkspaceTabs,
  shownMobileWorkspaceTabs,
  type BuiltInMobileWorkspaceTab,
} from '@/lib/mobileWorkspaceTabs';
import { useUIStore } from '@/stores/useUIStore';

const TAB_LABEL_KEYS = {
  status: 'chat.workStatus.ariaLabel',
  changes: 'mobile.menu.git',
  files: 'mobile.menu.files',
  terminal: 'mobile.menu.terminal',
  notes: 'contextRail.surface.notes',
} satisfies Record<BuiltInMobileWorkspaceTab, I18nKey>;

/**
 * Order and visibility of the phone's workspace panel tabs, including the tabs
 * installed extensions add. Stored per device: a phone and a laptop are set up
 * apart. The last tab shown cannot be hidden.
 */
export const MobileWorkspaceTabsSettings: React.FC = () => {
  const { t } = useI18n();
  const order = useUIStore((state) => state.mobileWorkspaceTabOrder);
  const hidden = useUIStore((state) => state.mobileWorkspaceHiddenTabs);
  const setOrder = useUIStore((state) => state.setMobileWorkspaceTabOrder);
  const setVisible = useUIStore((state) => state.setMobileWorkspaceTabVisible);
  const guestTabs = useGuestPanelTabs();
  const guestTabIds = React.useMemo(
    () => guestTabs.map((guest) => guestMobileWorkspaceTabId(guest.id)),
    [guestTabs],
  );
  const guestLabels = React.useMemo(
    () => new Map(guestTabs.map((guest) => [guestMobileWorkspaceTabId(guest.id), guest.name])),
    [guestTabs],
  );

  const items = React.useMemo(() => {
    const shown = shownMobileWorkspaceTabs(order, hidden, guestTabIds);
    return orderMobileWorkspaceTabs(order, guestTabIds).map((id) => ({
      id,
      label: isBuiltInMobileWorkspaceTab(id) ? t(TAB_LABEL_KEYS[id]) : guestLabels.get(id) ?? id,
      visible: shown.includes(id),
      locked: shown.length === 1 && shown.includes(id),
    }));
  }, [guestLabels, guestTabIds, hidden, order, t]);

  return (
    <SettingsSection
      title={t('settings.layout.general.mobileTabs.title')}
      info={t('settings.layout.general.mobileTabs.info')}
      settingsItem="layout.mobile-workspace-tabs"
    >
      <SettingsSortableVisibilityList
        items={items}
        onVisibleChange={(id, visible) => {
          if (isMobileWorkspaceTab(id)) setVisible(id, visible);
        }}
        onReorder={setOrder}
        settingsItemPrefix="layout.mobile-workspace-tabs."
        dragInstructions={t('settings.layout.general.mobileTabs.dragInstructions')}
      />
    </SettingsSection>
  );
};
