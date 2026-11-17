import type { I18nKey, I18nParams } from '@/lib/i18n';

type Translate = (key: I18nKey, params?: I18nParams) => string;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export const formatSessionActivityDuration = (durationMs: number, t: Translate): string => {
  const total = Math.max(0, durationMs);

  if (total < MINUTE_MS) {
    return t('common.duration.secondsCompact', { seconds: Math.floor(total / SECOND_MS) });
  }
  if (total < HOUR_MS) {
    return t('common.duration.minutesSecondsCompact', {
      minutes: Math.floor(total / MINUTE_MS),
      seconds: Math.floor((total % MINUTE_MS) / SECOND_MS),
    });
  }
  return t('common.duration.hoursMinutesCompact', {
    hours: Math.floor(total / HOUR_MS),
    minutes: Math.floor((total % HOUR_MS) / MINUTE_MS),
  });
};
