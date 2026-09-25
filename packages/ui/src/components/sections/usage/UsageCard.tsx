import type { UsageWindow } from '@/types';
import { formatQuotaValueLabel, formatQuotaResetLabel, formatWindowLabel } from '@/lib/quota';
import { UsageProgressBar } from './UsageProgressBar';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { Checkbox } from '@/components/ui/checkbox';
import { useUIStore } from '@/stores/useUIStore';

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
  const displayMode = useQuotaStore((state) => state.displayMode);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const displayPercent = displayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
  // A balance-only window (DeepSeek's credits balance) carries a value label
  // and no percentage. An empty track with a "used" caption under it read as
  // "0% used", so the bar and its caption only render when there is a share
  // to show; the reset time still does.
  const hasPercent = displayPercent !== null;
  const barLabel = displayMode === 'remaining' ? 'remaining' : 'used';
  const percentLabel = formatQuotaValueLabel(window.valueLabel, displayPercent);
  const resetLabel = formatQuotaResetLabel(window.resetAt, window.resetAfterFormatted ?? window.resetAtFormatted, timeFormatPreference);
  const resetText = resetLabel ? `Resets ${resetLabel}` : '';
  const windowLabel = formatWindowLabel(title);

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {showToggle && (
            <Checkbox
              checked={toggleEnabled}
              onChange={(checked) => onToggle?.(checked)}
              ariaLabel="Show in dropdown"
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

      {hasPercent ? (
        <div className="mt-2.5">
          <UsageProgressBar
            percent={displayPercent}
            tonePercent={window.usedPercent}
            className="h-1.5"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="typography-micro text-muted-foreground">
              {resetText}
            </span>
            <span className="typography-micro text-muted-foreground">
              {barLabel}
            </span>
          </div>
        </div>
      ) : resetText ? (
        <div className="mt-1 typography-micro text-muted-foreground">{resetText}</div>
      ) : null}

    </div>
  );
};
