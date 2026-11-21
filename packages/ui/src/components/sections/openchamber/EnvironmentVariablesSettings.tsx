import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { EnvironmentVariablesEditor } from '@/components/sections/shared/EnvironmentVariablesEditor';
import { SavedSecretsList } from '@/components/sections/shared/SavedSecretsList';
import { fetchUserEnvironment, updateUserEnvironment, type EnvironmentUpdate } from '@/lib/environmentApi';
import { reportSettingsSaveState } from '@/lib/persistence';
import { restartOpenCodeWithFeedback } from '@/lib/restartOpenCode';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useI18n } from '@/lib/i18n';

type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; names: string[]; secrets: string[] }
  | { state: 'failed' };

export const EnvironmentVariablesSettings: React.FC = () => {
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseMode();
  const [load, setLoad] = React.useState<LoadState>({ state: 'loading' });
  const [changed, setChanged] = React.useState(false);
  const [restarting, setRestarting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    fetchUserEnvironment()
      .then((environment) => {
        if (!cancelled) setLoad({ state: 'ready', names: environment.names, secrets: environment.secrets });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = React.useCallback(async (update: Pick<EnvironmentUpdate, 'variables' | 'secrets'>): Promise<boolean> => {
    reportSettingsSaveState('saving');
    try {
      const environment = await updateUserEnvironment(update);
      setLoad({ state: 'ready', names: environment.names, secrets: environment.secrets });
      if (update.variables) setChanged(true);
      reportSettingsSaveState('saved');
      return true;
    } catch {
      reportSettingsSaveState('error');
      toast.error(t('settings.environment.editor.saveFailed'));
      return false;
    }
  }, [t]);

  const handleRestart = React.useCallback(async () => {
    setRestarting(true);
    try {
      await restartOpenCodeWithFeedback(t);
      setChanged(false);
    } finally {
      setRestarting(false);
    }
  }, [t]);

  return (
    <SettingsSection
      title={t('settings.environment.user.title')}
      info={t('settings.environment.user.info')}
      settingsItem="general.environment-variables"
    >
      <div className="space-y-3">
        {enterpriseMode ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.environment.user.enterpriseNote')}</p>
        ) : null}
        {load.state === 'failed' ? (
          <p className="typography-meta text-[var(--status-error)]">{t('settings.environment.editor.loadFailed')}</p>
        ) : (
          <>
            <EnvironmentVariablesEditor
              names={load.state === 'ready' ? load.names : []}
              disabled={load.state !== 'ready'}
              onSet={(name, value) => save({ variables: { [name]: value } })}
              onRemove={(name) => save({ variables: { [name]: null } })}
            />
            <SavedSecretsList
              names={load.state === 'ready' ? load.secrets : []}
              disabled={load.state !== 'ready'}
              onRemove={(name) => void save({ secrets: { [name]: null } })}
            />
          </>
        )}
        {changed && !enterpriseMode ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.environment.user.restartNote')}</p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleRestart()}
              disabled={restarting}
              className="shrink-0 !font-normal"
            >
              {restarting
                ? t('settings.openchamber.opencodeCli.actions.restartingOpenCode')
                : t('settings.openchamber.opencodeCli.actions.restart')}
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
};
