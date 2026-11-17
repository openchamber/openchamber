import { getCurrentIntlLocale } from '@/lib/i18n';

export const formatCompactNumber = (value: number): string => new Intl.NumberFormat(getCurrentIntlLocale(), {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
}).format(value);
