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
import { m } from '@/lib/i18n/messages';

const formatTimestamp = (timestamp: number | null) => {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return m.passkeyNeverUsed();
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
};

export const PasskeySettings: React.FC = () => {
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
      const message = error instanceof Error ? error.message : m.passkeyFailedLoad();
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

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
      const message = m.passkeyEnableLockFirst();
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
      toast.success(m.passkeyToastAdded());
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        toast.message(m.passkeyToastCanceled());
        return;
      }

      const message = error instanceof Error ? error.message : m.passkeyFailedAdd();
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setIsRegistering(false);
    }
  }, [isRegistering, loadPasskeys, status.enabled, supportState.reason, supportsPasskeys]);

  const handleRevokePasskey = React.useCallback(async (id: string) => {
    setRevokingId(id);
    setErrorMessage('');

    try {
      await revokeStoredPasskey(id);
      setStatus(await fetchPasskeyStatus());
      await loadPasskeys();
      toast.success(m.passkeyToastRemoved());
    } catch (error) {
      const message = error instanceof Error ? error.message : m.passkeyFailedRemove();
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setRevokingId(null);
    }
  }, [loadPasskeys]);

  const handleResetAllAuth = React.useCallback(async () => {
    setIsResetting(true);
    setErrorMessage('');

    try {
      await resetAllAuth();
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : m.passkeyFailedClearAuth();
      setErrorMessage(message);
      toast.error(message);
      setIsResetting(false);
    }
  }, []);

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{m.passkeyTitle()}</h3>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-2">
        <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">{m.passkeyCurrentDevice()}</span>
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
              {isRegistering ? m.passkeyCancelSetup() : m.passkeyAdd()}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void handleResetAllAuth()}
              disabled={isLoading || isRegistering || isResetting}
              className="!font-normal text-muted-foreground hover:text-foreground"
            >
              {isResetting ? m.passkeySigningOut() : m.passkeySignOut()}
            </Button>
          </div>
        </div>

        {!status.enabled && (
          <p className="typography-meta text-muted-foreground">
            {m.passkeyLockRequired()}
          </p>
        )}

        {status.enabled && !supportsPasskeys && (
          <p className="typography-meta text-muted-foreground">
            {supportState.reason}
          </p>
        )}

        {isLoading ? (
          <p className="typography-meta text-muted-foreground">{m.passkeyLoading()}</p>
        ) : passkeys.length === 0 ? (
          <p className="typography-meta text-muted-foreground">{m.passkeyNone()}</p>
        ) : (
          <div className="space-y-1 pt-1">
            {passkeys.map((passkey) => (
              <div key={passkey.id} className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
                <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                  <span className="typography-ui-label text-foreground truncate">{passkey.label}</span>
                </div>
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="typography-meta text-muted-foreground truncate">
                    {passkey.lastUsedAt ? m.passkeyLastUsed({ time: formatTimestamp(passkey.lastUsedAt) }) : m.passkeyAdded({ time: formatTimestamp(passkey.createdAt) })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void handleRevokePasskey(passkey.id)}
                    disabled={revokingId === passkey.id}
                    className="!font-normal text-muted-foreground hover:text-foreground"
                  >
                    {revokingId === passkey.id ? m.passkeyRemoving() : m.passkeyRemove()}
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
