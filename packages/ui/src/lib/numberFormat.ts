import { getCurrentIntlLocale } from '@/lib/i18n';

/** Compact, locale-aware number formatting (for example `1.5K`, `2M`). */
export const formatCompactNumber = (value: number): string => new Intl.NumberFormat(getCurrentIntlLocale(), {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
}).format(value);
