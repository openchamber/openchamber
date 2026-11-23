import type { QuotaProviderId, UsageWindow } from '@/types';
import { formatQuotaWindowValueLabel, formatQuotaResetLabel, formatQuotaResetDuration, formatWindowLabel } from '@/lib/quota';
import { UsageProgressBar } from './UsageProgressBar';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { Checkbox } from '@/components/ui/checkbox';
import { useUIStore } from '@/stores/useUIStore';
import { useMinuteTickerNow } from '@/hooks/useDurationTicker';
import { UsageGiftResetButton } from '@/components/usage/UsageGiftResetButton';
import { useI18n } from '@/lib/i18n';

interface UsageCardProps {
  title: string;
  window: UsageWindow;
  subtitle?: string | null;
  showToggle?: boolean;
  toggleEnabled?: boolean;
  toggleDisabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  providerId?: QuotaProviderId;
  showGiftReset?: boolean;
}

export const UsageCard: React.FC<UsageCardProps> = ({
  title,
  window,
  subtitle,
  showToggle = false,
  toggleEnabled = false,
  toggleDisabled = false,
  onToggle,
  providerId,
  showGiftReset = false,
}) => {
  const { t } = useI18n();
  const displayMode = useQuotaStore((state) => state.displayMode);
  const resetDisplay = useQuotaStore((state) => state.resetDisplay);
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const now = useMinuteTickerNow(resetDisplay === 'relative');
  const displayPercent = displayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
  const hasPercent = displayPercent !== null;
  const barLabel = displayMode === 'remaining'
    ? t('settings.usage.card.bar.remaining')
    : t('settings.usage.card.bar.used');
  const percentLabel = formatQuotaWindowValueLabel(window, displayPercent, t);
  const resetLabel = formatQuotaResetLabel(
    window.resetAt,
    window.resetAfterFormatted ?? window.resetAtFormatted,
    timeFormatPreference,
    providerId,
  );
  const resetDuration = resetDisplay === 'relative' ? formatQuotaResetDuration(window.resetAt, { now }) : null;
  const resetText = resetDuration
    ? t('settings.usage.card.resetsIn', { duration: resetDuration })
    : resetLabel ? t('settings.usage.card.resetsAt', { time: resetLabel }) : '';
  const windowLabel = formatWindowLabel(title);

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {showToggle && (
            <Checkbox
              checked={toggleEnabled}
              disabled={toggleDisabled}
              onChange={(checked) => onToggle?.(checked)}
              ariaLabel={t('settings.usage.page.options.showInWorkStatusAria')}
            />
          )}
          <div className="min-w-0 flex flex-col">
            <span className="typography-ui-label text-foreground truncate">{windowLabel}</span>
            {subtitle && (
              <span className="typography-meta text-muted-foreground truncate">{subtitle}</span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1">
          {showGiftReset && providerId && <UsageGiftResetButton window={window} providerId={providerId} />}
          <div className="typography-ui-label text-foreground tabular-nums">
            {percentLabel === '-' ? '' : percentLabel}
          </div>
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
