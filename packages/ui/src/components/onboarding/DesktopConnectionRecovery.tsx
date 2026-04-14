import React from 'react';
import { RiRefreshLine, RiServerLine, RiMacbookLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { redactSensitiveUrl } from '@/lib/desktopHosts';
import {
  getDesktopRecoveryConfig,
  type RecoveryVariant,
} from './desktopRecoveryConfig';

export type { RecoveryVariant } from './desktopRecoveryConfig';

export type DesktopConnectionRecoveryProps = {
  variant: RecoveryVariant;
  hostLabel?: string;
  hostUrl?: string;
  onRetry?: () => void;
  onUseLocal?: () => void;
  onUseRemote?: () => void;
  isRetrying?: boolean;
};

/** Maps iconKey from config to actual icon component */
function getRecoveryIcon(iconKey: 'local' | 'remote'): React.ReactNode {
  switch (iconKey) {
    case 'local':
      return <RiMacbookLine className="h-8 w-8" />;
    case 'remote':
      return <RiServerLine className="h-8 w-8" />;
  }
}

export function DesktopConnectionRecovery({
  variant,
  hostLabel,
  hostUrl,
  onRetry,
  onUseLocal,
  onUseRemote,
  isRetrying = false,
}: DesktopConnectionRecoveryProps) {
  const config = getDesktopRecoveryConfig(variant, hostLabel, hostUrl);

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="w-full max-w-md space-y-6">
        {/* Icon and title */}
        <div className="flex flex-col items-center space-y-3 text-center">
          <div
            className="p-3 rounded-full"
            style={{
              backgroundColor: 'var(--status-warning)',
              opacity: 0.15,
            }}
          >
            <div style={{ color: 'var(--status-warning)' }}>
              {getRecoveryIcon(config.iconKey)}
            </div>
          </div>
          <h1 className="typography-ui-header text-xl font-semibold text-foreground">
            {config.title}
          </h1>
          <p className="text-muted-foreground text-sm max-w-sm">
            {config.description}
          </p>
        </div>

        {/* Host info if available */}
        {hostUrl && (variant === 'remote-unreachable' || variant === 'remote-wrong-service') && (
          <div className="rounded-lg border border-border bg-background/50 p-3">
            <div className="text-xs text-muted-foreground mb-1">Server Address</div>
            <div className="font-mono text-sm text-foreground truncate">{redactSensitiveUrl(hostUrl)}</div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-col gap-2">
          {config.showRetry && onRetry && (
            <Button
              onClick={onRetry}
              disabled={isRetrying}
              className="w-full"
            >
              <RiRefreshLine className={cn('h-4 w-4', isRetrying && 'animate-spin')} />
              {isRetrying ? 'Retrying…' : (config.retryLabel ?? 'Retry Connection')}
            </Button>
          )}

          <div className="flex gap-2">
            {config.showUseLocal && onUseLocal && (
              <Button
                variant="outline"
                onClick={onUseLocal}
                disabled={isRetrying}
                className="flex-1"
              >
                <RiMacbookLine className="h-4 w-4" />
                {config.useLocalLabel}
              </Button>
            )}

            {config.showUseRemote && onUseRemote && (
              <Button
                variant="outline"
                onClick={onUseRemote}
                disabled={isRetrying}
                className="flex-1"
              >
                <RiServerLine className="h-4 w-4" />
                {config.useRemoteLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
