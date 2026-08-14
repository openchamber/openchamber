import React, { useMemo, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { GitLogEntry } from '@/lib/api/types';
import type { ForgeCommit } from '@/lib/forge/types';
import { assignLanes } from '@/components/views/git/gitGraph';
import { GitGraphSegment } from '@/components/views/git/GitGraphSegment';

interface ForgeCommitsSectionProps {
  commits: ForgeCommit[] | null;
  loading?: boolean;
  error?: string | null;
}

/**
 * Map a normalized forge commit onto the `GitLogEntry`-shaped input
 * `assignLanes` consumes. The commit list is authoritative; the synthesized
 * fields are only used for lane geometry and display text.
 */
const toLaneEntry = (commit: ForgeCommit): GitLogEntry => ({
  hash: commit.sha,
  date: commit.committedAt ?? '',
  message: commit.summary ?? commit.message,
  refs: '',
  body: commit.message,
  author_name: commit.author?.name ?? commit.author?.login ?? 'Unknown',
  author_email: '',
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  parents: commit.parents,
});

const formatCommitDate = (value: string | undefined, timeFormatPreference: TimeFormatPreference): string => {
  if (!value) return '';
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return value;
  return formatDateTimeForPreference(ts, timeFormatPreference, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/**
 * Commits on a pull request, rendered with the git-graph lane visual language
 * (GitGraphSegment over `assignLanes` output). Each row expands to the full
 * message and parent shas. Pure presentation.
 */
export const ForgeCommitsSection = React.memo<ForgeCommitsSectionProps>(function ForgeCommitsSection({ commits, loading, error }) {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [expandedShas, setExpandedShas] = useState<Set<string>>(new Set());

  const bySha = useMemo(() => new Map((commits ?? []).map((commit) => [commit.sha, commit])), [commits]);
  const laned = useMemo(() => assignLanes((commits ?? []).map(toLaneEntry)), [commits]);
  const totalLanes = useMemo(
    () => laned.reduce((max, item) => Math.max(max, item.lane), -1) + 1,
    [laned],
  );

  const toggle = React.useCallback((sha: string) => {
    setExpandedShas((previous) => {
      const next = new Set(previous);
      if (next.has(sha)) {
        next.delete(sha);
      } else {
        next.add(sha);
      }
      return next;
    });
  }, []);

  const copyHash = React.useCallback(async (sha: string) => {
    const result = await copyTextToClipboard(sha);
    if (result.ok) {
      toast.success(t('forge.copied'));
    }
  }, [t]);

  if (loading) {
    return (
      <div className="flex flex-col gap-2" data-testid="forge-commits-loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-4/5" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)]/40 px-3 py-2 typography-micro text-[var(--status-error)]">
        <Icon name="error-warning" className="size-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (!commits || commits.length === 0) {
    return <p className="py-3 text-center typography-micro text-muted-foreground">{t('forge.commits.empty')}</p>;
  }

  return (
    <ul className="flex flex-col">
      {laned.map((item) => {
        const commit = bySha.get(item.commit.hash);
        if (!commit) return null;
        const isExpanded = expandedShas.has(commit.sha);
        const author = commit.author?.name ?? commit.author?.login ?? null;
        return (
          <li key={commit.sha}>
            <button
              type="button"
              onClick={() => toggle(commit.sha)}
              className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--interactive-hover)]/40"
              aria-expanded={isExpanded}
            >
              <div className="-my-2 shrink-0 self-stretch">
                <GitGraphSegment laned={item} totalLanes={totalLanes} isExpanded={isExpanded} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="typography-ui-label font-medium text-foreground line-clamp-1">
                  {commit.summary ?? commit.message}
                </p>
                <div className="flex min-w-0 items-center gap-1 typography-meta text-muted-foreground">
                  {author ? <span className="min-w-0 truncate">{author}</span> : null}
                  {author && commit.committedAt ? <span className="shrink-0">·</span> : null}
                  {commit.committedAt ? (
                    <span className="min-w-0 truncate">{formatCommitDate(commit.committedAt, timeFormatPreference)}</span>
                  ) : null}
                  <span className="shrink-0">·</span>
                  <code className="shrink-0 font-mono">{commit.shortSha}</code>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 shrink-0 px-1"
                        aria-label={t('gitView.history.copySha')}
                        onClick={(event) => {
                          event.stopPropagation();
                          void copyHash(commit.sha);
                        }}
                      >
                        <Icon name="file-copy" className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8}>{t('gitView.history.copySha')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </button>
            {isExpanded ? (
              <div className="border-t border-border/40 px-3 pb-2 pl-8">
                <p className="typography-micro text-foreground whitespace-pre-wrap break-words">{commit.message}</p>
                {commit.parents.length > 0 ? (
                  <p className="mt-1 flex flex-wrap items-center gap-1 typography-micro text-muted-foreground">
                    <span>{t('forge.commits.parents')}:</span>
                    {commit.parents.map((parent) => (
                      <code key={parent} className="font-mono">{parent.slice(0, 7)}</code>
                    ))}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
});
