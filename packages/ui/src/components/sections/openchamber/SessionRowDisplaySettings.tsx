import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SessionTimelineRowBody } from '@/components/session/sidebar/sessions/SessionTimelineRowBody';
import {
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsChipGroup,
  SettingsSection,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  useSessionDisplayStore,
  type SessionRowDisplay,
  type SessionRowElements,
} from '@/stores/useSessionDisplayStore';

/**
 * Appearance → Sidebar rows: how many lines each row kind takes (Tree zones,
 * List, Chats, Tree projects), and which optional elements session rows
 * show. Live status and permission/question badges always show, so they are
 * not here.
 */
export const SessionRowDisplaySettings: React.FC = () => {
  const { t } = useI18n();
  const sessionRowDisplay = useSessionDisplayStore((state) => state.sessionRowDisplay);
  const setSessionRowDisplay = useSessionDisplayStore((state) => state.setSessionRowDisplay);
  const setSessionRowElement = useSessionDisplayStore((state) => state.setSessionRowElement);

  const writeDisplay = React.useCallback((next: SessionRowDisplay) => {
    void updateDesktopSettings({ sidebarSessionRowDisplay: next });
  }, []);

  const handleLines = React.useCallback((key: 'zoneLines' | 'listLines' | 'chatsLines' | 'projectLines', lines: SessionRowDisplay['zoneLines']) => {
    setSessionRowDisplay({ [key]: lines });
    writeDisplay({ ...useSessionDisplayStore.getState().sessionRowDisplay, [key]: lines });
  }, [setSessionRowDisplay, writeDisplay]);

  const linesRow = (
    key: 'zoneLines' | 'listLines' | 'chatsLines' | 'projectLines',
    labelKey: 'settings.openchamber.visual.field.zoneLines' | 'settings.openchamber.visual.field.listLines' | 'settings.openchamber.visual.field.chatsLines' | 'settings.openchamber.visual.field.projectLines',
    settingsItem: string,
  ) => (
    <SettingsFieldRow
      label={t(labelKey)}
      settingsItem={settingsItem}
    >
      <SettingsChipGroup
        value={sessionRowDisplay[key]}
        options={[
          { value: 'one', label: t('settings.openchamber.visual.option.zoneLinesOne') },
          { value: 'two', label: t('settings.openchamber.visual.option.zoneLinesTwo') },
        ]}
        onChange={(lines) => handleLines(key, lines)}
        aria-label={t(labelKey)}
      />
    </SettingsFieldRow>
  );

  const handleElement = React.useCallback(<K extends keyof SessionRowElements>(key: K, value: boolean) => {
    setSessionRowElement(key, value);
    writeDisplay({ ...useSessionDisplayStore.getState().sessionRowDisplay, [key]: value });
  }, [setSessionRowElement, writeDisplay]);

  const elementRow = (
    key: keyof SessionRowElements,
    labelKey: 'settings.openchamber.visual.field.rowBranch' | 'settings.openchamber.visual.field.rowPrBadge' | 'settings.openchamber.visual.field.rowProviderLogo' | 'settings.openchamber.visual.field.rowProjectIcon' | 'settings.openchamber.visual.field.rowGoal' | 'settings.openchamber.visual.field.rowTime' | 'settings.openchamber.visual.field.rowPinnedMarker' | 'settings.openchamber.visual.field.rowDoneHint' | 'settings.openchamber.visual.field.rowDirectoryIndicator',
    settingsItem: string,
  ) => (
    <SettingsCheckboxRow
      checked={sessionRowDisplay[key]}
      onChange={(checked) => handleElement(key, checked)}
      label={t(labelKey)}
      ariaLabel={t(labelKey)}
      settingsItem={settingsItem}
    />
  );

  return (
    <SettingsSection
      title={t('settings.openchamber.visual.section.sidebarRows')}
      info={t('settings.openchamber.visual.field.sidebarRowsInfo')}
      settingsItem="appearance.sidebar-rows"
      contentClassName={SETTINGS_OPTION_STACK_CLASS}
    >
      <SessionRowDisplayPreview display={sessionRowDisplay} />
      {linesRow('zoneLines', 'settings.openchamber.visual.field.zoneLines', 'appearance.sidebar-rows-lines')}
      {linesRow('listLines', 'settings.openchamber.visual.field.listLines', 'appearance.sidebar-rows-list-lines')}
      {linesRow('chatsLines', 'settings.openchamber.visual.field.chatsLines', 'appearance.sidebar-rows-chats-lines')}
      {linesRow('projectLines', 'settings.openchamber.visual.field.projectLines', 'appearance.sidebar-rows-project-lines')}
      <SettingsControlGroup title={t('settings.openchamber.visual.group.rowElements')}>
        {elementRow('showBranch', 'settings.openchamber.visual.field.rowBranch', 'appearance.sidebar-rows-branch')}
        {elementRow('showPrBadge', 'settings.openchamber.visual.field.rowPrBadge', 'appearance.sidebar-rows-pr-badge')}
        {elementRow('showProviderLogo', 'settings.openchamber.visual.field.rowProviderLogo', 'appearance.sidebar-rows-provider-logo')}
        {elementRow('showProjectIcon', 'settings.openchamber.visual.field.rowProjectIcon', 'appearance.sidebar-rows-project-icon')}
        {elementRow('showGoal', 'settings.openchamber.visual.field.rowGoal', 'appearance.sidebar-rows-goal')}
        {elementRow('showTime', 'settings.openchamber.visual.field.rowTime', 'appearance.sidebar-rows-time')}
        {elementRow('showPinnedMarker', 'settings.openchamber.visual.field.rowPinnedMarker', 'appearance.sidebar-rows-pin-marker')}
        {elementRow('showDoneHint', 'settings.openchamber.visual.field.rowDoneHint', 'appearance.sidebar-rows-done-hint')}
        {elementRow('showDirectoryIndicator', 'settings.openchamber.visual.field.rowDirectoryIndicator', 'appearance.sidebar-rows-directory')}
      </SettingsControlGroup>
    </SettingsSection>
  );
};

/**
 * One Tree zone row with sample content, drawn exactly like the sidebar
 * draws it. Flipping the controls above moves this row, so the choice is
 * visible before it reaches the sidebar.
 */
const SessionRowDisplayPreview: React.FC<{ display: SessionRowDisplay }> = ({ display }) => {
  const { t } = useI18n();
  const compact = display.zoneLines !== 'two';
  return (
    <div aria-hidden className="min-w-0">
      <SessionTimelineRowBody
        compact={compact}
        project={{ id: 'preview', icon: null, color: null, iconImage: null, iconBackground: null }}
        projectLabel="website"
        title="Design the empty states"
        titleClassName="text-foreground"
        branchLabel="feature/rows"
        statusDot={<Icon name="circle" className="h-3 w-3 flex-shrink-0 text-status-success" />}
        pinnedMarker={null}
        timeSlot="2m"
        directoryIndicator={null}
        prBadge={(
          <span className="inline-flex flex-shrink-0 items-center gap-1 typography-micro text-muted-foreground">
            <Icon name="git-pull-request" className="h-3 w-3" />
            <span className="leading-none tabular-nums">#128</span>
          </span>
        )}
        zombieIndicator={null}
        goal={(
          <span className="inline-flex flex-shrink-0 items-center">
            <Icon name="target" className="h-3 w-3 text-status-info" />
          </span>
        )}
        badges={(
          <span className="inline-flex flex-shrink-0 items-center rounded bg-destructive/10 px-1 py-0.5 text-destructive">
            <Icon name="shield" className="h-3 w-3" />
          </span>
        )}
        hideMetaOnHoverClass=""
        elements={display}
      />
      <p className="pt-1 typography-micro text-muted-foreground">{t('settings.openchamber.visual.field.sidebarRowsPreviewHint')}</p>
    </div>
  );
};
