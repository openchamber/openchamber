import { getCurrentIntlLocale } from './i18n';


export const formatMoney = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return new Intl.NumberFormat(getCurrentIntlLocale(), {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0);
  }
  return new Intl.NumberFormat(getCurrentIntlLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
};
