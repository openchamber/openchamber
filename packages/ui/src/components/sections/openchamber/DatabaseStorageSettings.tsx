import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { formatFileSize } from '@/lib/fileSize';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useDatabaseMaintenance, type DatabaseCompactionPhase } from '@/hooks/useDatabaseMaintenance';

const sizeLabel = (bytes: number): string => formatFileSize(bytes) || '0 B';

const PHASE_LABEL_KEYS = {
  stopping: 'settings.openchamber.database.stepStopping',
  checkpoint: 'settings.openchamber.database.stepWorking',
  vacuum: 'settings.openchamber.database.stepWorking',
  integrity: 'settings.openchamber.database.stepWorking',
  restarting: 'settings.openchamber.database.stepRestarting',
  done: 'settings.openchamber.database.stepWorking',
  failed: 'settings.openchamber.database.stepWorking',
} satisfies Record<DatabaseCompactionPhase, I18nKey>;

/**
 * SQLite keeps the space of deleted rows until a rewrite returns it to the
 * file system. That rewrite needs OpenCode stopped, so this surface always
 * says what it will interrupt before it starts.
 */
export const DatabaseStorageSettings: React.FC = () => {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const { overview, error, isLoading, isRunning, compactDatabase, scheduleCompaction } = useDatabaseMaintenance();
  const announcedCompaction = React.useRef<string | null>(null);
  const sawRunningCompaction = React.useRef(false);

  const compaction = overview?.compaction ?? null;

  React.useEffect(() => {
    if (isRunning) sawRunningCompaction.current = true;
  }, [isRunning]);

  React.useEffect(() => {
    if (!compaction || !overview) return;
    if (compaction.phase !== 'done' && compaction.phase !== 'failed') return;
    if (announcedCompaction.current === compaction.id) return;
    announcedCompaction.current = compaction.id;
    // A finished job from an earlier visit is history, not news: only a
    // compaction this page saw running gets a toast.
    if (!sawRunningCompaction.current) return;
    sawRunningCompaction.current = false;

    if (compaction.phase === 'done') {
      toast.success(t('settings.openchamber.database.toastFreed', {
        size: formatFileSize(overview.lastCompaction?.freedBytes ?? 0),
      }));
      return;
    }
    toast.error(t('settings.openchamber.database.toastFailed'));
  }, [compaction, overview, t]);

  const externalOpenCode = overview?.externalOpenCode ?? false;
  const inMemory = overview?.inMemory ?? false;
  const blockedReason = overview?.blockedReason ?? null;
  const nothingToReclaim = blockedReason === 'nothing-reclaimable';
  const driverMissing = blockedReason === 'sqlite-unavailable';
  const databaseExists = overview?.exists ?? false;

  const compactDisabled = isLoading
    || !databaseExists
    || externalOpenCode
    || inMemory
    || driverMissing
    || nothingToReclaim
    || isRunning;
  const scheduleDisabled = isLoading
    || !databaseExists
    || externalOpenCode
    || inMemory
    || driverMissing
    || isRunning;

  const handleCompact = React.useCallback(async () => {
    const accepted = await confirm({
      title: t('settings.openchamber.database.confirmTitle'),
      message: t('settings.openchamber.database.confirmMessage'),
      action: t('settings.openchamber.database.confirmAction'),
      destructive: true,
    });
    if (!accepted) return;
    // A small database can finish before the first poll; the toast should still
    // report it.
    sawRunningCompaction.current = true;
    try {
      await compactDatabase();
    } catch {
      sawRunningCompaction.current = false;
      toast.error(t('settings.openchamber.database.toastFailed'));
    }
  }, [compactDatabase, confirm, t]);

  const handleSchedule = React.useCallback(async () => {
    try {
      await scheduleCompaction();
      toast.success(t('settings.openchamber.database.toastScheduled'));
    } catch {
      toast.error(t('settings.openchamber.database.toastFailed'));
    }
  }, [scheduleCompaction, t]);

  const statusText = (() => {
    if (isRunning && compaction) return t(PHASE_LABEL_KEYS[compaction.phase]);
    if (overview?.pendingOnNextRestart) return t('settings.openchamber.database.scheduled');
    if (externalOpenCode) return t('settings.openchamber.database.external');
    if (inMemory) return t('settings.openchamber.database.inMemory');
    if (error || driverMissing) return t('settings.openchamber.database.unavailable');
    if (!databaseExists) return t('settings.openchamber.database.noDatabase');
    if (overview && overview.activeTurns > 0) {
      return t('settings.openchamber.database.runningTurns', { count: overview.activeTurns });
    }
    return null;
  })();

  const historyText = databaseExists
    ? (overview?.lastCompaction
      ? t('settings.openchamber.database.lastFreed', {
        size: formatFileSize(overview.lastCompaction.freedBytes),
      })
      : t('settings.openchamber.database.never'))
    : null;

  return (
    <>
      <SettingsSection
        title={t('settings.openchamber.database.title')}
        info={t('settings.openchamber.database.info')}
        contentClassName="space-y-2"
        settingsItem="sessions.database"
      >
        {databaseExists && overview ? (
          <div>
            <SettingsFieldRow label={t('settings.openchamber.database.size')}>
              <span className="typography-ui-label tabular-nums">{sizeLabel(overview.bytes)}</span>
            </SettingsFieldRow>
            <SettingsFieldRow label={t('settings.openchamber.database.reclaimable')}>
              <span className="typography-ui-label tabular-nums">{sizeLabel(overview.reclaimableBytes)}</span>
            </SettingsFieldRow>
            <SettingsFieldRow label={t('settings.openchamber.database.live')}>
              <span className="typography-ui-label tabular-nums">{sizeLabel(overview.liveBytes)}</span>
            </SettingsFieldRow>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={handleCompact}
            disabled={compactDisabled}
            className="!font-normal"
          >
            {t('settings.openchamber.database.compactNow')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleSchedule}
            disabled={scheduleDisabled || (overview?.pendingOnNextRestart ?? false)}
            className="!font-normal"
          >
            {t('settings.openchamber.database.schedule')}
          </Button>
        </div>

        {statusText ? (
          <span className="typography-meta block text-muted-foreground" aria-live="polite">
            {statusText}
          </span>
        ) : null}
        {historyText ? (
          <span className="typography-meta block text-muted-foreground">{historyText}</span>
        ) : null}
      </SettingsSection>
      {dialog}
    </>
  );
};
