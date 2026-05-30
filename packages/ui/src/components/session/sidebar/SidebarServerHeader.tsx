import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export interface SidebarServerHeaderProps {
  serverId: string;
  label: string;
  type: 'local' | 'ssh' | 'remote-url';
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  isCollapsed: boolean;
  isActive: boolean;
  hidden?: boolean;
  errorMessage?: string;
  onToggleCollapse: () => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export const SidebarServerHeader: React.FC<SidebarServerHeaderProps> = ({
  label,
  type,
  status,
  isCollapsed,
  isActive,
  hidden,
  errorMessage,
  onToggleCollapse,
  onConnect,
  onDisconnect,
}) => {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'w-full text-left group/server select-none',
        hidden && 'hidden',
      )}
    >
      <div className="relative flex items-center gap-1 px-0.5 py-0.5">
        <button
          type="button"
          onClick={onToggleCollapse}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          )}
        >
          <span className="h-3.5 w-3.5 flex-shrink-0 flex items-center justify-center text-muted-foreground">
            <span className={cn(
              'h-3.5 w-3.5 items-center justify-center',
              'hidden group-hover/server:inline-flex group-focus-within/server:inline-flex',
            )}>
              {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
            </span>
            <span className={cn(
              'h-3.5 w-3.5 items-center justify-center',
              'inline-flex group-hover/server:hidden group-focus-within/server:hidden',
            )}>
            <span className={cn(
              'h-2 w-2 rounded-full',
              status === 'connected' && 'bg-status-success',
              status === 'connecting' && 'bg-status-warning animate-pulse',
              status === 'disconnected' && 'bg-muted-foreground/40',
              status === 'error' && 'bg-status-error',
            )}               title={status === 'error' ? errorMessage || t('server.sidebar.status.connectionError') : status === 'disconnected' ? t('server.sidebar.status.disconnected') : undefined} />
            </span>
          </span>

          <span className={cn(
            'text-[14px] font-normal truncate',
            isActive ? 'text-foreground' : 'text-muted-foreground',
          )}>
            {label}
          </span>
        </button>

        {type !== 'local' && status === 'connected' && onDisconnect && (
          <button
            onClick={onDisconnect}
            className={cn(
              'absolute right-0.5 top-1/2 z-10 -translate-y-1/2',
              'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-opacity',
              'opacity-0 pointer-events-none group-hover/server:opacity-100 group-hover/server:pointer-events-auto group-focus-within/server:opacity-100 group-focus-within/server:pointer-events-auto',
            )}
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        )}

        {type !== 'local' && status !== 'connected' && status !== 'connecting' && onConnect && (
          <button
            onClick={onConnect}
            className={cn(
              'absolute right-0.5 top-1/2 z-10 -translate-y-1/2',
              'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-opacity opacity-100',
            )}
          >
            <Icon name="plug-2" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};
