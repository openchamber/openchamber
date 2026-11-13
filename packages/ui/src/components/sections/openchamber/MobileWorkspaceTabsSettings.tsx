import React from 'react';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsSortableVisibilityList } from '@/components/sections/shared/SettingsSortableVisibilityList';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { orderMobileWorkspaceTabs, shownMobileWorkspaceTabs, type MobileWorkspaceTab } from '@/lib/mobileWorkspaceTabs';
import { useUIStore } from '@/stores/useUIStore';

const TAB_LABEL_KEYS = {
  status: 'chat.workStatus.ariaLabel',
  changes: 'mobile.menu.git',
  files: 'mobile.menu.files',
  terminal: 'mobile.menu.terminal',
  notes: 'contextRail.surface.notes',
} satisfies Record<MobileWorkspaceTab, I18nKey>;

/**
 * Order and visibility of the phone's workspace panel tabs. Stored per
 * device: a phone and a laptop are set up apart. The last tab shown cannot be
 * hidden.
 */
export const MobileWorkspaceTabsSettings: React.FC = () => {
  const { t } = useI18n();
  const order = useUIStore((state) => state.mobileWorkspaceTabOrder);
  const hidden = useUIStore((state) => state.mobileWorkspaceHiddenTabs);
  const setOrder = useUIStore((state) => state.setMobileWorkspaceTabOrder);
  const setVisible = useUIStore((state) => state.setMobileWorkspaceTabVisible);

  const items = React.useMemo(() => {
    const shown = shownMobileWorkspaceTabs(order, hidden);
    return orderMobileWorkspaceTabs(order).map((id) => ({
      id,
      label: t(TAB_LABEL_KEYS[id]),
      visible: shown.includes(id),
      locked: shown.length === 1 && shown.includes(id),
    }));
  }, [hidden, order, t]);

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
          if (tab) setVisible(tab, visible);
        }}
        onReorder={setOrder}
        settingsItemPrefix="layout.mobile-workspace-tabs."
        dragInstructions={t('settings.layout.general.mobileTabs.dragInstructions')}
      />
    </SettingsSection>
  );
};
