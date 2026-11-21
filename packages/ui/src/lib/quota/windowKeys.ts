const MONTHLY_TOTAL_WINDOW_KEY = 'monthly_total';

const OPENROUTER_PROVIDER_ID = 'openrouter';

type CapCandidate = {
  usedPercent: number | null;
  valueLabel?: string | null;
  value?: { kind: 'requests' } | { kind: 'spend'; spent: number | null; limit: number | null };
};

const isCapWindow = (window: CapCandidate): boolean => (
  window.usedPercent !== null
  || Boolean(window.valueLabel)
  || (window.value?.kind === 'spend' && window.value.limit !== null)
);

const hasKnownSpend = (window: CapCandidate): boolean => window.value?.kind === 'spend' && window.value.spent !== null;

export const openRouterSpendSelection = (
  providerId: string,
  windows: Readonly<Record<string, CapCandidate>>,
): { capKeys: string[]; fallbackKey: string } | null => {
  if (providerId.trim().toLowerCase() !== OPENROUTER_PROVIDER_ID) return null;
  const total = windows[MONTHLY_TOTAL_WINDOW_KEY];
  if (!total) return null;
  const others = Object.keys(windows).filter((key) => key !== MONTHLY_TOTAL_WINDOW_KEY);
  const readable = hasKnownSpend(total) ? undefined : others.find((key) => hasKnownSpend(windows[key]));
  return {
    capKeys: others.filter((key) => isCapWindow(windows[key])),
    fallbackKey: readable ?? MONTHLY_TOTAL_WINDOW_KEY,
  };
};
