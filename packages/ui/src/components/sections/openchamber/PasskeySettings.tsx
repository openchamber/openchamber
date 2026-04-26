import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  cancelPasskeyCeremony,
  defaultPasskeyStatus,
  fetchPasskeyStatus,
  fetchStoredPasskeys,
  getPasskeySupportState,
  isPasskeyCeremonyAbort,
  registerCurrentDevicePasskey,
  resetAllAuth,
  revokeStoredPasskey,
  type PasskeyStatus,
  type StoredPasskey,
} from '@/lib/passkeys';
import { useI18n } from '@/lib/i18n';

const formatTimestamp = (timestamp: number | null, neverUsedText: string) => {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return neverUsedText;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
};

export const PasskeySettings: React.FC = () => {
  const { t } = useI18n();
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isRegistering, setIsRegistering] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [isResetting, setIsResetting] = React.useState(false);
  const [passkeys, setPasskeys] = React.useState<StoredPasskey[]>([]);
  const [status, setStatus] = React.useState<PasskeyStatus>(defaultPasskeyStatus);
  const [errorMessage, setErrorMessage] = React.useState('');
  const supportState = React.useMemo(() => getPasskeySupportState(), []);

  const loadPasskeys = React.useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      const nextPasskeys = await fetchStoredPasskeys();
      setPasskeys(nextPasskeys);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.openchamber.passkeys.toast.loadFailed');
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!supportState.supported) {
          if (!cancelled) {
            setSupportsPasskeys(false);
            setIsLoading(false);
          }
          return;
        }
        if (!cancelled) {
          setSupportsPasskeys(true);
        }
      } catch {
        if (!cancelled) {
          setSupportsPasskeys(false);
        }
      }

      if (!cancelled) {
        const nextStatus = await fetchPasskeyStatus();
        setStatus(nextStatus);
        if (!nextStatus.enabled) {
          setPasskeys([]);
          setIsLoading(false);
          return;
        }
        await loadPasskeys();
      }
    })();

    return () => {
      cancelled = true;
      cancelPasskeyCeremony();
    };
  }, [loadPasskeys, supportState.supported]);

  const handleRegisterPasskey = React.useCallback(async () => {
    if (!status.enabled) {
      const message = t('settings.openchamber.passkeys.toast.enableUiPasswordFirst');
      setErrorMessage(message);
      toast.message(message);
      return;
    }

    if (!supportsPasskeys) {
      setErrorMessage(supportState.reason);
      toast.message(supportState.reason);
      return;
    }

    if (isRegistering) {
      cancelPasskeyCeremony();
      setIsRegistering(false);
      return;
    }

    setErrorMessage('');
    setIsRegistering(true);

    try {
      await registerCurrentDevicePasskey();
      setStatus(await fetchPasskeyStatus());
      await loadPasskeys();
      toast.success(t('settings.openchamber.passkeys.toast.added'));
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        toast.message(t('settings.openchamber.passkeys.toast.setupCanceled'));
        return;
      }

      const message = error instanceof Error ? error.message : t('settings.openchamber.passkeys.toast.addFailed');
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setIsRegistering(false);
    }
  }, [isRegistering, loadPasskeys, status.enabled, supportState.reason, supportsPasskeys, t]);

  const handleRevokePasskey = React.useCallback(async (id: string) => {
    setRevokingId(id);
    setErrorMessage('');

    try {
      await revokeStoredPasskey(id);
      setStatus(await fetchPasskeyStatus());
      await loadPasskeys();
      toast.success(t('settings.openchamber.passkeys.toast.removed'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.openchamber.passkeys.toast.removeFailed');
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setRevokingId(null);
    }
  }, [loadPasskeys, t]);

  const handleResetAllAuth = React.useCallback(async () => {
    setIsResetting(true);
    setErrorMessage('');

    try {
      await resetAllAuth();
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.openchamber.passkeys.toast.clearAuthFailed');
      setErrorMessage(message);
      toast.error(message);
      setIsResetting(false);
    }
  }, [t]);

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.passkeys.title')}</h3>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-2">
        <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.passkeys.field.currentDevice')}</span>
          </div>
          <div className="flex items-center gap-2 sm:w-fit">
            <Button
              type="button"
              variant={isRegistering ? 'secondary' : 'outline'}
              size="xs"
              onClick={() => void handleRegisterPasskey()}
              disabled={isLoading || isResetting}
              className="!font-normal"
            >
              {isRegistering ? t('settings.openchamber.passkeys.actions.cancelSetup') : t('settings.openchamber.passkeys.actions.add')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void handleResetAllAuth()}
              disabled={isLoading || isRegistering || isResetting}
              className="!font-normal text-muted-foreground hover:text-foreground"
            >
              {isResetting ? t('settings.openchamber.passkeys.actions.signingOut') : t('settings.openchamber.passkeys.actions.signOutEverywhere')}
            </Button>
          </div>
        </div>

        {!status.enabled && (
          <p className="typography-meta text-muted-foreground">
            {t('settings.openchamber.passkeys.state.uiPasswordRequired')}
          </p>
        )}

        {status.enabled && !supportsPasskeys && (
          <p className="typography-meta text-muted-foreground">
            {supportState.reason}
          </p>
        )}

        {isLoading ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.passkeys.state.loading')}</p>
        ) : passkeys.length === 0 ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.passkeys.state.noneSaved')}</p>
        ) : (
          <div className="space-y-1 pt-1">
            {passkeys.map((passkey) => (
              <div key={passkey.id} className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
                <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                  <span className="typography-ui-label text-foreground truncate">{passkey.label}</span>
                </div>
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="typography-meta text-muted-foreground truncate">
                    {passkey.lastUsedAt
                      ? t('settings.openchamber.passkeys.item.lastUsed', {
                          time: formatTimestamp(passkey.lastUsedAt, t('settings.openchamber.passkeys.time.neverUsed')),
                        })
                      : t('settings.openchamber.passkeys.item.added', {
                          time: formatTimestamp(passkey.createdAt, t('settings.openchamber.passkeys.time.neverUsed')),
                        })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void handleRevokePasskey(passkey.id)}
                    disabled={revokingId === passkey.id}
                    className="!font-normal text-muted-foreground hover:text-foreground"
                  >
                    {revokingId === passkey.id ? t('settings.openchamber.passkeys.actions.removing') : t('settings.common.actions.delete')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {errorMessage && (
        <div className="mt-1 px-2 py-1.5">
          <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
        </div>
      )}
    </div>
  );
};
