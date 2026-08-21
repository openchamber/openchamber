/* eslint-disable react-refresh/only-export-components */

import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import type { GitCommitHoverDetailsCache } from '@/lib/api/types';
import type { GitHistoryGraphRef } from './gitGraph';
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
  references?: readonly GitHistoryGraphRef[];
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
  references,
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
            className="w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-3 text-left shadow-lg transition-[opacity,transform] duration-150 ease-out data-[starting-style]:translate-x-1 data-[starting-style]:opacity-0 data-[ending-style]:translate-x-1 data-[ending-style]:opacity-0"
          >
            {/* Line 1: Author, relative time, absolute time */}
            <div className="flex items-center gap-1.5 typography-meta text-muted-foreground min-w-0 flex-wrap">
              {githubAuthor?.avatarUrl ? (
                <img
                  src={githubAuthor.avatarUrl}
                  alt={authorName}
                  className="size-5 shrink-0 rounded object-cover"
                />
              ) : (
                <div className="flex size-5 shrink-0 items-center justify-center rounded bg-interactive-selection text-interactive-selection-foreground typography-micro font-semibold">
                  {authorInitials}
                </div>
              )}
              <span
                data-git-commit-hover-author={model.hash}
                className="truncate font-semibold text-sky-400"
                title={authorSecondary ? `${authorName} (${authorSecondary})` : authorName}
              >
                {authorName},
              </span>
              <Icon name="history" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate" title={absoluteTimestamp}>
                {model.relativeTime} ({absoluteTimestamp})
              </span>
            </div>

            {/* Line 2: Subject and Body */}
            <div className="mt-1.5 min-w-0">
              <p data-git-commit-hover-subject={model.hash} className="typography-ui-label font-medium text-foreground break-words">
                {model.subject}
              </p>
              {model.body ? (
                <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words typography-meta text-muted-foreground">
                  {model.body}
                </p>
              ) : null}
            </div>

            {/* Line 3: Changed files and diff stats */}
            <div className="mt-1.5 flex flex-wrap items-center typography-meta text-muted-foreground">
              <span>
                {changedFilesLabel}
                {model.statistics.insertions > 0 || model.statistics.deletions > 0 ? ', ' : ''}
              </span>
              {model.statistics.insertions > 0 ? (
                <span className="text-[var(--status-success)]">
                  {model.statistics.insertions} {model.statistics.insertions === 1 ? 'insertion(+)' : 'insertions(+)'}
                </span>
              ) : null}
              {model.statistics.insertions > 0 && model.statistics.deletions > 0 ? (
                <span>,&nbsp;</span>
              ) : null}
              {model.statistics.deletions > 0 ? (
                <span className="text-[var(--status-error)]">
                  {model.statistics.deletions} {model.statistics.deletions === 1 ? 'deletion(-)' : 'deletions(-)'}
                </span>
              ) : null}
            </div>

            {/* Line 4: Reference badges */}
            {references && references.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {references.map((ref) => {
                  const isRemote = ref.kind === 'remote';
                  const isTag = ref.kind === 'tag';
                  return (
                    <span
                      key={ref.id}
                      data-git-commit-hover-tag={isTag ? ref.id : undefined}
                      data-git-commit-hover-ref={ref.id}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 typography-micro font-medium',
                        ref.color
                          ? 'border-transparent text-[var(--primary-foreground)]'
                          : 'border-sky-800/60 bg-sky-950/60 text-sky-300',
                      )}
                      style={ref.color ? { backgroundColor: ref.color } : undefined}
                    >
                      {isRemote ? (
                        <Icon name="cloud" className="size-3 shrink-0" />
                      ) : isTag ? (
                        <Icon name="git-commit" className="size-3 shrink-0" />
                      ) : (
                        <Icon name="git-branch" className="size-3 shrink-0" />
                      )}
                      <span className="truncate max-w-[200px]">{ref.name}</span>
                    </span>
                  );
                })}
              </div>
            ) : null}

            {/* Line 5: Actions / SHA / GitHub */}
            <div className="mt-2.5 flex items-center gap-2 typography-meta text-muted-foreground">
              <div className="flex items-center gap-1 text-sky-400">
                <Icon name="git-commit" className="size-3.5 shrink-0" />
                <span className="font-mono text-sky-400">{model.shortHash}</span>
              </div>
              <button
                type="button"
                onClick={() => onCopyHash(model.hash)}
                title={copyShaLabel}
                aria-label={copyShaLabel}
                className="inline-flex items-center justify-center p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Icon name="file-copy" className="size-3.5" />
              </button>
              {githubUrl ? (
                <>
                  <span className="select-none text-muted-foreground/40">|</span>
                  <button
                    type="button"
                    onClick={() => { void openExternalUrl(githubUrl); }}
                    className="inline-flex items-center gap-1 text-sky-400 transition-colors hover:text-sky-300 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Icon name="github" className="size-3.5 shrink-0" />
                    <span>{openGitHubLabel}</span>
                  </button>
                </>
              ) : null}
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
