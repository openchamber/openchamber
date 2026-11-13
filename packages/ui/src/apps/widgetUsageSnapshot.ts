import type { I18nKey, I18nParams } from '@/lib/i18n';
import {
  compactQuotaValueLabel,
  formatQuotaResetShort,
  formatQuotaWindowValueLabel,
  formatWindowLabel,
  resolveUsageTone,
} from '@/lib/quota';
import type { ProviderResult, QuotaProviderId, UsageWindow } from '@/types';
import type { TimeFormatPreference } from '@/stores/useUIStore';

/** One window row, with every text already formatted the way the Usage page formats it. */
type WidgetQuota = {
  label: string;
  /** Right-hand value: the percentage, or the provider's own count or balance. */
  value: string;
  /** Bar fill in the chosen display mode; absent for a window without a share (a balance). */
  percent?: number;
  tone: 'safe' | 'warn' | 'critical';
  reset?: string;
};

type WidgetProvider = {
  id: string;
  name: string;
  windows: WidgetQuota[];
};

type WidgetUsageSnapshot = {
  mode: 'used' | 'remaining';
  providers: WidgetProvider[];
};

export type WidgetQuotaInput = {
  displayMode: 'usage' | 'remaining';
  dropdownProviderIds: readonly QuotaProviderId[];
  selectedModels: Record<string, string[]>;
  results: readonly ProviderResult[];
};

type WidgetFormat = {
  t: (key: I18nKey, params?: I18nParams) => string;
  timeFormatPreference: TimeFormatPreference;
};

// Provider-supplied names such as Antigravity's "Google models · 5-Hour" pass through.
const quotaLabel = (key: string): string => (key.includes(' · ') ? key : formatWindowLabel(key));

const quota = (key: string, window: UsageWindow, mode: 'used' | 'remaining', format: WidgetFormat): WidgetQuota => {
  const percent = mode === 'remaining' ? window.remainingPercent : window.usedPercent;
  const value = formatQuotaWindowValueLabel(window, percent, format.t);
  const entry: WidgetQuota = {
    label: quotaLabel(key),
    value: value === '-' ? '' : compactQuotaValueLabel(value),
    tone: resolveUsageTone(window.usedPercent),
  };
  if (percent !== null && Number.isFinite(percent)) entry.percent = Math.min(100, Math.max(0, percent));
  const reset = formatQuotaResetShort(window.resetAt, window.resetAfterFormatted ?? window.resetAtFormatted,
    format.timeFormatPreference);
  if (reset) entry.reset = format.t('settings.usage.card.resetsAt', { time: reset });
  return entry;
};

/**
 * The quota readout as the Usage page shows it: the providers picked for the dropdown in their
 * order, the selected models, the page's value, tone and reset texts. Reads the quota store
 * only; the widget makes no provider calls of its own.
 */
export const createWidgetUsageSnapshot = (state: WidgetQuotaInput, format: WidgetFormat): WidgetUsageSnapshot => {
  const mode = state.displayMode === 'usage' ? 'used' : 'remaining';
  const providers = state.dropdownProviderIds.flatMap((id): WidgetProvider[] => {
    const result = state.results.find((entry) => entry.providerId === id);
    if (!result?.configured || !result.usage) return [];
    const windows = Object.entries(result.usage.windows ?? {})
      .map(([key, value]) => quota(key, value, mode, format));
    const selected = state.selectedModels[id];
    for (const [modelName, model] of Object.entries(result.usage.models ?? {})) {
      if (selected?.length && !selected.includes(modelName)) continue;
      for (const [key, window] of Object.entries(model.windows ?? {})) {
        windows.push(quota(`${modelName} · ${key}`, window, mode, format));
      }
    }
    return windows.length > 0 ? [{ id, name: result.providerName, windows }] : [];
  });
  return { mode, providers };
};
