import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import {
  cancelPasskeyCeremony,
  defaultPasskeyStatus,
  fetchPasskeyStatus,
  fetchStoredPasskeys,
  getPasskeySupportState,
  isPasskeyCeremonyAbort,
  registerCurrentDevicePasskey,
  renameStoredPasskey,
  resetAllAuth,
  revokeStoredPasskey,
  type PasskeyStatus,
  type StoredPasskey,
} from '@/lib/passkeys';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';

const formatTimestamp = (timestamp: number | null, neverUsedText: string, timeFormatPreference: TimeFormatPreference) => {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return neverUsedText;
  }

  return new Intl.DateTimeFormat(getCurrentIntlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: timeFormatPreference === 'auto' ? undefined : timeFormatPreference === '12h',
  }).format(timestamp);
};

export const PasskeySettings: React.FC = () => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isRegistering, setIsRegistering] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [isResetting, setIsResetting] = React.useState(false);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [isRenaming, setIsRenaming] = React.useState(false);
  const renameCancelledRef = React.useRef(false);
  const renameSubmittingRef = React.useRef(false);
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

  const startRenamePasskey = React.useCallback((passkey: StoredPasskey) => {
    renameCancelledRef.current = false;
    setRenameDraft(passkey.customLabel ?? '');
    setRenamingId(passkey.id);
  }, []);

  const cancelRenamePasskey = React.useCallback(() => {
    renameCancelledRef.current = true;
    setRenameDraft('');
    setRenamingId(null);
  }, []);

  const submitRenamePasskey = React.useCallback(async (passkey: StoredPasskey) => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false;
      return;
    }
    if (renameSubmittingRef.current) {
      return;
    }
    // Opening the editor and leaving it unchanged is not a rename.
    if (renameDraft.trim() === (passkey.customLabel ?? '')) {
      setRenamingId((current) => (current === passkey.id ? null : current));
      return;
    }

    renameSubmittingRef.current = true;
    setIsRenaming(true);
    setErrorMessage('');

    try {
      const updated = await renameStoredPasskey(passkey.id, renameDraft);
      if (updated) {
        setPasskeys((current) => current.map((item) => (item.id === passkey.id ? updated : item)));
      } else {
        await loadPasskeys();
      }
      // Only close the editor for this row; another row may have opened
      // while the save was in flight.
      setRenamingId((current) => (current === passkey.id ? null : current));
      toast.success(t('settings.openchamber.passkeys.toast.renamed'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.openchamber.passkeys.toast.renameFailed');
      setErrorMessage(message);
      toast.error(message);
    } finally {
      renameSubmittingRef.current = false;
      setIsRenaming(false);
    }
  }, [loadPasskeys, renameDraft, t]);

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
    <SettingsSection title={t('settings.openchamber.passkeys.title')}>
      <div className="space-y-2">
        <SettingsFieldRow label={t('settings.openchamber.passkeys.field.currentDevice')}>
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
        </SettingsFieldRow>

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
            {passkeys.map((passkey) => {
              const isEditingPasskey = renamingId === passkey.id;
              return (
                <SettingsFieldRow
                  key={passkey.id}
                  label={isEditingPasskey ? (
                    <Input
                      value={renameDraft}
                      placeholder={passkey.label}
                      inputSize="compact"
                      autoFocus
                      maxLength={120}
                      disabled={isRenaming}
                      aria-label={t('settings.openchamber.passkeys.actions.rename')}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={() => void submitRenamePasskey(passkey)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelRenamePasskey();
                        }
                      }}
                    />
                  ) : (
                    <span title={passkey.label}>{passkey.label}</span>
                  )}
                  alignEnd={false}
                  controlClassName="justify-between sm:flex-1"
                >
                  <span className="typography-meta text-muted-foreground truncate">
                    {passkey.lastUsedAt
                      ? t('settings.openchamber.passkeys.item.lastUsed', {
                          time: formatTimestamp(passkey.lastUsedAt, t('settings.openchamber.passkeys.time.neverUsed'), timeFormatPreference),
                        })
                      : t('settings.openchamber.passkeys.item.added', {
                          time: formatTimestamp(passkey.createdAt, t('settings.openchamber.passkeys.time.neverUsed'), timeFormatPreference),
                        })}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {!isEditingPasskey && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => startRenamePasskey(passkey)}
                        disabled={isRenaming}
                        aria-label={t('settings.openchamber.passkeys.actions.rename')}
                        title={t('settings.openchamber.passkeys.actions.rename')}
                        className="!font-normal text-muted-foreground hover:text-foreground"
                      >
                        <Icon name="pencil" className="h-3.5 w-3.5" />
                      </Button>
                    )}
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
                </SettingsFieldRow>
              );
            })}
          </div>
        )}
      </div>

      {errorMessage && (
        <div className="mt-1 py-1.5">
          <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
        </div>
      )}
    </SettingsSection>
  );
};
