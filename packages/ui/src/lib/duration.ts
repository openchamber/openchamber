import type { I18nKey, I18nParams } from '@/lib/i18n';

type Translate = (key: I18nKey, params?: I18nParams) => string;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Compact localized duration: `7s`, `1m 23s`, `1h 2m`.
 *
 * Seconds are dropped past an hour so the label cannot outgrow the row's
 * metadata slot, and the unit suffixes are translated rather than concatenated
 * so locales that place or spell them differently stay correct.
 */
export const formatCompactDuration = (
  durationMs: number,
  t: Translate,
  { secondsPrecision = 0, minimumSeconds = 0 }: { secondsPrecision?: 0 | 1; minimumSeconds?: number } = {},
): string => {
  const total = Math.max(0, durationMs);

  if (total < MINUTE_MS) {
    const seconds = Math.max(minimumSeconds, total / SECOND_MS);
    return t('common.duration.secondsCompact', {
      seconds: secondsPrecision === 1 ? seconds.toFixed(1) : Math.floor(seconds),
    });
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
