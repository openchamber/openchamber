import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SETTINGS_HELPER_CLASS,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  MOBILE_BACKUP_MAX_BYTES,
  MobileBackupError,
  decryptMobileBackup,
  encryptMobileBackup,
  serializeMobileBackup,
} from '@/lib/mobileBackup';
import { shareFileFromNativeApp } from '@/lib/nativeFileShare';
import { cn } from '@/lib/utils';
import { loadMobileConnections, readMobileConnectionBackup, restoreMobileConnectionBackup } from '@/apps/mobileConnections';

/** Short enough to type on a phone keyboard, long enough to be worth stretching. */
const MIN_PASSWORD_LENGTH = 8;

type Feedback = { tone: 'success' | 'error'; text: string };

const isAbortError = (error: unknown): boolean =>
  Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';

const backupFileName = (): string => `openchamber-backup-${new Date().toISOString().slice(0, 10)}.json`;

/**
 * The browser's own save path, for a phone that reached OpenChamber over the
 * network rather than through the app: no share sheet, but a download works.
 */
const downloadFile = (file: File): void => {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

const handOffFile = async (file: File): Promise<void> => {
  try {
    await shareFileFromNativeApp(file);
  } catch (error) {
    // Dismissing the share sheet is a decision, not a failure.
    if (isAbortError(error)) return;
    downloadFile(file);
  }
};

/**
 * Settings → Backup & restore, on the phone only.
 *
 * A phone holds the credentials for every server it has paired with, and there
 * is no other way to move them: this writes one encrypted file that another
 * install can open. The password never leaves the device and cannot be
 * recovered, so both halves of the page say so before anything is pressed.
 */
export const MobileBackupSettings: React.FC = () => {
  const { t } = useI18n();
  const [connectionCount, setConnectionCount] = React.useState<number | null>(null);
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [restorePassword, setRestorePassword] = React.useState('');
  const [exporting, setExporting] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [exportFeedback, setExportFeedback] = React.useState<Feedback | null>(null);
  const [restoreFeedback, setRestoreFeedback] = React.useState<Feedback | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    loadMobileConnections()
      .then((connections) => {
        if (!cancelled) setConnectionCount(connections.length);
      })
      .catch(() => {
        if (!cancelled) setConnectionCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const nothingToExport = connectionCount === 0;
  const busy = exporting || restoring;

  const handleExport = async () => {
    if (busy || nothingToExport) return;
    setExportFeedback(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setExportFeedback({
        tone: 'error',
        text: t('settings.backup.error.passwordShort', { count: MIN_PASSWORD_LENGTH }),
      });
      return;
    }
    if (password !== confirmPassword) {
      setExportFeedback({ tone: 'error', text: t('settings.backup.error.passwordMismatch') });
      return;
    }

    setExporting(true);
    try {
      const connections = await readMobileConnectionBackup();
      if (connections.length === 0) {
        setConnectionCount(0);
        setExportFeedback({ tone: 'error', text: t('settings.backup.error.nothingToExport') });
        return;
      }

      const envelope = await encryptMobileBackup({ connections }, password);
      const file = new File([serializeMobileBackup(envelope)], backupFileName(), {
        type: 'application/json',
      });
      await handOffFile(file);

      setPassword('');
      setConfirmPassword('');
      setExportFeedback({
        tone: 'success',
        text: t('settings.backup.export.status.shared', { count: connections.length }),
      });
    } catch (error) {
      const code = error instanceof MobileBackupError ? error.code : null;
      setExportFeedback({
        tone: 'error',
        text: code === 'crypto-unavailable'
          ? t('settings.backup.error.cryptoUnavailable')
          : t('settings.backup.error.exportFailed'),
      });
    } finally {
      setExporting(false);
    }
  };

  const restoreErrorText = (error: unknown): string => {
    if (error instanceof MobileBackupError) {
      switch (error.code) {
        case 'wrong-password':
          return t('settings.backup.error.wrongPassword');
        case 'unsupported-version':
          return t('settings.backup.error.unsupportedVersion');
        case 'invalid-payload':
          return t('settings.backup.error.invalidPayload');
        case 'crypto-unavailable':
          return t('settings.backup.error.cryptoUnavailable');
        case 'invalid-password':
          return t('settings.backup.error.restorePasswordRequired');
        case 'invalid-file':
        default:
          return t('settings.backup.error.invalidFile');
      }
    }
    return t('settings.backup.error.restoreFailed');
  };

  const handleFile: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;

    setRestoreFeedback(null);
    if (!restorePassword) {
      setRestoreFeedback({ tone: 'error', text: t('settings.backup.error.restorePasswordRequired') });
      return;
    }
    if (file.size > MOBILE_BACKUP_MAX_BYTES) {
      setRestoreFeedback({ tone: 'error', text: t('settings.backup.error.fileTooLarge') });
      return;
    }

    setRestoring(true);
    try {
      const payload = await decryptMobileBackup(await file.text(), restorePassword);
      const result = await restoreMobileConnectionBackup(payload);
      setRestorePassword('');
      setRestoreFeedback({
        tone: 'success',
        text: t('settings.backup.restore.status.done', {
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
        }),
      });
      setConnectionCount((current) => (current === null ? current : current + result.added));
    } catch (error) {
      setRestoreFeedback({ tone: 'error', text: restoreErrorText(error) });
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <SettingsSection
        title={t('settings.backup.export.title')}
        description={t('settings.backup.export.description')}
        settingsItem="backup.export"
        divider={false}
      >
        <div className="space-y-4">
          <SettingsStackedField
            label={<label htmlFor="backup-export-password">{t('settings.backup.field.password')}</label>}
            description={t('settings.backup.field.passwordHint', { count: MIN_PASSWORD_LENGTH })}
          >
            <Input
              id="backup-export-password"
              type="password"
              className="h-8 min-w-0 flex-1"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setExportFeedback(null);
              }}
              autoComplete="new-password"
              disabled={exporting}
            />
          </SettingsStackedField>

          <SettingsStackedField
            label={<label htmlFor="backup-export-confirm">{t('settings.backup.field.confirmPassword')}</label>}
          >
            <Input
              id="backup-export-confirm"
              type="password"
              className="h-8 min-w-0 flex-1"
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setExportFeedback(null);
              }}
              autoComplete="new-password"
              disabled={exporting}
            />
          </SettingsStackedField>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="!font-normal"
              onClick={() => void handleExport()}
              disabled={busy || nothingToExport}
              data-settings-item="backup.export.action"
            >
              <Icon name={exporting ? 'loader-4' : 'download'} className={exporting ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {t(exporting ? 'settings.backup.export.actionBusy' : 'settings.backup.export.action')}
            </Button>
            {nothingToExport ? (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.backup.export.nothingToExport')}</p>
            ) : null}
          </div>

          {exportFeedback ? (
            <p
              aria-live="polite"
              className={cn(
                SETTINGS_HELPER_CLASS,
                exportFeedback.tone === 'error' && 'text-[var(--status-error)]',
              )}
            >
              {exportFeedback.text}
            </p>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.backup.restore.title')}
        description={t('settings.backup.restore.description')}
        settingsItem="backup.restore"
      >
        <div className="space-y-4">
          <SettingsStackedField
            label={<label htmlFor="backup-restore-password">{t('settings.backup.field.restorePassword')}</label>}
            description={t('settings.backup.field.restorePasswordHint')}
          >
            <Input
              id="backup-restore-password"
              type="password"
              className="h-8 min-w-0 flex-1"
              value={restorePassword}
              onChange={(event) => {
                setRestorePassword(event.target.value);
                setRestoreFeedback(null);
              }}
              autoComplete="current-password"
              disabled={restoring}
            />
          </SettingsStackedField>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="!font-normal"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || !restorePassword}
              data-settings-item="backup.restore.action"
            >
              <Icon name={restoring ? 'loader-4' : 'upload-2'} className={restoring ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {t(restoring ? 'settings.backup.restore.actionBusy' : 'settings.backup.restore.action')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label={t('settings.backup.restore.action')}
              onChange={handleFile}
            />
          </div>

          {restoreFeedback ? (
            <p
              aria-live="polite"
              className={cn(
                SETTINGS_HELPER_CLASS,
                restoreFeedback.tone === 'error' && 'text-[var(--status-error)]',
              )}
            >
              {restoreFeedback.text}
            </p>
          ) : null}
        </div>
      </SettingsSection>
    </>
  );
};
