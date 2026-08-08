import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ConnectionPhase = 'connecting' | 'connected' | 'reconnecting';

const dotClassByPhase: Record<ConnectionPhase, string> = {
  connected: 'bg-[var(--status-success)]',
  connecting: 'bg-muted-foreground/40',
  reconnecting: 'bg-[var(--status-warning)] animate-pulse',
};

/**
 * Persistent, subtle connection status indicator for the header. Driven
 * entirely by the existing connection state in `useConfigStore` (written by
 * the event-stream pipeline and the health checks) — no polling of its own.
 *
 * - connected: steady green dot
 * - connecting: muted dot (initial connect, never connected yet)
 * - reconnecting: pulsing amber dot (was connected, transport dropped; the
 *   event pipeline retries automatically, and clicking probes the server
 *   again through the existing health signal)
 */
export const ConnectionStatusIndicator: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const isConnected = useConfigStore((state) => state.isConnected);
  const probeConnection = useConfigStore((state) => state.probeConnection);

  const phase: ConnectionPhase = isConnected ? 'connected' : connectionPhase;
  const label = phase === 'connected'
    ? t('header.connection.status.connected')
    : phase === 'reconnecting'
      ? t('header.connection.status.reconnecting')
      : t('header.connection.status.connecting');
  const canRetry = phase !== 'connected';
  const title = canRetry ? `${label} · ${t('header.connection.actions.retry')}` : label;

  const dot = (
    <span
      aria-hidden="true"
      className={cn('h-2 w-2 shrink-0 rounded-full', dotClassByPhase[phase])}
    />
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {canRetry ? (
          <button
            type="button"
            aria-label={title}
            className={cn(
              'app-region-no-drag inline-flex h-8 w-8 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-interactive-hover transition-colors',
              className,
            )}
            onClick={() => {
              void probeConnection();
            }}
          >
            {dot}
          </button>
        ) : (
          <span
            aria-label={label}
            role="status"
            className={cn(
              'app-region-no-drag inline-flex h-8 w-8 items-center justify-center rounded-md',
              className,
            )}
          >
            {dot}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent>
        <p>{title}</p>
      </TooltipContent>
    </Tooltip>
  );
};
