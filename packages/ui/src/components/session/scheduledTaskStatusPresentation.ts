import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { IconName } from '@/components/icon/icons';
import type { ScheduledTaskStatus } from '@/lib/scheduledTasksApi';

type Translate = (key: I18nKey, params?: I18nParams) => string;

export type StatusTone = 'success' | 'error' | 'warning' | 'muted';

export const STATUS_META: Record<
  ScheduledTaskStatus,
  {
    tone: StatusTone;
    Icon: IconName;
    spin?: boolean;
  }
> = {
  success: { tone: 'success', Icon: 'checkbox-circle' },
  error: { tone: 'error', Icon: 'error-warning' },
  denied: { tone: 'error', Icon: 'shield' },
  running: { tone: 'warning', Icon: 'loader-4', spin: true },
  idle: { tone: 'muted', Icon: 'pulse' },
};

export const getScheduledTaskStatusLabel = (status: ScheduledTaskStatus, t: Translate): string => {
  if (status === 'success') return t('sessions.scheduledTasks.dialog.status.success');
  if (status === 'error') return t('sessions.scheduledTasks.dialog.status.error');
  if (status === 'denied') return t('sessions.scheduledTasks.dialog.status.denied');
  if (status === 'running') return t('sessions.scheduledTasks.dialog.status.running');
  return t('sessions.scheduledTasks.dialog.status.idle');
};
