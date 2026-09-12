export const formatContextUsageValues = (
  totalTokens: number,
  percentage: number,
  intlLocale: string,
) => {
  const tokens = new Intl.NumberFormat(intlLocale, {
    notation: totalTokens >= 1_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(totalTokens);
  const cappedPercentage = Math.min(percentage, 999);
  const formattedPercentage = new Intl.NumberFormat(intlLocale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    style: 'percent',
  }).format(cappedPercentage / 100);

  return { tokens, percentage: formattedPercentage };
};
