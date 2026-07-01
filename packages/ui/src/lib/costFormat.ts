import { getCurrentIntlLocale } from '@/lib/i18n';

export const formatUsdCost = (value: number): string => {
  const safeValue = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  return new Intl.NumberFormat(getCurrentIntlLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: safeValue > 0 && safeValue < 0.01 ? 4 : 2,
    maximumFractionDigits: safeValue > 0 && safeValue < 0.01 ? 4 : 2,
  }).format(safeValue);
};
