import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { getDesktopLanAddress, isDesktopLocalOriginActive, isDesktopShell, restartDesktopApp } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

export const DesktopNetworkSettings: React.FC = () => {
  const { t } = useI18n();
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const [savedValue, setSavedValue] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
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
        const response = await fetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(t('settings.openchamber.desktopNetwork.error.loadFailed'));
        }

        const data = (await response.json().catch(() => null)) as null | { desktopLanAccessEnabled?: unknown };
        if (cancelled) {
          return;
        }

        const enabled = data?.desktopLanAccessEnabled === true;
        setSavedValue(enabled);
        setDraftValue(enabled);
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

  const isDirty = draftValue !== savedValue;
  const currentPort = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const parsed = Number(window.location.port);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, []);
  const lanUrl = draftValue && lanAddress && currentPort ? `http://${lanAddress}:${currentPort}` : null;

  const handleToggle = React.useCallback(() => {
    setDraftValue((current) => !current);
  }, []);

  const handleSaveAndRestart = React.useCallback(async () => {
    if (!isDirty) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch('/api/config/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ desktopLanAccessEnabled: draftValue }),
      });

      if (!response.ok) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.saveFailed'));
      }

      setSavedValue(draftValue);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.savedRestartFailed'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.saveFailed'));
      setIsSaving(false);
    }
  }, [draftValue, isDirty, t]);

  if (!isLocalDesktop) {
    return null;
  }

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.desktopNetwork.title')}</h3>
      </div>

      <section className="space-y-2 px-2 pb-2 pt-0">
        <div
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
            disabled={isLoading || isSaving || !isDirty}
            className="shrink-0 !font-normal"
          >
            {isSaving ? t('settings.common.actions.saving') : t('settings.openchamber.desktopNetwork.actions.saveAndRestart')}
          </Button>
        </div>
      </section>
    </div>
  );
};
