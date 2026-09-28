import React from 'react';
import { SettingsChipGroup, SettingsFieldRow, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { JevAccessNote, SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { openClassificationProviders } from '@/components/sections/classification/classifierSources';
import { useI18n } from '@/lib/i18n';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useUIStore, type SessionGoalChecker } from '@/stores/useUIStore';

const openSmallModelSettings = (): void => {
  useUIStore.getState().requestSettingsJump('sessions', 'sessions.small-model');
};

/**
 * Who checks goal progress after each turn: Jev or the small model. Without a
 * classification provider the Jev chip is disabled and the small model shows
 * as chosen, which is what the server does then; the saved choice comes back
 * once a provider is set up. The line below names what actually checks and
 * links to where that is configured: for Jev the shared note, which names the
 * classification provider in use.
 */
export const SessionGoalCheckerField: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const { t } = useI18n();
  const checker = useUIStore((state) => state.sessionGoalChecker);
  const setChecker = useUIStore((state) => state.setSessionGoalChecker);
  const jevAvailable = useRoutingStore(selectSafetyNetAvailable);
  const shown: SessionGoalChecker = jevAvailable ? checker : 'small-model';

  return (
    <div className="space-y-1">
      <SettingsFieldRow
        settingsItem="chat.session-goal-checker"
        label={t('settings.openchamber.visual.goal.checkerLabel')}
        info={t('settings.openchamber.visual.goal.checkerInfo')}
      >
        <SettingsChipGroup<SessionGoalChecker>
          aria-label={t('settings.openchamber.visual.goal.checkerLabel')}
          value={shown}
          onChange={setChecker}
          options={[
            { value: 'classifier', label: 'Jev', disabled: disabled || !jevAvailable },
            { value: 'small-model', label: t('settings.openchamber.visual.goal.checker.smallModel'), disabled },
          ]}
        />
      </SettingsFieldRow>
      {shown === 'classifier' ? <JevAccessNote /> : (
        <p className={SETTINGS_HELPER_CLASS}>
          {jevAvailable
            ? t('settings.openchamber.visual.goal.checker.viaSmallModel')
            : t('settings.openchamber.visual.goal.checker.jevMissing')}
          {' '}
          <SettingsInlineLink onClick={openSmallModelSettings}>{t('settings.openchamber.visual.goal.checker.smallModelLink')}</SettingsInlineLink>
          {jevAvailable ? null : (
            <>
              {' · '}
              <SettingsInlineLink onClick={openClassificationProviders}>{t('settings.jevAccess.setUp')}</SettingsInlineLink>
            </>
          )}
        </p>
      )}
    </div>
  );
};
