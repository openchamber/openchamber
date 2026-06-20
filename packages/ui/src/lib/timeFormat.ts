import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import type { TimeFormatPreference } from '@/stores/useUIStore';

type TimePrecision = 'minute' | 'second';

const getHour12Option = (preference: TimeFormatPreference): boolean | undefined => {
  if (preference === '12h') return true;
  if (preference === '24h') return false;
  return undefined;
};

export const getUses24HourForPreference = (preference: TimeFormatPreference, locale: string): boolean => {
  if (preference === '24h') return true;
  if (preference === '12h') return false;

  try {
    const options = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
    if (typeof options.hour12 === 'boolean') {
      return !options.hour12;
    }
    return options.hourCycle === 'h23' || options.hourCycle === 'h24';
  } catch {
    return true;
  }
};

export const formatTimeForPreference = (
  timestamp: number | Date,
  preference: TimeFormatPreference,
  options: { precision?: TimePrecision; hour?: 'numeric' | '2-digit'; fallback?: string } = {},
): string => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return options.fallback ?? '';
  }

  return date.toLocaleTimeString(getCurrentIntlLocale(), {
    hour: options.hour ?? 'numeric',
    minute: '2-digit',
    second: options.precision === 'second' ? '2-digit' : undefined,
    hour12: getHour12Option(preference),
  });
};

export const formatDateTimeForPreference = (
  timestamp: number | Date,
  preference: TimeFormatPreference,
  options: Intl.DateTimeFormatOptions,
): string => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }

  return date.toLocaleString(getCurrentIntlLocale(), {
    ...options,
    hour12: options.hour ? getHour12Option(preference) : options.hour12,
  });
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const formatRelativeMessageTime = (timestamp: number, now: number): string => {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) {
    return '';
  }
  const diff = now - timestamp;
  const elapsed = diff < 0 ? 0 : diff;
  const dictionary = useI18nStore.getState().dictionary;

  if (elapsed < MINUTE_MS) {
    return formatMessage(dictionary, 'common.relative.justNow');
  }

  if (elapsed < HOUR_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    return formatMessage(dictionary, 'common.relative.minutesAgoShort2', { count: minutes });
  }

  const days = Math.floor(elapsed / DAY_MS);
  const hours = Math.floor((elapsed % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);

  if (days > 0) {
    return formatMessage(dictionary, 'common.relative.daysHoursMinutesAgoShort', { days, hours, minutes });
  }

  return formatMessage(dictionary, 'common.relative.hoursMinutesAgoShort', { hours, minutes });
};
