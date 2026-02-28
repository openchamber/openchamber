import React from 'react';
import { cn } from '@/lib/utils';
import type { PaceInfo } from '@/lib/quota';
import { getPaceStatusColor, formatRemainingTime } from '@/lib/quota';
import { useLanguage } from '@/hooks/useLanguage';

interface PaceIndicatorProps {
  paceInfo: PaceInfo;
  className?: string;
  /** Compact mode shows just the status dot and prediction */
  compact?: boolean;
}

/**
 * Visual indicator showing whether usage is on track, slightly fast, or too fast.
 * Inspired by opencode-bar's pace visualization.
 */
export const PaceIndicator: React.FC<PaceIndicatorProps> = ({
  paceInfo,
  className,
  compact = false,
}) => {
  const { t } = useLanguage();
  const statusColor = getPaceStatusColor(paceInfo.status);

  const statusLabel = React.useMemo(() => {
    switch (paceInfo.status) {
      case 'on-track':
        return t('paceIndicator.onTrack');
      case 'slightly-fast':
        return t('paceIndicator.slightlyFast');
      case 'too-fast':
        return t('paceIndicator.tooFast');
      case 'exhausted':
        return t('paceIndicator.usedUp');
    }
  }, [paceInfo.status, t]);

  const predictionTooltip = t('paceIndicator.predictedUsageTooltip', { predictText: paceInfo.predictText });

  if (compact) {
    return (
      <div className={cn('flex items-center gap-1.5', className)}>
        <div
          className="h-2 w-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: statusColor }}
          title={statusLabel}
        />
        <span
          className="typography-micro tabular-nums"
          style={{ color: statusColor }}
          title={paceInfo.isExhausted ? undefined : predictionTooltip}
        >
          {paceInfo.isExhausted ? (
            <>{t('paceIndicator.wait')} {formatRemainingTime(paceInfo.remainingSeconds)}</>
          ) : (
            <>{t('paceIndicator.predPrefix')} {paceInfo.predictText}</>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      <div className="flex items-center gap-1.5">
        {!paceInfo.isExhausted && (
          <span className="typography-micro text-muted-foreground">
            {t('paceIndicator.pacePrefix')} {paceInfo.paceRateText}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="typography-micro tabular-nums"
          style={{ color: statusColor }}
        >
          {paceInfo.isExhausted ? (
            <>
              <span className="font-medium">{statusLabel}</span>
              <span className="text-muted-foreground"> · {t('paceIndicator.wait')} </span>
              <span className="font-medium">{formatRemainingTime(paceInfo.remainingSeconds)}</span>
            </>
          ) : (
            <span title={predictionTooltip}>
              <span className="text-muted-foreground">{t('paceIndicator.predPrefix')} </span>
              <span className="font-medium">{paceInfo.predictText}</span>
            </span>
          )}
        </span>
        <div
          className="h-2 w-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: statusColor }}
          title={statusLabel}
        />
      </div>
    </div>
  );
};
