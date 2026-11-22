import React from 'react';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_HELPER_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { JevAccessNote, SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { openClassificationProviders } from '@/components/sections/classification/classifierSources';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore, type SessionWorkEntry } from '@/stores/useUIStore';

/**
 * How sessions enter In work besides Track. Without a classification provider
 * the Jev chip is disabled and Off shows as chosen, which is what the server
 * does then; the saved choice comes back once a provider is set up. With In
 * work off nothing enters, so Off shows then too.
 */
const SessionWorkEntryField: React.FC<{ disabled: boolean }> = ({ disabled }) => {
  const { t } = useI18n();
  const entry = useUIStore((state) => state.sessionWorkEntry);
  const setEntry = useUIStore((state) => state.setSessionWorkEntry);
  const jevAvailable = useRoutingStore(selectSafetyNetAvailable);
  // Enterprise mode leaves nothing to set up, so no link to a page offering only Off.
  const canSetUpJev = !useEnterpriseMode();
  const shown: SessionWorkEntry = disabled || (entry === 'jev' && !jevAvailable) ? 'off' : entry;

  return (
    <div className="space-y-1 ps-6">
      <SettingsFieldRow
        settingsItem="sessions.work-entry"
        label={t('settings.openchamber.sessionWork.entry.label')}
        info={t('settings.openchamber.sessionWork.entry.info')}
      >
        <SettingsChipGroup<SessionWorkEntry>
          aria-label={t('settings.openchamber.sessionWork.entry.label')}
          value={shown}
          onChange={setEntry}
          options={[
            { value: 'off', label: t('settings.openchamber.sessionWork.entry.off'), disabled },
            { value: 'every-message', label: t('settings.openchamber.sessionWork.entry.everyMessage'), disabled },
            { value: 'jev', label: t('settings.openchamber.sessionWork.entry.jev'), disabled: disabled || !jevAvailable },
          ]}
        />
      </SettingsFieldRow>
      {jevAvailable ? (shown === 'jev' ? <JevAccessNote /> : null) : (
        <p className={SETTINGS_HELPER_CLASS}>
          {t('settings.openchamber.sessionWork.entry.jevMissing')}
          {canSetUpJev ? (
            <>
              {' '}
              <SettingsInlineLink onClick={openClassificationProviders}>{t('settings.jevAccess.setUp')}</SettingsInlineLink>
            </>
          ) : null}
        </p>
      )}
    </div>
  );
};

/**
 * What the sidebar lists: the Chats section and "In work" (the sidebar block,
 * the Track / Done actions, and how sessions enter it on their own). Sessions
 * enter on their own through the OpenChamber server, which VS Code does not
 * have.
 */
export const SessionWorkSettings: React.FC = () => {
  const { t } = useI18n();
  const isVSCode = isVSCodeRuntime();
  const enabled = useUIStore((state) => state.sessionWorkEnabled);
  const setEnabled = useUIStore((state) => state.setSessionWorkEnabled);
  const showChatsSection = useSessionDisplayStore((state) => state.showChatsSection);
  const setShowChatsSection = useSessionDisplayStore((state) => state.setShowChatsSection);

  return (
    <SettingsSection
      title={t('settings.layout.sessions.sidebar.title')}
      settingsItem="sessions.work"
      contentClassName={SETTINGS_OPTION_STACK_CLASS}
    >
      {isVSCode ? null : (
        <SettingsCheckboxRow
          settingsItem="sessions.show-chats"
          checked={showChatsSection}
          onChange={(checked) => {
            setShowChatsSection(checked);
            void updateDesktopSettings({ sidebarShowChatsSection: checked });
          }}
          label={t('settings.openchamber.defaults.field.showChats')}
          ariaLabel={t('settings.openchamber.defaults.field.showChats')}
        />
      )}
      <SettingsCheckboxRow
        settingsItem="sessions.work-enabled"
        checked={enabled}
        onChange={setEnabled}
        label={t('settings.openchamber.sessionWork.field.enabled')}
        ariaLabel={t('settings.openchamber.sessionWork.field.enabled')}
        info={t('settings.openchamber.sessionWork.info')}
      />
      {isVSCode ? null : <SessionWorkEntryField disabled={!enabled} />}
    </SettingsSection>
  );
};
