import React from 'react';
import type { UsageWindow } from '@/types';
import { formatQuotaValueLabel, formatQuotaResetLabel, formatWindowLabel, calculatePace, calculateExpectedUsagePercent } from '@/lib/quota';
import { UsageProgressBar } from './UsageProgressBar';
import { PaceIndicator } from './PaceIndicator';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { Checkbox } from '@/components/ui/checkbox';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

interface UsageCardProps {
  title: string;
  window: UsageWindow;
  subtitle?: string | null;
  showToggle?: boolean;
  toggleEnabled?: boolean;
  onToggle?: (enabled: boolean) => void;
}

export const UsageCard: React.FC<UsageCardProps> = ({
  title,
  window,
  subtitle,
  showToggle = false,
  toggleEnabled = false,
  onToggle,
}) => {
  const { t } = useI18n();
  const displayMode = useQuotaStore((state) => state.displayMode);
  const showPredValues = useQuotaStore((state) => state.showPredValues);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const displayPercent = displayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
  const barLabel = displayMode === 'remaining'
    ? t('settings.usage.card.bar.remaining')
    : t('settings.usage.card.bar.used');
  const percentLabel = formatQuotaValueLabel(window.valueLabel, displayPercent);
  const resetLabel = formatQuotaResetLabel(window.resetAt, window.resetAfterFormatted ?? window.resetAtFormatted, timeFormatPreference);
  const windowLabel = formatWindowLabel(title);

  const paceInfo = React.useMemo(() => {
    return calculatePace(window.usedPercent, window.resetAt, window.windowSeconds, title);
  }, [window.usedPercent, window.resetAt, window.windowSeconds, title]);

  const expectedMarkerPercent = React.useMemo(() => {
    if (!paceInfo || paceInfo.dailyAllocationPercent === null) {
      return null;
    }
    const expectedUsed = calculateExpectedUsagePercent(paceInfo.elapsedRatio);
    return displayMode === 'remaining' ? 100 - expectedUsed : expectedUsed;
  }, [paceInfo, displayMode]);

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {showToggle && (
            <Checkbox
              checked={toggleEnabled}
              onChange={(checked) => onToggle?.(checked)}
              ariaLabel={t('settings.usage.card.showInHeaderAria')}
            />
          )}
          <div className="min-w-0 flex flex-col">
            <span className="typography-ui-label text-foreground truncate">{windowLabel}</span>
            {subtitle && (
              <span className="typography-meta text-muted-foreground truncate">{subtitle}</span>
            )}
          </div>
        </div>
        <div className="typography-ui-label text-foreground tabular-nums flex items-center justify-end">
          {percentLabel === '-' ? '' : percentLabel}
        </div>
      </div>

      <div className="mt-2.5">
        <UsageProgressBar
          percent={displayPercent}
          tonePercent={window.usedPercent}
          expectedMarkerPercent={expectedMarkerPercent}
          className="h-1.5"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="typography-micro text-muted-foreground">
            {resetLabel ? t('settings.usage.card.resetsAt', { time: resetLabel }) : ''}
          </span>
          <span className="typography-micro text-muted-foreground">
            {barLabel}
          </span>
        </div>
      </div>

      {paceInfo && showPredValues && (
        <div className="mt-1.5">
          <PaceIndicator paceInfo={paceInfo} />
        </div>
      )}
    </div>
  );
};
