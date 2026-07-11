import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  getDesktopLanAddress,
  getDesktopKeepAwake,
  getDesktopLaunchAtLogin,
  getDesktopMinimizeToTray,
  isDesktopLocalOriginActive,
  isDesktopShell,
  restartDesktopApp,
  setDesktopKeepAwake,
  setDesktopLaunchAtLogin,
  setDesktopMinimizeToTray,
} from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

export const DesktopNetworkSettings: React.FC = () => {
  const { t } = useI18n();
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const [savedValue, setSavedValue] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState(false);
  const [savedPassword, setSavedPassword] = React.useState('');
  const [draftPassword, setDraftPassword] = React.useState('');
  const [lanAccessActive, setLanAccessActive] = React.useState(false);
  const [lanAccessBlockedReason, setLanAccessBlockedReason] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [launchAtLoginSupported, setLaunchAtLoginSupported] = React.useState(false);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = React.useState(false);
  const [isSavingLaunchAtLogin, setIsSavingLaunchAtLogin] = React.useState(false);
  const [minimizeToTraySupported, setMinimizeToTraySupported] = React.useState(false);
  const [minimizeToTrayEnabled, setMinimizeToTrayEnabled] = React.useState(false);
  const [isSavingMinimizeToTray, setIsSavingMinimizeToTray] = React.useState(false);
  const [keepAwakeSupported, setKeepAwakeSupported] = React.useState(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = React.useState(false);
  const [isSavingKeepAwake, setIsSavingKeepAwake] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lanAddress, setLanAddress] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(t('settings.openchamber.desktopNetwork.error.loadFailed'));
        }

        const data = (await response.json().catch(() => null)) as null | {
          desktopLanAccessEnabled?: unknown;
          desktopUiPassword?: unknown;
          desktopLanAccessActive?: unknown;
          desktopLanAccessBlockedReason?: unknown;
        };
        if (cancelled) {
          return;
        }

        const enabled = data?.desktopLanAccessEnabled === true;
        const password = typeof data?.desktopUiPassword === 'string' ? data.desktopUiPassword : '';
        setSavedValue(enabled);
        setDraftValue(enabled);
        setSavedPassword(password);
        setDraftPassword(password);
        setLanAccessActive(data?.desktopLanAccessActive === true);
        setLanAccessBlockedReason(
          typeof data?.desktopLanAccessBlockedReason === 'string' ? data.desktopLanAccessBlockedReason : null
        );
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.loadFailed'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop, t]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setLaunchAtLoginSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopLaunchAtLogin();
      if (cancelled) {
        return;
      }
      setLaunchAtLoginSupported(status?.supported === true);
      setLaunchAtLoginEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setMinimizeToTraySupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopMinimizeToTray();
      if (cancelled) {
        return;
      }
      setMinimizeToTraySupported(status?.supported === true);
      setMinimizeToTrayEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setKeepAwakeSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const status = await getDesktopKeepAwake();
      if (cancelled) {
        return;
      }
      setKeepAwakeSupported(status?.supported === true);
      setKeepAwakeEnabled(status?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop || !draftValue) {
      setLanAddress(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const address = await getDesktopLanAddress();
      if (!cancelled) {
        setLanAddress(address);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftValue, isLocalDesktop]);

  const isDirty = draftValue !== savedValue || draftPassword !== savedPassword;
  const currentPort = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    const portSource = runtimeApiBaseUrl || window.location.href;
    let parsed = 0;
    try {
      parsed = Number(new URL(portSource).port);
    } catch {
      parsed = Number(window.location.port);
    }
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, []);
  const lanUrl = draftValue && lanAccessActive && lanAddress && currentPort ? `http://${lanAddress}:${currentPort}` : null;
  const lanRequiresPassword = draftValue && !draftPassword.trim();
  const lanBlockedByMissingPassword = savedValue && !lanAccessActive && lanAccessBlockedReason === 'missing-password';
  const saveDisabled = isLoading || isSaving || !isDirty || lanRequiresPassword;

  const handleToggle = React.useCallback(() => {
    setDraftValue((current) => !current);
  }, []);

  const handlePasswordChange = React.useCallback((value: string) => {
    setDraftPassword(value);
    if (!value.trim()) {
      setDraftValue(false);
    }
  }, []);

  const handleLaunchAtLoginToggle = React.useCallback(async () => {
    if (!launchAtLoginSupported || isSavingLaunchAtLogin) {
      return;
    }

    const nextValue = !launchAtLoginEnabled;
    setLaunchAtLoginEnabled(nextValue);
    setIsSavingLaunchAtLogin(true);
    setError(null);

    try {
      const status = await setDesktopLaunchAtLogin(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.launchAtLoginUnsupported'));
      }
      setLaunchAtLoginEnabled(status.enabled);
    } catch (cause) {
      setLaunchAtLoginEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.launchAtLoginSaveFailed'));
    } finally {
      setIsSavingLaunchAtLogin(false);
    }
  }, [isSavingLaunchAtLogin, launchAtLoginEnabled, launchAtLoginSupported, t]);

  const handleMinimizeToTrayToggle = React.useCallback(async () => {
    if (!minimizeToTraySupported || isSavingMinimizeToTray) {
      return;
    }

    const nextValue = !minimizeToTrayEnabled;
    setMinimizeToTrayEnabled(nextValue);
    setIsSavingMinimizeToTray(true);
    setError(null);

    try {
      const status = await setDesktopMinimizeToTray(nextValue);
      if (!status) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.minimizeToTraySaveFailed'));
      }
      if (!status.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.minimizeToTrayUnsupported'));
      }
      setMinimizeToTrayEnabled(status.enabled);
    } catch (cause) {
      setMinimizeToTrayEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.minimizeToTraySaveFailed'));
    } finally {
      setIsSavingMinimizeToTray(false);
    }
  }, [isSavingMinimizeToTray, minimizeToTrayEnabled, minimizeToTraySupported, t]);

  const handleKeepAwakeToggle = React.useCallback(async () => {
    if (!keepAwakeSupported || isSavingKeepAwake) {
      return;
    }

    const nextValue = !keepAwakeEnabled;
    setKeepAwakeEnabled(nextValue);
    setIsSavingKeepAwake(true);
    setError(null);

    try {
      const status = await setDesktopKeepAwake(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.keepAwakeUnsupported'));
      }
      setKeepAwakeEnabled(status.enabled);
    } catch (cause) {
      setKeepAwakeEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.keepAwakeSaveFailed'));
    } finally {
      setIsSavingKeepAwake(false);
    }
  }, [isSavingKeepAwake, keepAwakeEnabled, keepAwakeSupported, t]);

  const handleSaveAndRestart = React.useCallback(async () => {
    if (!isDirty) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await runtimeFetch('/api/config/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          desktopLanAccessEnabled: draftValue,
          desktopUiPassword: draftPassword,
        }),
      });

      if (!response.ok) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.saveFailed'));
      }

      setSavedValue(draftValue);
      setSavedPassword(draftPassword);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.savedRestartFailed'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.saveFailed'));
      setIsSaving(false);
    }
  }, [draftPassword, draftValue, isDirty, t]);

  if (!isLocalDesktop) {
    return null;
  }

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.desktopNetwork.title')}</h3>
      </div>

      <section className="space-y-2 px-2 pb-2 pt-0">
        {launchAtLoginSupported ? (
          <div
            data-settings-item="sessions.desktop-launch-at-login"
            className="group flex cursor-pointer items-start gap-2 py-1.5"
            role="button"
            tabIndex={0}
            onClick={handleLaunchAtLoginToggle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleLaunchAtLoginToggle();
              }
            }}
          >
            <Checkbox
              checked={launchAtLoginEnabled}
              onChange={handleLaunchAtLoginToggle}
              ariaLabel={t('settings.openchamber.desktopNetwork.field.launchAtLoginAria')}
              disabled={isSavingLaunchAtLogin}
            />
            <div className="min-w-0 flex-1">
              <div className="typography-ui-label text-foreground">{t('settings.openchamber.desktopNetwork.field.launchAtLogin')}</div>
              <div className="typography-micro text-muted-foreground/70">
                {t('settings.openchamber.desktopNetwork.field.launchAtLoginDescription')}
              </div>
            </div>
          </div>
        ) : null}

        {minimizeToTraySupported ? (
          <div
            data-settings-item="sessions.desktop-minimize-to-tray"
            className="group flex cursor-pointer items-start gap-2 py-1.5"
            role="button"
            tabIndex={0}
            onClick={handleMinimizeToTrayToggle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleMinimizeToTrayToggle();
              }
            }}
          >
            <Checkbox
              checked={minimizeToTrayEnabled}
              onChange={handleMinimizeToTrayToggle}
              ariaLabel={t('settings.openchamber.desktopNetwork.field.minimizeToTrayAria')}
              disabled={isSavingMinimizeToTray}
            />
            <div className="min-w-0 flex-1">
              <div className="typography-ui-label text-foreground">{t('settings.openchamber.desktopNetwork.field.minimizeToTray')}</div>
              <div className="typography-micro text-muted-foreground/70">
                {t('settings.openchamber.desktopNetwork.field.minimizeToTrayDescription')}
              </div>
            </div>
          </div>
        ) : null}

        {keepAwakeSupported ? (
          <div
            data-settings-item="sessions.desktop-keep-awake"
            className="group flex cursor-pointer items-start gap-2 py-1.5"
            role="button"
            tabIndex={0}
            onClick={handleKeepAwakeToggle}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleKeepAwakeToggle();
              }
            }}
          >
            <Checkbox
              checked={keepAwakeEnabled}
              onChange={handleKeepAwakeToggle}
              ariaLabel={t('settings.openchamber.desktopNetwork.field.keepAwakeAria')}
              disabled={isSavingKeepAwake}
            />
            <div className="min-w-0 flex-1">
              <div className="typography-ui-label text-foreground">{t('settings.openchamber.desktopNetwork.field.keepAwake')}</div>
              <div className="typography-micro text-muted-foreground/70">
                {t('settings.openchamber.desktopNetwork.field.keepAwakeDescription')}
              </div>
            </div>
          </div>
        ) : null}

        <div data-settings-item="sessions.desktop-ui-password" className="space-y-1 py-1.5">
          <label className="typography-ui-label text-foreground" htmlFor="desktop-ui-password">
            {t('settings.openchamber.desktopPassword.field.password')}
          </label>
          <Input
            id="desktop-ui-password"
            type="password"
            className="h-7 max-w-sm"
            value={draftPassword}
            onChange={(event) => handlePasswordChange(event.target.value)}
            placeholder={t('settings.openchamber.desktopPassword.field.passwordPlaceholder')}
            disabled={isLoading || isSaving}
            required={draftValue}
            aria-invalid={lanRequiresPassword}
          />
          <div className="typography-micro text-muted-foreground/70">
            {t('settings.openchamber.desktopPassword.field.passwordDescription')}
          </div>
        </div>

        <div
          data-settings-item="sessions.desktop-lan-access"
          className="group flex cursor-pointer items-start gap-2 py-1.5"
          role="button"
          tabIndex={0}
          onClick={handleToggle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleToggle();
            }
          }}
        >
          <Checkbox
            checked={draftValue}
            onChange={handleToggle}
            ariaLabel={t('settings.openchamber.desktopNetwork.field.allowLanAccessAria')}
            disabled={isLoading || isSaving}
          />
          <div className="min-w-0 flex-1">
            <div className="typography-ui-label text-foreground">{t('settings.openchamber.desktopNetwork.field.allowLanAccess')}</div>
            <div className="typography-micro text-muted-foreground/70">
              {t('settings.openchamber.desktopNetwork.field.allowLanAccessDescription')}
            </div>
            <div className="typography-micro text-[var(--status-warning)]/85">
              {t('settings.openchamber.desktopNetwork.field.warning')}
            </div>
            {lanRequiresPassword || lanBlockedByMissingPassword ? (
              <div className="typography-micro text-[var(--status-warning)]/85">
                {t('settings.openchamber.desktopNetwork.field.passwordRequiredWarning')}
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="px-2 typography-micro text-[var(--status-error)]">{error}</div>
        ) : null}

        {lanUrl ? (
          <div className="px-2 typography-micro text-muted-foreground/80">
            {isDirty && !savedValue
              ? t('settings.openchamber.desktopNetwork.hint.openAfterRestart')
              : t('settings.openchamber.desktopNetwork.hint.openNow')}
            <span className="font-mono text-foreground">{lanUrl}</span>
          </div>
        ) : null}

        <div className="flex justify-start py-1.5">
          <Button
            type="button"
            size="xs"
            onClick={handleSaveAndRestart}
            disabled={saveDisabled}
            className="shrink-0 !font-normal"
          >
            {isSaving ? t('settings.common.actions.saving') : t('settings.openchamber.desktopNetwork.actions.saveAndRestart')}
          </Button>
        </div>
      </section>
    </div>
  );
};
