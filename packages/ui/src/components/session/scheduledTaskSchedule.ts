import type { useI18n } from '@/lib/i18n';
import type { ScheduledTask } from '@/lib/scheduledTasksApi';
import { canonicalizeTimezone } from '@/lib/timezones';

/** A task's run times as HH:mm, each once, in order; malformed entries are dropped. */
const scheduleTimes = (schedule: ScheduledTask['schedule']): string[] => {
  const raw = Array.isArray(schedule.times)
    ? schedule.times
    : (schedule.time ? [schedule.time] : []);
  const valid = raw.filter((value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(value));
  return Array.from(new Set(valid)).sort((a, b) => a.localeCompare(b));
};

/** A task's schedule in words, as the Scheduled tasks list and the chat show it. */
export const formatSchedule = (schedule: ScheduledTask['schedule'], t: ReturnType<typeof useI18n>['t']): string => {
  const timesLabel = scheduleTimes(schedule).join(', ') || '--:--';
  const formatWeekday = (value: number) => {
    if (value === 0) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sun');
    if (value === 1) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.mon');
    if (value === 2) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.tue');
    if (value === 3) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.wed');
    if (value === 4) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.thu');
    if (value === 5) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.fri');
    if (value === 6) return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sat');
    return t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown');
  };
  if (schedule.kind === 'daily') {
    if (schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.dailyWithTimezone', {
        time: timesLabel,
        timezone: canonicalizeTimezone(schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.daily', { time: timesLabel });
  }
  if (schedule.kind === 'weekly') {
    const days = Array.isArray(schedule.weekdays)
      ? schedule.weekdays.map((value) => formatWeekday(value)).join(', ')
      : '';
    if (schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.weeklyWithTimezone', {
        days,
        time: timesLabel,
        timezone: canonicalizeTimezone(schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.weekly', { days, time: timesLabel });
  }
  if (schedule.kind === 'once') {
    const date = schedule.date?.trim() ? schedule.date : t('sessions.scheduledTasks.dialog.schedule.unknownDate');
    const time = schedule.time?.trim() ? schedule.time : '--:--';
    if (schedule.timezone) {
      return t('sessions.scheduledTasks.dialog.schedule.onceWithTimezone', {
        date,
        time,
        timezone: canonicalizeTimezone(schedule.timezone),
      });
    }
    return t('sessions.scheduledTasks.dialog.schedule.once', { date, time });
  }
  if (schedule.timezone) {
    return t('sessions.scheduledTasks.dialog.schedule.cronWithTimezone', {
      cron: schedule.cron || '',
      timezone: canonicalizeTimezone(schedule.timezone),
    });
  }
  return t('sessions.scheduledTasks.dialog.schedule.cron', { cron: schedule.cron || '' });
};
