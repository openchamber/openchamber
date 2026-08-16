import React from 'react';
import { cn } from '@/lib/utils';
import type { PaceInfo } from '@/lib/quota';
import { getPaceStatusColor, formatRemainingTime } from '@/lib/quota';
import { useI18n } from '@/lib/i18n';

interface PaceIndicatorProps {
  paceInfo: PaceInfo;
  className?: string;
}

/**
 * Visual indicator showing whether usage is on track, slightly fast, or too fast.
 * Inspired by opencode-bar's pace visualization.
 */
export const PaceIndicator: React.FC<PaceIndicatorProps> = ({
  paceInfo,
  className,
}) => {
  const { t } = useI18n();
  const statusColor = getPaceStatusColor(paceInfo.status);

  const statusLabel = React.useMemo(() => {
      switch (paceInfo.status) {
      case 'on-track':
        return t('settings.usage.pace.status.onTrack');
      case 'slightly-fast':
        return t('settings.usage.pace.status.slightlyFast');
      case 'too-fast':
        return t('settings.usage.pace.status.tooFast');
      case 'exhausted':
        return t('settings.usage.pace.status.usedUp');
      }
  }, [paceInfo.status, t]);

  const predictionTooltip = t('settings.usage.pace.predictionTooltip', { prediction: paceInfo.predictText });

  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      <div className="flex items-center gap-1.5">
        {!paceInfo.isExhausted && (
          <span className="typography-micro text-muted-foreground">
            {t('settings.usage.pace.rate', { rate: paceInfo.paceRateText })}
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
              <span className="text-muted-foreground">{t('settings.usage.pace.waitSeparator')}</span>
              <span className="font-medium">{formatRemainingTime(paceInfo.remainingSeconds)}</span>
            </>
          ) : (
            <span title={predictionTooltip}>
              <span className="text-muted-foreground">{t('settings.usage.pace.predictionLabel')}</span>
              <span className="font-medium">{paceInfo.predictText}</span>
            </span>
          )}
        </span>
        <div
          className="h-2 w-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: statusColor }}
          role="img"
          aria-label={statusLabel}
          title={statusLabel}
        />
      </div>
    </div>
  );
};
