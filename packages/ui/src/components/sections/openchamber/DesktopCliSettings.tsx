import * as React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { getDesktopCliStatus, registerDesktopCli, unregisterDesktopCli, type DesktopCliStatus } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';

type CommandView =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; status: DesktopCliStatus };

/** Manage the local command in General settings; the native main process checks ownership for registration and removal. */
export const DesktopCliSettings: React.FC = () => {
  const { t } = useI18n();
  const [view, setView] = React.useState<CommandView>({ phase: 'loading' });
  const [busy, setBusy] = React.useState<'register' | 'unregister' | null>(null);
  const [readEpoch, setReadEpoch] = React.useState(0);
  const mounted = React.useRef(false);

  React.useEffect(() => {
    mounted.current = true;
    let active = true;
    getDesktopCliStatus().then((status) => {
      if (active) setView({ phase: 'ready', status });
    }).catch(() => {
      if (active) setView({ phase: 'failed' });
    });
    return () => { active = false; mounted.current = false; };
  }, [readEpoch]);

  /** Use the native status after completion; preserve the current status on failure so the user can retry. */
  const changeRegistration = async (action: 'register' | 'unregister'): Promise<void> => {
    setBusy(action);
    reportSettingsSaveState('saving');
    try {
      const status = await (action === 'register' ? registerDesktopCli() : unregisterDesktopCli());
      if (mounted.current) setView({ phase: 'ready', status });
      reportSettingsSaveState('saved');
    } catch {
      reportSettingsSaveState('error');
      if (mounted.current) toast.error(t('settings.desktopCli.actionFailed'));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const status = view.phase === 'ready' ? view.status : null;
  const description = view.phase === 'loading' ? t('common.loading')
    : view.phase === 'failed' ? t('settings.desktopCli.loadFailed')
      : status?.state === 'installed' ? t('settings.desktopCli.installed')
        : status?.state === 'external' ? t('settings.desktopCli.external')
          : status?.state === 'unsupported' ? t('settings.desktopCli.unsupported')
            : t('settings.desktopCli.missing');
  const commandPath = status?.state === 'installed' || status?.state === 'external' ? status.path : null;

  return (
    <SettingsSection title={t('settings.desktopCli.title')} info={t('settings.desktopCli.info')} settingsItem="general.desktop-cli">
      <SettingsFieldRow label="chamber" controlClassName="flex-wrap @xl:flex-1" description={(
        <>
          {description}
          {commandPath ? <span dir="ltr" className="block break-all font-mono">{commandPath}</span> : null}
        </>
      )}>
        {view.phase === 'failed' ? (
          <Button type="button" variant="outline" onClick={() => { setView({ phase: 'loading' }); setReadEpoch((epoch) => epoch + 1); }}>
            {t('settings.desktopCli.retry')}
          </Button>
        ) : (
          <>
            <Button type="button" onClick={() => void changeRegistration('register')} disabled={busy !== null || status?.state !== 'missing'}>
              {busy === 'register' ? t('common.loading') : t('settings.desktopCli.register')}
            </Button>
            <Button type="button" variant="outline" onClick={() => void changeRegistration('unregister')} disabled={busy !== null || status?.state !== 'installed'}>
              {busy === 'unregister' ? t('common.loading') : t('settings.desktopCli.unregister')}
            </Button>
          </>
        )}
      </SettingsFieldRow>
      {status?.state === 'installed' ? (
        <p className={SETTINGS_HELPER_CLASS}>{t(status.requiresPath ? 'settings.desktopCli.pathRequired' : 'settings.desktopCli.reopen')}</p>
      ) : null}
    </SettingsSection>
  );
};
