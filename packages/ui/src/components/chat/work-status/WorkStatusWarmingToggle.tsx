import React from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { cn } from '@/lib/utils';
import { useSessionWarmingStore, useSessionWarmUntil } from '@/stores/useSessionWarmingStore';
import { useSession } from '@/sync/sync-context';

/** "59:07": minutes and seconds left, the same in every language. */
const formatRemaining = (ms: number): string => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Mounted only while the tooltip is open, so the countdown ticks only while someone reads it. */
const WarmingState: React.FC<{ warmUntil: number | null | undefined }> = ({ warmUntil }) => {
  const { t } = useI18n();
  const now = useDurationTickerNow(warmUntil !== undefined && warmUntil !== null);
  if (warmUntil === undefined) return <>{t('chat.workStatus.warming.off')}</>;
  if (warmUntil === null) return <>{t('chat.workStatus.warming.waiting')}</>;
  if (warmUntil <= now) return <>{t('chat.workStatus.warming.expired')}</>;
  return <>{t('chat.workStatus.warming.remaining', { time: formatRemaining(warmUntil - now) })}</>;
};

/**
 * Turns per-session warming on and off from the Context row. Shown only while
 * Settings chose per-session warming, for a root session the host's OpenCode
 * runs; the tooltip says whether it is warm and for how long.
 */
export const WorkStatusWarmingToggle: React.FC<{ sessionId: string | null; directory: string | null }> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const enabled = useSessionWarmingStore((state) => state.enabled);
  const warmUntil = useSessionWarmUntil(sessionId);
  const session = useSession(sessionId ?? '', directory ?? undefined);
  const [open, setOpen] = React.useState(false);

  if (!enabled || !sessionId || !directory || isSpaceDirectory(directory) || session?.parentID) return null;
  const warmed = warmUntil !== undefined;

  const toggle = () => {
    void useSessionWarmingStore.getState().setSessionWarm(sessionId, directory, !warmed).catch(() => {
      toast.error(t('sessions.warming.toggleFailed'));
    });
  };

  return (
    <Tooltip delayDuration={300} open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={warmed}
          aria-label={warmed ? t('chat.workStatus.warming.turnOff') : t('chat.workStatus.warming.turnOn')}
          onClick={(event) => {
            // The row underneath opens the context overview.
            event.stopPropagation();
            toggle();
          }}
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]',
            warmed ? 'text-[var(--primary-text)]' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon name={warmed ? 'fire-fill' : 'fire'} className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-[min(280px,calc(100vw-24px))] whitespace-normal break-words text-start">
        {open ? <WarmingState warmUntil={warmUntil} /> : null}
      </TooltipContent>
    </Tooltip>
  );
};
