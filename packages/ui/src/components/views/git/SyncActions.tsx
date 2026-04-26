import React from 'react';
import {
  RiRefreshLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiCloseLine,
  RiLoader4Line,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { GitRemote } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';

type SyncAction = 'fetch' | 'pull' | 'push' | null;

interface SyncActionsProps {
  syncAction: SyncAction;
  remotes: GitRemote[];
  onFetch: (remote: GitRemote) => void;
  onPull: (remote: GitRemote) => void;
  onPush: () => void;
  onRemoveRemote?: (remote: GitRemote) => void;
  disabled: boolean;
  removingRemoteName?: string | null;
  iconOnly?: boolean;
  tooltipDelayMs?: number;
  aheadCount?: number;
  behindCount?: number;
}

export const SyncActions: React.FC<SyncActionsProps> = ({
  syncAction,
  remotes = [],
  onFetch,
  onPull,
  onPush,
  onRemoveRemote,
  disabled,
  removingRemoteName = null,
  iconOnly = false,
  tooltipDelayMs = 1000,
  aheadCount = 0,
  behindCount = 0,
}) => {
  const { t } = useI18n();
  const skipRemoteSelectRef = React.useRef(false);
  const hasNoRemotes = remotes.length === 0;
  const isRemovingRemote = Boolean(removingRemoteName);
  const isDisabled = disabled || syncAction !== null || isRemovingRemote || hasNoRemotes;
  const hasMultipleRemotes = remotes.length > 1;

  const handleFetch = () => {
    const remote = remotes[0];
    if (remotes.length === 1 && remote) {
      onFetch(remote);
    }
  };

  const handlePull = () => {
    const remote = remotes[0];
    if (remotes.length === 1 && remote) {
      onPull(remote);
    }
  };

  const handlePush = () => {
    if (remotes.length >= 1) {
      onPush();
    }
  };

  const renderButton = (
    action: SyncAction,
    icon: React.ReactNode,
    loadingIcon: React.ReactNode,
    label: string,
    onClick: () => void,
    tooltipText: string,
    counter?: number
  ) => {
    const button = (
      <Button
        variant="ghost"
        size="sm"
        className={iconOnly ? 'relative h-8 w-8 px-0' : 'h-8 px-2'}
        onClick={onClick}
        disabled={isDisabled}
      >
        {syncAction === action ? loadingIcon : icon}
        {!iconOnly && <span className="git-header-label">{label}</span>}
        {!iconOnly && typeof counter === 'number' && counter > 0 ? (
          <span className="rounded-sm bg-interactive-selection/40 px-1 text-[10px] leading-4 text-foreground tabular-nums">
            {counter}
          </span>
        ) : null}
        {iconOnly && typeof counter === 'number' && counter > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-[1rem] rounded-full bg-interactive-selection px-1 text-[10px] leading-4 text-interactive-selection-foreground tabular-nums">
            {counter}
          </span>
        ) : null}
      </Button>
    );

    return (
      <Tooltip delayDuration={tooltipDelayMs}>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent sideOffset={8}>{tooltipText}</TooltipContent>
      </Tooltip>
    );
  };

  const renderDropdownButton = (
    action: SyncAction,
    icon: React.ReactNode,
    loadingIcon: React.ReactNode,
    label: string,
    onSelect: (remote: GitRemote) => void,
    tooltipText: string,
    counter?: number
  ) => {
    return (
      <DropdownMenu>
        <Tooltip delayDuration={tooltipDelayMs}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={iconOnly ? 'relative h-8 w-8 px-0' : 'h-8 px-2'}
                disabled={isDisabled}
              >
                {syncAction === action ? loadingIcon : icon}
                {!iconOnly && <span className="git-header-label">{label}</span>}
                {!iconOnly && typeof counter === 'number' && counter > 0 ? (
                  <span className="rounded-sm bg-interactive-selection/40 px-1 text-[10px] leading-4 text-foreground tabular-nums">
                    {counter}
                  </span>
                ) : null}
                {iconOnly && typeof counter === 'number' && counter > 0 ? (
                  <span className="absolute -right-1 -top-1 min-w-[1rem] rounded-full bg-interactive-selection px-1 text-[10px] leading-4 text-interactive-selection-foreground tabular-nums">
                    {counter}
                  </span>
                ) : null}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent sideOffset={8}>{tooltipText}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="min-w-[200px]">
          {remotes.map((remote) => (
            <DropdownMenuItem
              key={remote.name}
              onSelect={(event) => {
                if (skipRemoteSelectRef.current) {
                  event.preventDefault();
                  skipRemoteSelectRef.current = false;
                  return;
                }
                onSelect(remote);
              }}
            >
              <div className="flex w-full items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-col">
                    <span className="typography-ui-label text-foreground">
                      {remote.name}
                    </span>
                    <span className="typography-meta text-muted-foreground truncate">
                      {remote.fetchUrl}
                    </span>
                  </div>
                </div>
                {onRemoveRemote ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="xs"
                    className="h-6 w-6 px-0"
                    disabled={syncAction !== null || isRemovingRemote}
                    onPointerDown={(event) => {
                      skipRemoteSelectRef.current = true;
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      skipRemoteSelectRef.current = true;
                      event.preventDefault();
                      event.stopPropagation();
                      onRemoveRemote(remote);
                    }}
                    aria-label={t('gitView.header.removeRemoteAria', { name: remote.name })}
                    title={t('gitView.header.removeRemoteTitle', { name: remote.name })}
                  >
                    {removingRemoteName === remote.name ? (
                      <RiLoader4Line className="size-3.5 animate-spin" />
                    ) : (
                      <RiCloseLine className="size-3.5" />
                    )}
                  </Button>
                ) : null}
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <div className="flex items-center gap-0.5">
      {hasMultipleRemotes
        ? renderDropdownButton(
            'fetch',
            <RiRefreshLine className="size-4" />,
            <RiLoader4Line className="size-4 animate-spin" />,
            t('gitView.sync.fetch'),
            onFetch,
            t('gitView.sync.fetchTooltip')
          )
        : renderButton(
            'fetch',
            <RiRefreshLine className="size-4" />,
            <RiLoader4Line className="size-4 animate-spin" />,
            t('gitView.sync.fetch'),
            handleFetch,
            t('gitView.sync.fetchTooltip')
          )}

      {hasMultipleRemotes
        ? renderDropdownButton(
            'pull',
            <RiArrowDownLine className="size-4" />,
            <RiLoader4Line className="size-4 animate-spin" />,
            t('gitView.sync.pull'),
            onPull,
            behindCount > 0
              ? t('gitView.sync.pullTooltipBehind', { count: behindCount })
              : t('gitView.sync.pullTooltip'),
            behindCount
          )
        : renderButton(
            'pull',
            <RiArrowDownLine className="size-4" />,
            <RiLoader4Line className="size-4 animate-spin" />,
            t('gitView.sync.pull'),
            handlePull,
            behindCount > 0
              ? t('gitView.sync.pullTooltipBehind', { count: behindCount })
              : t('gitView.sync.pullTooltip'),
            behindCount
          )}

      {renderButton(
        'push',
        <RiArrowUpLine className="size-4" />,
        <RiLoader4Line className="size-4 animate-spin" />,
        t('gitView.sync.push'),
        handlePush,
        aheadCount > 0
          ? t('gitView.sync.pushTooltipAhead', { count: aheadCount })
          : t('gitView.sync.pushTooltip'),
        aheadCount
      )}
    </div>
  );
};
