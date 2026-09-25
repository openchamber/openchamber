import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from "@/components/icon/Icon";
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsInset,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { isDesktopShell, requestFileAccess } from '@/lib/desktop';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { restartOpenCodeWithFeedback } from '@/lib/restartOpenCode';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';

export const OpenCodeCliSettings: React.FC = () => {
  const { t } = useI18n();
  const [value, setValue] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const showOpenCodeUpdateNotifications = useUIStore((state) => state.showOpenCodeUpdateNotifications);
  const setShowOpenCodeUpdateNotifications = useUIStore((state) => state.setShowOpenCodeUpdateNotifications);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadDesktopSettings();
        if (cancelled || !data) {
          return;
        }
        setValue(data.opencodeBinary ?? '');
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBrowse = React.useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!isDesktopShell()) {
      return;
    }

    try {
      const selected = await requestFileAccess();
      if (selected.success && selected.path && selected.path.trim().length > 0) {
        setValue(selected.path.trim());
      }
    } catch {
      // ignore
    }
  }, []);

  // The only setting left that OpenCode cannot pick up by itself: which binary
  // runs. Everything else is watched by OpenCode and applies live, so this page
  // owns the restart instead of a global pending-changes counter.
  const handleSaveAndReload = React.useCallback(async () => {
    setIsSaving(true);
    try {
      // Strip a wrapping quote pair (Windows "Copy as path" pastes) — literal
      // quotes are never part of a real path.
      const trimmed = value.trim();
      const unquoted = trimmed.length >= 2
        && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
          || (trimmed.startsWith("'") && trimmed.endsWith("'")))
        ? trimmed.slice(1, -1).trim()
        : trimmed;
      await updateDesktopSettings({ opencodeBinary: unquoted });
      await reloadOpenCodeConfiguration({
        message: t('settings.openchamber.opencodeCli.actions.restartingOpenCode'),
        mode: 'projects',
        scopes: ['all'],
      });
    } catch (error) {
      // SAFETY: reloadOpenCodeConfiguration is the only thrower here, and it
      // tags the Error it raises with `requiresManualRestart` for exactly this
      // case — an external OpenCode that OpenChamber may not restart.
      if ((error as Error & { requiresManualRestart?: boolean })?.requiresManualRestart) {
        toast.warning(t('settings.openchamber.opencodeCli.restart.manualRequired'));
        return;
      }
      toast.error(t('settings.openchamber.opencodeCli.restart.failed'));
    } finally {
      setIsSaving(false);
    }
  }, [t, value]);

  const handleRestart = React.useCallback(async () => {
    setIsSaving(true);
    try {
      await restartOpenCodeWithFeedback(t);
    } finally {
      setIsSaving(false);
    }
  }, [t]);

  const handleShowUpdateNotificationsChange = React.useCallback((enabled: boolean) => {
    setShowOpenCodeUpdateNotifications(enabled);
    void updateDesktopSettings({ showOpenCodeUpdateNotifications: enabled });
  }, [setShowOpenCodeUpdateNotifications]);

  return (
    <SettingsSection title={t('settings.openchamber.opencodeCli.title')}>
      <div className="space-y-0.5">
        <SettingsFieldRow
          settingsItem="sessions.opencode-binary"
          label={t('settings.openchamber.opencodeCli.field.binaryPath')}
          info={(
            <>
              {t('settings.openchamber.opencodeCli.tipPrefix')}
              {' '}
              <span className="font-mono">OPENCODE_BINARY</span>
              {' '}
              {t('settings.openchamber.opencodeCli.tipMiddle')}
              {' '}
              <span className="font-mono">~/.config/openchamber/settings.json</span>
              {'.'}
            </>
          )}
          alignEnd={false}
          controlClassName="@xl:w-[20rem]"
        >
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('settings.openchamber.opencodeCli.field.binaryPathPlaceholder')}
            disabled={isLoading || isSaving}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleBrowse}
            disabled={isLoading || isSaving || !isDesktopShell()}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={t('settings.openchamber.opencodeCli.actions.browseAria')}
            title={t('settings.openchamber.opencodeCli.actions.browse')}
          >
            <Icon name="folder" className="h-4 w-4" />
          </Button>
        </SettingsFieldRow>

        <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="sessions.opencode-update-notifications"
            checked={showOpenCodeUpdateNotifications}
            onChange={handleShowUpdateNotificationsChange}
            label={t('settings.openchamber.opencodeCli.field.showUpdateNotifications')}
            ariaLabel={t('settings.openchamber.opencodeCli.field.showUpdateNotificationsAria')}
          />

          <div className="flex flex-wrap justify-start gap-2 py-1.5" data-settings-item="sessions.opencode-restart">
            <Button
              type="button"
              size="xs"
              onClick={handleSaveAndReload}
              disabled={isLoading || isSaving}
              className="shrink-0 !font-normal"
            >
              {isSaving
                ? t('settings.openchamber.opencodeCli.actions.restartingOpenCode')
                : t('settings.openchamber.opencodeCli.actions.saveAndReload')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={handleRestart}
              disabled={isLoading || isSaving}
              className="shrink-0 !font-normal"
            >
              {t('settings.openchamber.opencodeCli.actions.restart')}
            </Button>
          </div>
        </SettingsInset>
      </div>
    </SettingsSection>
  );
};
