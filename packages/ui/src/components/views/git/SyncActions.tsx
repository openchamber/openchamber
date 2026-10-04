import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from "@/components/icon/Icon";
import type { GitRemote } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type SyncAction = 'fetch' | 'pull' | 'sync' | 'publish' | null;

interface SyncActionsProps {
  syncAction: SyncAction;
  remotes: GitRemote[];
  onFetch: (remote: GitRemote) => void;
  onPull: (remote: GitRemote) => void;
  onSync: (remote: GitRemote) => void;
  onPublish: () => void;
  onChooseSyncTargets: () => void;
  currentBranch?: string;
  hasTracking?: boolean;
  onRemoveRemote?: (remote: GitRemote) => void;
  disabled: boolean;
  removingRemoteName?: string | null;
  iconOnly?: boolean;
  aheadCount?: number;
  behindCount?: number;
  trackingRemoteName?: string;
  trackingBranch?: string | null;
  /** Changes to tracked files; untracked files do not block a rebase. */
  hasUncommittedChanges?: boolean;
}

export const SyncActions: React.FC<SyncActionsProps> = ({
  syncAction,
  remotes = [],
  onFetch,
  onPull,
  onSync,
  onPublish,
  onChooseSyncTargets,
  currentBranch,
  hasTracking = false,
  onRemoveRemote,
  disabled,
  removingRemoteName = null,
  aheadCount = 0,
  behindCount = 0,
  trackingRemoteName,
  hasUncommittedChanges = false,
}) => {
  const { t } = useI18n();
  const skipRemoteSelectRef = React.useRef(false);
  const isRemovingRemote = Boolean(removingRemoteName);
  const trackingRemote = trackingRemoteName
    ? remotes.find((remote) => remote.name === trackingRemoteName)
    : undefined;
  const blocksRebaseSync = behindCount > 0 && hasUncommittedChanges;
  const detached = !currentBranch || currentBranch === 'HEAD';
  const publish = !hasTracking;
  const isPrimaryDisabled = disabled || syncAction !== null || isRemovingRemote || detached || (!publish && blocksRebaseSync);
  const isDropdownDisabled = disabled || syncAction !== null || isRemovingRemote || remotes.length === 0;
  const isPullDisabled = !trackingRemote || hasUncommittedChanges;
  // A tracked branch with nothing ahead has nothing to push; the same count
  // the sync button shows. A branch without upstream can always be published.
  const isPushDisabled = detached || (hasTracking && aheadCount === 0);
  const hasKnownSyncWork = aheadCount > 0 || behindCount > 0;
  const primaryLabel = [
    t(publish ? 'gitView.publish.title' : 'gitView.sync.sync'),
    behindCount > 0 ? `↓${behindCount}` : null,
    aheadCount > 0 ? `↑${aheadCount}` : null,
  ].filter(Boolean).join(' ');
  const tooltipLabel = detached ? t('gitView.publish.detached') : publish ? t('gitView.publish.title') : blocksRebaseSync
    ? t('gitView.sync.commitOrStashTooltip')
    : trackingRemote
    ? hasKnownSyncWork
      ? t('gitView.sync.syncChangesTooltip', { ahead: aheadCount, behind: behindCount })
      : t('gitView.sync.syncChanges')
    : t('gitView.sync.noRemoteTooltip');

  const handleSync = () => {
    if (publish) { onPublish(); return; }
    if (!trackingRemote) {
      onChooseSyncTargets();
      return;
    }
    onSync(trackingRemote);
  };

  return (
    <div className="inline-flex items-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] border border-border/60 bg-[var(--surface-elevated)] overflow-hidden">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={blocksRebaseSync || detached ? 0 : undefined}>
            {/* The two halves are plain buttons inside one rounded frame: the
                shared Button brings its own squircle corners, which made each
                half read as a separate round button. */}
            <button
              type="button"
              onClick={handleSync}
              disabled={isPrimaryDisabled}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 px-2 typography-ui-label font-medium text-foreground',
                'transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
              )}
              aria-label={t(publish ? 'gitView.publish.title' : 'gitView.sync.syncChanges')}
            >
              {syncAction === 'sync' || syncAction === 'publish' ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : (
                <Icon name="refresh" className="size-4" />
              )}
              <span className="whitespace-nowrap tabular-nums">{primaryLabel}</span>
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>{tooltipLabel}</TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex h-7 w-6 items-center justify-center border-l border-[var(--interactive-border)] text-muted-foreground',
              'transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
            )}
            disabled={isDropdownDisabled}
            aria-label={t('gitView.sync.moreActionsAria')}
          >
            <Icon name="arrow-down-s" className="size-4" />
          </button>
        </DropdownMenuTrigger>
        {/* Anchored to the trailing edge so the menu stays inside the pane instead of running past it. */}
        <DropdownMenuContent align="end" className="w-[min(360px,calc(100vw-2rem))] max-h-[320px] overflow-y-auto">
          <DropdownMenuItem disabled={isPushDisabled} onSelect={onPublish}>
            <Icon name="arrow-up" className="size-4 text-muted-foreground" />
            {/* A branch with an upstream is pushed there; only a new one is published. */}
            {t(hasTracking ? 'gitView.sync.push' : 'gitView.publish.title')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isPullDisabled}
            onSelect={() => {
              if (trackingRemote) onPull(trackingRemote);
            }}
          >
            <Icon name="arrow-down" className="size-4 text-muted-foreground" />
            {t('gitView.sync.pullRebase')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {remotes.map((remote) => (
            <DropdownMenuItem
              key={remote.name}
              onSelect={(event) => {
                if (skipRemoteSelectRef.current) {
                  event.preventDefault();
                  skipRemoteSelectRef.current = false;
                  return;
                }
                onFetch(remote);
              }}
            >
              <div className="flex w-full items-center gap-2">
                <Icon name="download" className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-col">
                    <span className="typography-ui-label text-foreground">
                      {t('gitView.sync.fetchFromRemote', { name: remote.name })}
                    </span>
                    <span className="typography-meta text-muted-foreground truncate">
                      {remote.fetchUrl}
                    </span>
                  </div>
                </div>
                {onRemoveRemote && remote.name !== trackingRemoteName ? (
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
                      <Icon name="loader-4" className="size-3.5 animate-spin" />
                    ) : (
                      <Icon name="close" className="size-3.5" />
                    )}
                  </Button>
                ) : null}
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
