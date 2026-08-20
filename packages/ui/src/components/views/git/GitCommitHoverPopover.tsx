/* eslint-disable react-refresh/only-export-components */

import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { openExternalUrl } from '@/lib/url';
import type { GitCommitHoverDetailsCache } from '@/lib/api/types';
import type { GitCommitHoverModel } from './gitCommitHoverModel';
import { buildGitHubCommitUrl } from './gitCommitRemote';

const HOVER_PRELOAD_DELAY_MS = 75;
const HOVER_OPEN_DELAY_MS = 300;
const HOVER_CLOSE_DELAY_MS = 150;
const IDLE_DETAILS_SNAPSHOT = { status: 'idle' } as const;

export type GitCommitHoverPopoverCoordinator = {
  claim: (ownerHash: string, actionsRef: React.RefObject<Popover.Root.Actions | null>) => void;
  release: (ownerHash: string) => void;
};

const createGitCommitHoverPopoverCoordinator = (): GitCommitHoverPopoverCoordinator => {
  let activeOwnerHash: string | null = null;
  let activeActionsRef: React.RefObject<Popover.Root.Actions | null> | null = null;

  return {
    claim(ownerHash, actionsRef) {
      if (activeOwnerHash && activeOwnerHash !== ownerHash) {
        activeActionsRef?.current?.close();
      }
      activeOwnerHash = ownerHash;
      activeActionsRef = actionsRef;
    },
    release(ownerHash) {
      if (activeOwnerHash !== ownerHash) {
        return;
      }
      activeOwnerHash = null;
      activeActionsRef = null;
    },
  };
};

type GitCommitHoverPopoverProps = {
  model: GitCommitHoverModel;
  directory: string;
  remoteName: string | null;
  remoteUrl: string | null;
  detailsCache: GitCommitHoverDetailsCache | null;
  coordinator: GitCommitHoverPopoverCoordinator;
  onCopyHash: (hash: string) => void;
  absoluteTimestamp: string;
  rowButton: React.ReactElement;
  openGitHubLabel: string;
  copyShaLabel: string;
  changedFilesLabel: string;
};

const getAuthorInitials = (value: string): string => {
  const parts = value.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) {
    return '?';
  }
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('');
};

const GitCommitHoverPopoverComponent: React.FC<GitCommitHoverPopoverProps> = ({
  model,
  directory,
  remoteName,
  remoteUrl,
  detailsCache,
  coordinator,
  onCopyHash,
  absoluteTimestamp,
  rowButton,
  openGitHubLabel,
  copyShaLabel,
  changedFilesLabel,
}) => {
  const actionsRef = React.useRef<Popover.Root.Actions | null>(null);
  const preloadTimeoutRef = React.useRef<number | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);

  const detailsKey = React.useMemo(() => ({
    directory,
    remoteName,
    hash: model.hash,
  }), [directory, model.hash, remoteName]);

  const cancelPendingPreload = React.useCallback(() => {
    if (preloadTimeoutRef.current !== null) {
      window.clearTimeout(preloadTimeoutRef.current);
      preloadTimeoutRef.current = null;
    }
  }, []);

  const startPreload = React.useCallback(() => {
    if (!detailsCache) {
      return;
    }
    cancelPendingPreload();
    preloadTimeoutRef.current = window.setTimeout(() => {
      preloadTimeoutRef.current = null;
      void detailsCache.preload(detailsKey);
    }, HOVER_PRELOAD_DELAY_MS);
  }, [cancelPendingPreload, detailsCache, detailsKey]);

  React.useEffect(() => () => {
    cancelPendingPreload();
    coordinator.release(model.hash);
  }, [cancelPendingPreload, coordinator, model.hash]);

  const subscribe = React.useCallback((listener: () => void) => {
    if (!isOpen || !detailsCache) {
      return () => {};
    }
    return detailsCache.subscribe(detailsKey, listener);
  }, [detailsCache, detailsKey, isOpen]);

  const getSnapshot = React.useCallback(() => {
    if (!isOpen || !detailsCache) {
      return IDLE_DETAILS_SNAPSHOT;
    }
    return detailsCache.getSnapshot(detailsKey);
  }, [detailsCache, detailsKey, isOpen]);

  const detailsSnapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const githubUrl = React.useMemo(() => {
    if (detailsSnapshot.status === 'ready' && detailsSnapshot.details.connected) {
      return detailsSnapshot.details.url?.trim() || buildGitHubCommitUrl(remoteUrl, model.hash);
    }
    return buildGitHubCommitUrl(remoteUrl, model.hash);
  }, [detailsSnapshot, model.hash, remoteUrl]);

  const githubAuthor = detailsSnapshot.status === 'ready' ? detailsSnapshot.details.author ?? null : null;
  const authorName = githubAuthor?.name?.trim() || model.authorName;
  const authorSecondary = githubAuthor?.login?.trim() || model.authorEmail;
  const authorInitials = getAuthorInitials(authorName);

  const handleOpenChange = React.useCallback((nextOpen: boolean, eventDetails: { reason: string }) => {
    if (eventDetails.reason === 'triggerPress') {
      return;
    }

    if (nextOpen) {
      coordinator.claim(model.hash, actionsRef);
      void detailsCache?.preload(detailsKey);
    } else {
      coordinator.release(model.hash);
      cancelPendingPreload();
    }

    setIsOpen(nextOpen);
  }, [cancelPendingPreload, coordinator, detailsCache, detailsKey, model.hash]);

  return (
    <Popover.Root open={isOpen} actionsRef={actionsRef} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        render={rowButton}
        payload={{ hash: model.hash }}
        openOnHover
        delay={HOVER_OPEN_DELAY_MS}
        closeDelay={HOVER_CLOSE_DELAY_MS}
        onPointerEnter={startPreload}
        onPointerLeave={cancelPendingPreload}
      />
      <Popover.Portal>
        <Popover.Positioner side="right" align="start" sideOffset={8} collisionPadding={8}>
          <Popover.Popup
            initialFocus={false}
            data-git-commit-hover={model.hash}
            className="w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-3 text-left shadow-lg transition-[opacity,transform] duration-150 ease-out data-[starting-style]:translate-x-1 data-[starting-style]:opacity-0 data-[ending-style]:translate-x-1 data-[ending-style]:opacity-0"
          >
            <div className="flex items-start gap-3">
              {githubAuthor?.avatarUrl ? (
                <img
                  src={githubAuthor.avatarUrl}
                  alt={authorName}
                  className="size-10 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-interactive-selection text-interactive-selection-foreground typography-ui-label font-semibold">
                  {authorInitials}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p data-git-commit-hover-subject={model.hash} className="typography-ui-label font-semibold text-foreground">{model.subject}</p>
                    {model.body ? (
                      <p className="mt-1 whitespace-pre-wrap break-words typography-meta text-muted-foreground">{model.body}</p>
                    ) : null}
                  </div>
                  <code className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono typography-micro text-muted-foreground">
                    {model.shortHash}
                  </code>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
                  <span data-git-commit-hover-author={model.hash} className="truncate text-foreground" title={authorName}>{authorName}</span>
                  <span className="shrink-0">·</span>
                  <span className="truncate" title={authorSecondary}>{authorSecondary}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
                  <span>{model.relativeTime}</span>
                  <span className="shrink-0">·</span>
                  <span title={absoluteTimestamp}>{absoluteTimestamp}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
                  <span>{changedFilesLabel}</span>
                  <span className="shrink-0">·</span>
                  <span className="text-[var(--status-success)]">+{model.statistics.insertions}</span>
                  <span className="text-[var(--status-error)]">-{model.statistics.deletions}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {githubUrl ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => { void openExternalUrl(githubUrl); }}
                    >
                      <Icon name="external-link" className="size-3" />
                      {openGitHubLabel}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onCopyHash(model.hash)}
                  >
                    <Icon name="file-copy" className="size-3" />
                    {copyShaLabel}
                  </Button>
                </div>
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

export const GitCommitHoverPopover = Object.assign(GitCommitHoverPopoverComponent, {
  createCoordinator: createGitCommitHoverPopoverCoordinator,
});
