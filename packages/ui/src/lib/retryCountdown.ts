import type { Locale } from '@/lib/i18n';

const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

export const toRetryTargetTimestamp = (next: number, now: number = Date.now()): number => {
  if (next >= EPOCH_MILLISECONDS_THRESHOLD) {
    return next;
  }
  if (next >= EPOCH_SECONDS_THRESHOLD) {
    return next * 1000;
  }
  return now + next;
};

export const formatRetryCountdown = (seconds: number, locale: Locale): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: Array<[string, number]> = days > 0 ? [['day', days], ['hour', hours]]
    : hours > 0 ? [['hour', hours], ['minute', minutes]]
      : minutes > 0 ? [['minute', minutes], ['second', secs]]
        : [['second', secs]];
  return parts
    .filter(([, value], index) => index === 0 || value > 0)
    .map(([unit, value]) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value))
    .join(' ');
};
