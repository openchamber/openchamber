import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsCardChip, SettingsCardPill } from '@/components/sections/shared/SettingsCards';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import type { ProjectSetupSource } from '@/lib/openchamberConfig';
import { useI18n } from '@/lib/i18n';
import type { ProjectSetupState } from './useProjectSetup';

/** Where an action or a command lives: in the repo for the whole team, or only in the user's own settings. */
export const ProjectScopeChip: React.FC<{ source: ProjectSetupSource }> = ({ source }) => {
  const { t } = useI18n();
  return source === 'shared'
    ? <SettingsCardPill tone="info">{t('settings.projects.scope.team')}</SettingsCardPill>
    : <SettingsCardChip>{t('settings.projects.scope.personal')}</SettingsCardChip>;
};

/** Stands in for a tab's content while the setup loads, or when it could not be read. */
export const ProjectSetupUnavailable: React.FC<{ setupState: ProjectSetupState }> = ({ setupState }) => {
  const { t } = useI18n();
  if (setupState.load.state === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="typography-meta text-[var(--status-error)]">{t('settings.projects.setup.loadFailed')}</p>
        <Button type="button" size="xs" variant="outline" onClick={() => void setupState.reload()}>
          {t('settings.projects.setup.retry')}
        </Button>
      </div>
    );
  }
  return <p className={SETTINGS_HELPER_CLASS}>{t('settings.projects.actions.state.loading')}</p>;
};
