import { formatDateTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';

export const SESSION_TIMESTAMP_LABELS = [
  ['created', 'activityTime.created'],
  ['input', 'activityTime.input'],
  ['output', 'activityTime.output'],
  ['activity', 'activityTime.activity'],
] as const;

/** Date and time to the second; the year only when it is not this year. */
export const formatActivityTimestamp = (at: number, preference: TimeFormatPreference): string => {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
  if (new Date(at).getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return formatDateTimeForPreference(at, preference, options);
};
