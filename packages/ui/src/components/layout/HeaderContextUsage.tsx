import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { resolveUsageTone } from '@/lib/quota';
import { cn } from '@/lib/utils';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { shownContextModes } from '@/lib/workspace/zones';
import { ContextRailTooltipDetails, ContextRing } from './ContextRailUsage';
import { useCurrentContextReading } from './useCurrentContextReading';

const UNKNOWN_PERCENT = '—';

const TONE_COLOR = {
  safe: 'var(--muted-foreground)',
  warn: 'var(--status-warning)',
  critical: 'var(--status-error)',
} as const;

const HeaderContextUsageComponent: React.FC<{ buttonClassName: string }> = ({ buttonClassName }) => {
  const { t } = useI18n();
  const { sessionId, fill, limit } = useCurrentContextReading();
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';
  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const contextShown = useUIStore((state) => directoryKey !== ''
    && shownContextModes(state.contextPanelByDirectory[directoryKey], state.contextSurfaceZones).has('context'));
  const cardShowsContext = useUIStore((state) => state.workStatusPanelVisible
    && !state.workStatusHiddenSections.includes('session'));

  if (!sessionId || !fill || cardShowsContext) {
    return null;
  }

  const percent = fill.state === 'measured' ? (fill.totalTokens / limit) * 100 : null;
  const arcColor = percent === null ? undefined : TONE_COLOR[resolveUsageTone(Math.round(percent))];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={directoryKey ? () => openContextSurface(directoryKey, 'context') : undefined}
          aria-label={t('contextUsage.aria.label')}
          aria-pressed={contextShown}
          className={cn(buttonClassName, 'w-auto gap-1.5 px-1 tabular-nums', contextShown && 'text-foreground')}
        >
          <ContextRing percent={percent ?? 0} arcColor={arcColor} className="size-4" />
          <span dir="ltr" className="typography-meta">
            {percent === null ? UNKNOWN_PERCENT : `${Math.min(percent, 999).toFixed(1)}%`}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="flex flex-col gap-0.5">
          {contextShown ? null : <span>{t('chat.workStatus.action.openContext')}</span>}
          <ContextRailTooltipDetails />
        </div>
      </TooltipContent>
    </Tooltip>
  );
};

export const HeaderContextUsage = React.memo(HeaderContextUsageComponent);
