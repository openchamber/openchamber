import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSessionDateLabel } from '@/components/session/sidebar/utils';
import type { GitWorktreeArchive } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { archivedWorktreeLabel } from '@/lib/worktrees/worktreeArchive';

/**
 * One archived worktree: its name, then its branch and when it was archived,
 * on one line; Restore at the end, Delete beside it on hover. The date sits
 * with the branch, so it does not form a second date column beside the
 * sessions' dates below. On a phone (`touch`) the branch and date take a
 * second line under the name, and Delete is always shown, as nothing hovers.
 */
export function ArchivedWorktreeRow({ archive, busy, onRestore, onDelete, touch = false }: {
  archive: GitWorktreeArchive;
  busy: boolean;
  onRestore: () => void;
  onDelete: () => void;
  touch?: boolean;
}): React.ReactNode {
  const { t } = useI18n();
  const label = archivedWorktreeLabel(archive);
  const showBranch = Boolean(archive.branch) && archive.branch !== label;
  const date = formatSessionDateLabel(archive.archivedAt);
  if (touch) {
    return (
      <div className="flex min-w-0 items-center gap-2 py-1 ps-3 pe-1">
        <Icon name="git-branch" className="size-3.5 shrink-0 self-start mt-[0.1875rem] text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span dir="auto" className="truncate oc-ui-start-align typography-ui-label font-medium text-foreground">{label}</span>
          <span className="truncate typography-micro text-muted-foreground">
            {showBranch ? <span className="font-mono">{archive.branch}</span> : null}
            {showBranch ? ' · ' : null}
            {date}
          </span>
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={busy}
          onClick={onRestore}
          aria-label={t('sessions.archive.worktree.restoreAria', { label })}
          style={{ touchAction: 'manipulation' }}
        >
          {busy ? <Spinner className="size-3" /> : <Icon name="inbox-unarchive" className="size-4" />}
          {t('sessions.archive.worktree.restore')}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="ghost"
          className="w-10 shrink-0 px-0 text-muted-foreground"
          disabled={busy}
          onClick={onDelete}
          aria-label={t('sessions.archive.worktree.deleteAria', { label })}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="delete-bin" className="size-5" />
        </Button>
      </div>
    );
  }
  return (
    <div className="group/worktree flex min-w-0 items-center gap-2 py-1 ps-2 pe-1">
      <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" />
      <span dir="auto" className="min-w-0 truncate oc-ui-start-align typography-ui-label font-medium text-foreground" title={archive.path}>{label}</span>
      <span className="min-w-0 shrink truncate typography-micro text-muted-foreground">
        {showBranch ? <span className="font-mono">{archive.branch}</span> : null}
        {showBranch ? ' · ' : null}
        {date}
      </span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="ms-auto shrink-0"
        disabled={busy}
        onClick={onRestore}
        aria-label={t('sessions.archive.worktree.restoreAria', { label })}
      >
        {busy ? <Spinner className="size-3" /> : <Icon name="inbox-unarchive" className="size-3.5" />}
        {t('sessions.archive.worktree.restore')}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/worktree:opacity-100 focus-visible:opacity-100 focus-visible:outline-none disabled:opacity-50"
            aria-label={t('sessions.archive.worktree.deleteAria', { label })}
          >
            <Icon name="delete-bin" className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>{t('sessions.archive.worktree.deleteTooltip')}</TooltipContent>
      </Tooltip>
    </div>
  );
}
