import React from 'react';
import {
  SettingsChipGroup,
  SettingsFieldRow,
  SETTINGS_HELPER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { JevAccessNote, SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { openClassificationProviders } from '@/components/sections/classification/classifierSources';
import { useI18n } from '@/lib/i18n';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { DEFAULT_SESSION_GOAL_MAX_AUTO_TURNS, SESSION_GOAL_MAX_AUTO_TURNS_LIMIT } from '@/lib/sessionGoalTurnLimit';
import { useUIStore, type SessionGoalChecker } from '@/stores/useUIStore';

const openSmallModelSettings = (): void => {
  useUIStore.getState().requestSettingsJump('sessions', 'sessions.small-model');
};

export const SessionGoalCheckerField: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const { t } = useI18n();
  const checker = useUIStore((state) => state.sessionGoalChecker);
  const setChecker = useUIStore((state) => state.setSessionGoalChecker);
  const jevAvailable = useRoutingStore(selectSafetyNetAvailable);
  const canSetUpJev = !useEnterpriseMode();
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
          {jevAvailable || !canSetUpJev ? null : (
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

export const SessionGoalMaxTurnsField: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const { t } = useI18n();
  const maxTurns = useUIStore((state) => state.sessionGoalMaxAutoTurns);
  const setMaxTurns = useUIStore((state) => state.setSessionGoalMaxAutoTurns);

  return (
    <SettingsFieldRow
      settingsItem="chat.session-goal-max-turns"
      label={t('settings.openchamber.visual.goal.maxTurnsLabel')}
      info={t('settings.openchamber.visual.goal.maxTurnsInfo')}
    >
      <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
        <NumberInput
          value={maxTurns}
          onValueChange={(value) => setMaxTurns(Math.floor(value))}
          min={1}
          max={SESSION_GOAL_MAX_AUTO_TURNS_LIMIT}
          step={1}
          disabled={disabled}
          className={SETTINGS_NUMBER_INPUT_CLASS}
          aria-label={t('settings.openchamber.visual.goal.maxTurnsLabel')}
        />
        <Button size="sm"
          type="button"
          variant="ghost"
          onClick={() => setMaxTurns(DEFAULT_SESSION_GOAL_MAX_AUTO_TURNS)}
          disabled={disabled || maxTurns === DEFAULT_SESSION_GOAL_MAX_AUTO_TURNS}
          className={SETTINGS_ICON_BUTTON_CLASS}
          aria-label={t('settings.openchamber.visual.goal.maxTurnsResetAria')}
          title={t('settings.common.actions.reset')}
        >
          <Icon name="restart" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </SettingsFieldRow>
  );
};

