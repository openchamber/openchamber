import React from 'react';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsSortableVisibilityList } from '@/components/sections/shared/SettingsSortableVisibilityList';
import { usePhoneGuestPanelModes } from '@/hooks/useGuestSurfaces';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { orderMobileWorkspaceTabs, shownMobileWorkspaceTabs, type BuiltInMobileWorkspaceTab } from '@/lib/mobileWorkspaceTabs';
import { isPluginContextPanelMode, pluginIdFromMode } from '@/lib/surfaces/modes';
import { useUIStore } from '@/stores/useUIStore';

const TAB_LABEL_KEYS = {
  status: 'chat.workStatus.ariaLabel',
  changes: 'mobile.menu.git',
  files: 'mobile.menu.files',
  terminal: 'mobile.menu.terminal',
  notes: 'contextRail.surface.notes',
  preview: 'contextPanel.browser.empty',
} satisfies Record<BuiltInMobileWorkspaceTab, I18nKey>;

/**
 * Order and visibility of the phone's workspace panel tabs, the extension
 * tabs of the server in use included. Stored per device: a phone and a
 * laptop are set up apart. The last tab shown cannot be hidden.
 */
export const MobileWorkspaceTabsSettings: React.FC = () => {
  const { t } = useI18n();
  const order = useUIStore((state) => state.mobileWorkspaceTabOrder);
  const hidden = useUIStore((state) => state.mobileWorkspaceHiddenTabs);
  const setOrder = useUIStore((state) => state.setMobileWorkspaceTabOrder);
  const setVisible = useUIStore((state) => state.setMobileWorkspaceTabVisible);
  const extensions = usePhoneGuestPanelModes();
  const guests = useGuestsStore((state) => state.guests);

  const items = React.useMemo(() => {
    const shown = shownMobileWorkspaceTabs(order, hidden, extensions);
    return orderMobileWorkspaceTabs(order, extensions).map((id) => ({
      id,
      label: isPluginContextPanelMode(id)
        ? guests.find((guest) => guest.id === pluginIdFromMode(id))?.name ?? pluginIdFromMode(id)
        : t(TAB_LABEL_KEYS[id]),
      visible: shown.includes(id),
      locked: shown.length === 1 && shown.includes(id),
    }));
  }, [extensions, guests, hidden, order, t]);

  return (
    <SettingsSection
      title={t('settings.layout.general.mobileTabs.title')}
      info={t('settings.layout.general.mobileTabs.info')}
      settingsItem="layout.mobile-workspace-tabs"
    >
      <SettingsSortableVisibilityList
        items={items}
        onVisibleChange={(id, visible) => {
          const tab = items.find((item) => item.id === id)?.id;
          if (tab) setVisible(tab, visible, extensions);
        }}
        onReorder={setOrder}
        settingsItemPrefix="layout.mobile-workspace-tabs."
        dragInstructions={t('settings.layout.general.mobileTabs.dragInstructions')}
      />
    </SettingsSection>
  );
};
