import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { HostConnectionSummary, HostTransport } from '@/multi-host';
import { cn } from '@/lib/utils';
import {
  connectionStateLabel,
  transportIconName,
  transportKindLabel,
} from './multi-host-sidebar-types';

type HostConnectionIndicatorProps = {
  connection: HostConnectionSummary;
  transport: HostTransport;
  className?: string;
};

function connectionStateColor(state: HostConnectionSummary['state']): string {
  switch (state) {
    case 'connected':
      return 'text-[var(--status-success)]';
    case 'connecting':
      return 'text-[var(--status-info)]';
    case 'error':
      return 'text-[var(--status-error)]';
    case 'disconnected':
      return 'text-muted-foreground';
  }
}

function connectionStateIcon(state: HostConnectionSummary['state']): string {
  switch (state) {
    case 'connected':
      return 'checkbox-circle';
    case 'connecting':
      return 'loader-4';
    case 'error':
      return 'error-warning';
    case 'disconnected':
      return 'close-circle';
  }
}

export const HostConnectionIndicator = React.memo(
  function HostConnectionIndicator({
    connection,
    transport,
    className,
  }: HostConnectionIndicatorProps) {
    const kindLabel = transportKindLabel(transport);
    const stateLabel = connectionStateLabel(connection.state);
    const ariaLabel = `${kindLabel} · ${stateLabel}${connection.error ? `: ${connection.error}` : ''}`;

    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[0.65rem] typography-meta',
          connectionStateColor(connection.state),
          className,
        )}
        aria-label={ariaLabel}
      >
        <Icon
          name={connectionStateIcon(connection.state) as never}
          className={cn(
            'h-3 w-3',
            connection.state === 'connecting' && 'animate-spin',
          )}
        />
        <span>{stateLabel}</span>
        <span className="text-muted-foreground">·</span>
        <Icon
          name={transportIconName(transport) as never}
          className="h-3 w-3"
        />
        <span>{kindLabel}</span>
      </span>
    );
  },
);
