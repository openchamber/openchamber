import React from 'react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import type { GitLogEntry } from '@/lib/api/types';
import type { CommitActionsController } from './useCommitActions';

interface ParsedRef {
  name: string;
  kind: 'head' | 'local' | 'remote' | 'tag';
}

function parseRefs(refs?: string): ParsedRef[] {
  if (!refs || !refs.trim()) return [];
  const result: ParsedRef[] = [];
  for (const raw of refs.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('HEAD -> ')) {
      result.push({ name: trimmed.slice('HEAD -> '.length).trim(), kind: 'head' });
    } else if (trimmed === 'HEAD') {
      result.push({ name: 'HEAD', kind: 'head' });
    } else if (trimmed.startsWith('tag: ')) {
      result.push({ name: trimmed.slice('tag: '.length).trim(), kind: 'tag' });
    } else if (trimmed.includes('/')) {
      result.push({ name: trimmed, kind: 'remote' });
    } else {
      result.push({ name: trimmed, kind: 'local' });
    }
  }
  return result;
}

export const CommitActionsDropdown: React.FC<{
  entry: GitLogEntry;
  actions: CommitActionsController;
}> = ({ entry, actions }) => {
  const { t } = useI18n();
  const disabled = actions.busyHash !== null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex shrink-0">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                aria-label={t('diffView.actions.moreActions')}
              >
                <Icon name="more-fill" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{t('diffView.actions.moreActions')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={() => actions.copySha(entry)}>
          <Icon name="file-copy" className="size-4" />
          {t('gitView.history.copySha')}
        </DropdownMenuItem>
        {actions.canMutate && (actions.hasCheckout || actions.hasCreateBranch || actions.hasCherryPick || actions.hasRevert) ? (
          <>
            <DropdownMenuSeparator />
            {actions.hasCheckout ? (
              <DropdownMenuItem disabled={disabled} onSelect={() => actions.checkout(entry)}>
                {t('gitView.history.actions.checkout')}
              </DropdownMenuItem>
            ) : null}
            {actions.hasCreateBranch ? (
              <DropdownMenuItem disabled={disabled} onSelect={() => actions.openCreateBranch(entry)}>
                {t('gitView.history.actions.createBranch')}
              </DropdownMenuItem>
            ) : null}
            {actions.hasCherryPick ? (
              <DropdownMenuItem disabled={disabled} onSelect={() => actions.cherryPick(entry)}>
                {t('gitView.history.actions.cherryPick')}
              </DropdownMenuItem>
            ) : null}
            {actions.hasRevert ? (
              <DropdownMenuItem disabled={disabled} onSelect={() => actions.revert(entry)}>
                {t('gitView.history.actions.revert')}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        {actions.canMutate && actions.hasReset ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={disabled}>
                {t('gitView.history.actions.reset')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem disabled={disabled} onSelect={() => actions.reset(entry, 'soft')}>
                  {t('gitView.history.actions.resetSoft')}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={disabled} onSelect={() => actions.reset(entry, 'mixed')}>
                  {t('gitView.history.actions.resetMixed')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={disabled}
                  className="text-[var(--status-error)]"
                  onSelect={() => actions.reset(entry, 'hard')}
                >
                  {t('gitView.history.actions.resetHard')}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

interface CommitListPanelProps {
  commits: readonly GitLogEntry[];
  selectedHash: string | null;
  loading: boolean;
  error: string | null;
  onSelectCommit: (commit: GitLogEntry) => void;
  onRefresh: () => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  actions: CommitActionsController;
  branchDivider?: {
    firstBaseHash: string;
    branchName: string;
    baseName: string;
    direction: 'up' | 'down';
  } | null;
  focusSelected?: boolean;
  onFocused?: () => void;
}

export const CommitListPanel: React.FC<CommitListPanelProps> = ({
  commits,
  selectedHash,
  loading,
  error,
  onSelectCommit,
  onRefresh,
  onLoadMore,
  hasMore = false,
  actions,
  branchDivider = null,
  focusSelected = false,
  onFocused,
}) => {
  const { t } = useI18n();
  const timeFormat = useUIStore((state) => state.timeFormatPreference);
  const [search, setSearch] = React.useState('');

  const filtered = React.useMemo(() => {
    if (!search.trim()) return commits;
    return rankByQuery(commits, search, (commit) => [commit.message, commit.author_name, commit.hash]);
  }, [commits, search]);

  const dividerIndex = branchDivider ? filtered.findIndex((commit) => commit.hash === branchDivider.firstBaseHash) : -1;
  const showDivider = !search.trim() && branchDivider !== null && dividerIndex > 0;

  const formatCommitDate = React.useCallback((raw: string) => {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return raw;
    return formatDateTimeForPreference(parsed, timeFormat, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [timeFormat]);

  if (loading && commits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center gap-2 px-4 text-muted-foreground">
        <Icon name="loader-4" className="size-4 animate-spin" />
        <span className="typography-ui-label">{t('diffView.state.loadingChanges')}</span>
      </div>
    );
  }

  if (error && commits.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="typography-ui-label font-semibold text-foreground">{t('commitComparison.loadError')}</p>
        <p className="typography-meta text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={onRefresh}>{t('diffView.actions.retry')}</Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-2.5 pt-2 pb-1.5">
        <div className="relative flex items-center">
          <Icon name="search" className="pointer-events-none absolute inset-s-2.5 size-3.5 text-muted-foreground" />
          <Input
            inputSize="compact"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('commitComparison.search')}
            aria-label={t('commitComparison.search')}
            className="ps-8 pe-7"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('gitView.history.actions.cancelButton')}
              className="absolute inset-e-1.5 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <Icon name="close" className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center typography-meta text-muted-foreground">
          {t('commitComparison.noCommits')}
        </div>
      ) : (
        <ScrollableOverlay
          outerClassName="flex-1 min-h-0"
          className="px-1.5 pb-3"
          disableHorizontal
          preventOverscroll
        >
          <ul className="flex flex-col gap-0.5">
            {filtered.map((entry, index) => {
              const isSelected = entry.hash === selectedHash;
              const refs = parseRefs(entry.refs);
              const disabled = actions.busyHash !== null;

              return (
                <React.Fragment key={entry.hash}>
                  {showDivider && index === dividerIndex ? (
                    <li>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-2 px-2 py-1.5 typography-micro text-muted-foreground">
                            <Icon name={branchDivider.direction === 'down' ? 'arrow-down-s' : 'arrow-up'} className="size-3.5 shrink-0" />
                            <span className="truncate font-mono">{branchDivider.branchName}</span>
                            <span className="h-px flex-1 bg-edge-muted" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={4} className="max-w-72">
                          {t(dividerIndex === 1 ? 'commitComparison.branchDividerSingle' : 'commitComparison.branchDividerPlural', {
                            count: dividerIndex,
                            branch: branchDivider.branchName,
                            base: branchDivider.baseName,
                          })}
                        </TooltipContent>
                      </Tooltip>
                    </li>
                  ) : null}
                  <li>
                    <ContextMenu>
                      <ContextMenuTrigger className="block w-full">
                        <button
                          type="button"
                          onClick={() => onSelectCommit(entry)}
                          ref={isSelected && focusSelected ? (node) => {
                            if (!node) return;
                            node.focus();
                            onFocused?.();
                          } : undefined}
                          className={cn(
                            'flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-2 text-start transition-colors',
                            isSelected
                              ? 'bg-[var(--interactive-selection)]/45 text-foreground'
                              : 'text-foreground/85 hover:bg-[var(--interactive-hover)]/60 hover:text-foreground',
                          )}
                        >
                          {refs.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-1 pb-0.5">
                              {refs.map((ref) => (
                                <span
                                  key={`${ref.kind}:${ref.name}`}
                                  className={cn(
                                    'inline-flex max-w-full truncate rounded px-1.5 py-0.5 font-mono text-[11px] leading-none',
                                    ref.kind === 'head'
                                      ? 'bg-[var(--status-info-background)] text-[var(--status-info)]'
                                      : 'oc-tile-inset text-muted-foreground',
                                  )}
                                >
                                  {ref.name}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          <div
                            dir="auto"
                            className={cn(
                              'oc-ui-start-align truncate typography-ui-label',
                              isSelected ? 'font-semibold text-foreground' : 'font-medium',
                            )}
                            title={entry.message}
                          >
                            {entry.message}
                          </div>
                          <div className="flex min-w-0 items-center gap-1 typography-micro text-muted-foreground">
                            <span className="min-w-0 truncate">
                              {entry.author_name} · {formatCommitDate(entry.date)}
                            </span>
                            <span className="shrink-0 font-mono">· {entry.hash.slice(0, 7)}</span>
                          </div>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="min-w-44">
                        <ContextMenuItem onClick={() => actions.copySha(entry)}>
                          <Icon name="file-copy" className="me-2 size-4" />
                          {t('gitView.history.copySha')}
                        </ContextMenuItem>
                        {actions.canMutate && (actions.hasCheckout || actions.hasCreateBranch || actions.hasCherryPick || actions.hasRevert) ? (
                          <>
                            <ContextMenuSeparator />
                            {actions.hasCheckout ? (
                              <ContextMenuItem disabled={disabled} onClick={() => actions.checkout(entry)}>
                                {t('gitView.history.actions.checkout')}
                              </ContextMenuItem>
                            ) : null}
                            {actions.hasCreateBranch ? (
                              <ContextMenuItem disabled={disabled} onClick={() => actions.openCreateBranch(entry)}>
                                {t('gitView.history.actions.createBranch')}
                              </ContextMenuItem>
                            ) : null}
                            {actions.hasCherryPick ? (
                              <ContextMenuItem disabled={disabled} onClick={() => actions.cherryPick(entry)}>
                                {t('gitView.history.actions.cherryPick')}
                              </ContextMenuItem>
                            ) : null}
                            {actions.hasRevert ? (
                              <ContextMenuItem disabled={disabled} onClick={() => actions.revert(entry)}>
                                {t('gitView.history.actions.revert')}
                              </ContextMenuItem>
                            ) : null}
                          </>
                        ) : null}
                        {actions.canMutate && actions.hasReset ? (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuSub>
                              <ContextMenuSubTrigger disabled={disabled}>
                                {t('gitView.history.actions.reset')}
                              </ContextMenuSubTrigger>
                              <ContextMenuSubContent>
                                <ContextMenuItem disabled={disabled} onClick={() => actions.reset(entry, 'soft')}>
                                  {t('gitView.history.actions.resetSoft')}
                                </ContextMenuItem>
                                <ContextMenuItem disabled={disabled} onClick={() => actions.reset(entry, 'mixed')}>
                                  {t('gitView.history.actions.resetMixed')}
                                </ContextMenuItem>
                                <ContextMenuItem
                                  disabled={disabled}
                                  className="text-[var(--status-error)]"
                                  onClick={() => actions.reset(entry, 'hard')}
                                >
                                  {t('gitView.history.actions.resetHard')}
                                </ContextMenuItem>
                              </ContextMenuSubContent>
                            </ContextMenuSub>
                          </>
                        ) : null}
                      </ContextMenuContent>
                    </ContextMenu>
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
          {hasMore && onLoadMore && !search.trim() ? (
            <div className="flex justify-center pt-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onLoadMore}
                disabled={loading}
                className="px-3 text-muted-foreground hover:text-foreground"
              >
                {loading ? (
                  <span className="flex items-center gap-1">
                    <Icon name="loader-4" className="size-3 animate-spin" />
                    {t('gitView.history.loadingMore')}
                  </span>
                ) : (
                  t('gitView.history.loadMore')
                )}
              </Button>
            </div>
          ) : null}
        </ScrollableOverlay>
      )}
    </div>
  );
};
