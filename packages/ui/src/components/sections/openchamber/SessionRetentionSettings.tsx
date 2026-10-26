import React from 'react';
import { toast } from '@/components/ui';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsChipGroup,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_NUMBER_UNIT_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useI18n, type I18nKey } from '@/lib/i18n';

const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_RETENTION_DAYS = 30;
const RETENTION_ACTION_OPTIONS: Array<{ value: 'archive' | 'delete'; labelKey: I18nKey }> = [
  { value: 'archive', labelKey: 'settings.openchamber.sessionRetention.action.archive' },
  { value: 'delete', labelKey: 'settings.openchamber.sessionRetention.action.delete' },
];

export const SessionRetentionSettings: React.FC = () => {
  const { t } = useI18n();
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const onlyArchived = useUIStore((state) => state.sessionRetentionOnlyArchived);
  const setAutoDeleteEnabled = useUIStore((state) => state.setAutoDeleteEnabled);
  const setAutoDeleteAfterDays = useUIStore((state) => state.setAutoDeleteAfterDays);
  const setSessionRetentionAction = useUIStore((state) => state.setSessionRetentionAction);
  const setOnlyArchived = useUIStore((state) => state.setSessionRetentionOnlyArchived);

  const { candidates, isRunning, runCleanup, action, status } = useSessionAutoCleanup({ autoRun: false });
  const pendingCount = candidates.length;

  const handleRunCleanup = React.useCallback(async () => {
    const result = await runCleanup({ force: true }).catch(() => {
      toast.error(t('sessions.sidebar.group.empty.loadFailed'));
      return null;
    });
    if (!result || (result.skippedReason && result.skippedReason !== 'no-candidates')) return;

    if (result.completedIds.length === 0 && result.failedIds.length === 0) {
      toast.message(
        result.action === 'archive'
          ? t('settings.openchamber.sessionRetention.toast.noneEligibleArchive')
          : t('settings.openchamber.sessionRetention.toast.noneEligibleDelete')
      );
      return;
    }
    if (result.completedIds.length > 0) {
      toast.success(
        result.action === 'archive'
          ? t('settings.openchamber.sessionRetention.toast.archivedCount', { count: result.completedIds.length })
          : t('settings.openchamber.sessionRetention.toast.deletedCount', { count: result.completedIds.length })
      );
    }
    if (result.failedIds.length > 0) {
      toast.error(
        result.action === 'archive'
          ? t('settings.openchamber.sessionRetention.toast.failedArchiveCount', { count: result.failedIds.length })
          : t('settings.openchamber.sessionRetention.toast.failedDeleteCount', { count: result.failedIds.length })
      );
    }
  }, [runCleanup, t]);

  const eligibleText = status === 'error'
    ? t('sessions.sidebar.group.empty.loadFailed')
    : status !== 'ready'
    ? t('sessions.sidebar.group.empty.loadingSessions')
    : action === 'archive'
    ? t('settings.openchamber.sessionRetention.manualCleanup.eligibleArchiveNow', { count: pendingCount })
    : t('settings.openchamber.sessionRetention.manualCleanup.eligibleDeleteNow', { count: pendingCount });

  return (
    <SettingsSection
      title={t('settings.openchamber.sessionRetention.title')}
      info={t(onlyArchived
        ? 'settings.openchamber.sessionRetention.archivedTooltip'
        : 'settings.openchamber.sessionRetention.tooltip')}
      contentClassName="space-y-2"
    >
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsCheckboxRow
          settingsItem="sessions.deletion-dialog"
          checked={showDeletionDialog}
          onChange={setShowDeletionDialog}
          label={t('settings.openchamber.defaults.field.showDeletionDialog')}
          ariaLabel={t('settings.openchamber.defaults.field.showDeletionDialogAria')}
        />
        <SettingsCheckboxRow
          settingsItem="sessions.auto-cleanup"
          checked={autoDeleteEnabled}
          onChange={setAutoDeleteEnabled}
          label={t('settings.openchamber.sessionRetention.field.enableAutoCleanup')}
          ariaLabel={t('settings.openchamber.sessionRetention.field.enableAutoCleanupAria')}
        />
      </div>

      {/* The period, the target and the action also drive "Run cleanup now",
          so they stay editable while auto-cleanup is off. */}
      <div>
        <SettingsFieldRow
          settingsItem="sessions.retention-only-archived"
          label={t('settings.layout.sessions.retention.target')}
          info={t('settings.openchamber.sessionRetention.field.onlyArchivedDescription')}
        >
          <SettingsChipGroup
            value={onlyArchived ? 'archived' : 'unarchived'}
            onChange={(value) => setOnlyArchived(value === 'archived')}
            aria-label={t('settings.layout.sessions.retention.target')}
            options={[
              { value: 'unarchived', label: t('settings.layout.sessions.retention.target.unarchived'), disabled: isRunning },
              { value: 'archived', label: t('settings.layout.sessions.retention.target.archived'), disabled: isRunning },
            ]}
          />
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="sessions.retention-period"
          label={t('settings.openchamber.sessionRetention.field.retentionPeriod')}
        >
          <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
            <NumberInput
              value={autoDeleteAfterDays}
              onValueChange={setAutoDeleteAfterDays}
              min={MIN_DAYS}
              max={MAX_DAYS}
              step={1}
              aria-label={t('settings.openchamber.sessionRetention.field.retentionPeriodAria')}
              className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')}
            />
            <span className={SETTINGS_NUMBER_UNIT_CLASS}>{t('settings.openchamber.sessionRetention.field.days')}</span>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setAutoDeleteAfterDays(DEFAULT_RETENTION_DAYS)}
              disabled={autoDeleteAfterDays === DEFAULT_RETENTION_DAYS}
              className={SETTINGS_ICON_BUTTON_CLASS}
              aria-label={t('settings.openchamber.sessionRetention.actions.resetRetentionAria')}
              title={t('settings.common.actions.reset')}
            >
              <Icon name="restart" className="h-3.5 w-3.5" />
            </Button>
          </div>
        </SettingsFieldRow>

        <SettingsFieldRow
          settingsItem="sessions.retention-action"
          label={t('settings.openchamber.sessionRetention.field.whenSessionsExpire')}
        >
          <SettingsChipGroup
            value={action}
            onChange={setSessionRetentionAction}
            options={RETENTION_ACTION_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
              disabled: onlyArchived && option.value === 'archive',
            }))}
          />
        </SettingsFieldRow>

        <SettingsFieldRow label={t('settings.openchamber.sessionRetention.manualCleanup.title')}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRunCleanup}
            disabled={isRunning}
            className="!font-normal"
          >
            {isRunning ? t('settings.openchamber.sessionRetention.actions.cleaningUp') : t('settings.openchamber.sessionRetention.actions.runCleanupNow')}
          </Button>
          <span className="typography-meta truncate text-muted-foreground" aria-live="polite" title={eligibleText}>
            {eligibleText}
          </span>
        </SettingsFieldRow>
      </div>
    </SettingsSection>
  );
};
