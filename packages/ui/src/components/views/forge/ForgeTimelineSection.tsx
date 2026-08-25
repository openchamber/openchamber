import React, { useMemo } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { IconName } from '@/components/icon/icons';
import type { ForgeComment, ForgeTimelineEvent, ForgeTimelineEventType, ForgeUser } from '@/lib/forge/types';

interface ForgeTimelineSectionProps {
  events: ForgeTimelineEvent[];
  comments: ForgeComment[];
  loading?: boolean;
  error?: string | null;
  /** Optional: asked when the user hits Reply on an inline-comment thread (its root comment). */
  onReply?: (comment: ForgeComment) => void;
  /** Optional: rendered under a thread card the parent is replying to. */
  renderReply?: (comment: ForgeComment) => React.ReactNode;
}

const EVENT_ICONS: Record<ForgeTimelineEventType, IconName> = {
  opened: 'git-pull-request',
  reopened: 'git-pull-request',
  closed: 'git-close-pull-request',
  merged: 'git-merge',
  committed: 'git-commit',
  reviewed: 'eye',
  approved: 'checkbox-circle',
  'requested-changes': 'alert',
  commented: 'chat-1',
  referenced: 'external-link',
  labeled: 'pushpin',
  unlabeled: 'pushpin',
  assigned: 'user',
  unassigned: 'user',
  milestoned: 'target',
  demilestoned: 'target',
  other: 'more',
};

const EVENT_COLORS: Partial<Record<ForgeTimelineEventType, string>> = {
  approved: 'var(--status-success)',
  'requested-changes': 'var(--status-error)',
  merged: 'var(--pr-merged)',
  closed: 'var(--pr-closed)',
};

const toTimestamp = (value?: string): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const CommentAvatar: React.FC<{ author?: ForgeUser | null }> = ({ author }) => {
  const label = author?.name ?? author?.login ?? '?';
  const initial = label.charAt(0).toUpperCase();
  return (
    <div className="absolute left-0 top-0 z-10 flex size-8 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-surface-elevated text-xs text-muted-foreground">
      {author?.avatarUrl ? (
        <img src={author.avatarUrl} alt={label} className="h-full w-full object-cover" />
      ) : (
        <span>{initial}</span>
      )}
    </div>
  );
};

const InlineContextChip: React.FC<{ comment: ForgeComment; label: string }> = ({ comment, label }) => {
  if (!comment.path) return null;
  const text = comment.line ? `${comment.path}:${comment.line}` : comment.path;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border/60 bg-transparent px-1.5 py-px typography-micro text-muted-foreground" title={label}>
      <Icon name="code" className="size-3 shrink-0" />
      <code className="font-mono">{text}</code>
    </span>
  );
};

type TimelineItem =
  | { kind: 'event'; event: ForgeTimelineEvent }
  | { kind: 'thread'; thread: ForgeComment[] };

/**
 * Chronologically merged activity timeline for a pull request or issue: event
 * markers interleaved with comment threads. Inline review comments are grouped
 * by `inReplyToId` chains or (path, line) buckets; a thread renders as one
 * card with its comments stacked. Pure presentation.
 */
export const ForgeTimelineSection = React.memo<ForgeTimelineSectionProps>(function ForgeTimelineSection({ events, comments, loading, error, onReply, renderReply }) {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

  const formatTime = React.useCallback((value?: string): string => {
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
  }, [timeFormatPreference]);

  const threads = useMemo(() => {
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    const repliesByParent = new Map<string, ForgeComment[]>();
    for (const comment of comments) {
      if (comment.inReplyToId && byId.has(comment.inReplyToId)) {
        const list = repliesByParent.get(comment.inReplyToId) ?? [];
        list.push(comment);
        repliesByParent.set(comment.inReplyToId, list);
      }
    }

    const collect = (root: ForgeComment): ForgeComment[] => {
      const members: ForgeComment[] = [];
      const visit = (comment: ForgeComment): void => {
        members.push(comment);
        for (const reply of repliesByParent.get(comment.id) ?? []) {
          visit(reply);
        }
      };
      visit(root);
      return members.sort((a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt));
    };

    const roots = comments.filter((comment) => !comment.inReplyToId || !byId.has(comment.inReplyToId));
    const buckets = new Map<string, ForgeComment[]>();
    const standalone: ForgeComment[] = [];
    for (const root of roots) {
      if (root.path) {
        const key = root.line ? `${root.path}:${root.line}` : `path:${root.path}`;
        const list = buckets.get(key) ?? [];
        list.push(root);
        buckets.set(key, list);
      } else {
        standalone.push(root);
      }
    }

    const seen = new Set<string>();
    const dedupe = (members: ForgeComment[]): ForgeComment[] =>
      members.filter((member) => {
        if (seen.has(member.id)) return false;
        seen.add(member.id);
        return true;
      });

    const result: ForgeComment[][] = [];
    for (const root of buckets.values()) {
      result.push(dedupe(root.flatMap(collect)));
    }
    for (const root of standalone) {
      result.push(dedupe(collect(root)));
    }
    return result;
  }, [comments]);

  const items = useMemo<TimelineItem[]>(() => {
    const all: TimelineItem[] = [
      ...events.map((event) => ({ kind: 'event' as const, event })),
      ...threads.map((thread) => ({ kind: 'thread' as const, thread })),
    ];
    all.sort((a, b) => {
      const aTs = a.kind === 'event' ? toTimestamp(a.event.createdAt) : toTimestamp(a.thread[0]?.createdAt);
      const bTs = b.kind === 'event' ? toTimestamp(b.event.createdAt) : toTimestamp(b.thread[0]?.createdAt);
      return aTs - bTs;
    });
    return all;
  }, [events, threads]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3" data-testid="forge-timeline-loading">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-8 w-3/4" />
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

  if (items.length === 0) {
    return <p className="py-3 text-center typography-micro text-muted-foreground">{t('forge.timeline.empty')}</p>;
  }

  return (
    <div className="relative pl-3">
      <div>
        {items.map((item, idx) => {
          const isLast = idx === items.length - 1;
          if (item.kind === 'event') {
            const { event } = item;
            return (
              <div key={`event-${event.id}`} className="relative pl-10 pb-4 last:pb-0">
                {!isLast ? <div className="absolute left-4 top-8 bottom-0 w-px bg-border/60" /> : null}
                <div className="absolute left-0 top-0 z-10 flex size-8 items-center justify-center rounded-full border border-border/60 bg-surface-elevated">
                  <Icon
                    name={EVENT_ICONS[event.type] ?? EVENT_ICONS.other}
                    className="size-4"
                    style={{ color: EVENT_COLORS[event.type] ?? 'var(--surface-muted-foreground)' }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pt-1 typography-micro text-muted-foreground">
                  <span className="font-medium text-foreground">{t(`forge.timeline.event.${event.type}` as never)}</span>
                  {event.author ? <span>{event.author.login}</span> : null}
                  {event.createdAt ? <span>{formatTime(event.createdAt)}</span> : null}
                </div>
                {event.body ? (
                  <p className="mt-1 whitespace-pre-wrap break-words typography-micro text-muted-foreground">{event.body}</p>
                ) : null}
              </div>
            );
          }
          const { thread } = item;
          const root = thread[0];
          return (
            <div key={`thread-${root.id}`} className="relative pl-10 pb-5 last:pb-0">
              {!isLast ? <div className="absolute left-4 top-[2.375rem] bottom-[0.375rem] w-px bg-border/60" /> : null}
              <CommentAvatar author={root.author} />
              <div className="rounded-lg bg-surface-elevated px-3 py-2">
                <div className="flex flex-col gap-3">
                  {thread.map((comment, commentIdx) => (
                    <div
                      key={comment.id}
                      className={commentIdx > 0 ? 'border-t border-border/40 pt-3' : ''}
                    >
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 typography-micro text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {comment.author?.name ?? comment.author?.login ?? 'Unknown'}
                        </span>
                        {comment.createdAt ? <span>{formatTime(comment.createdAt)}</span> : null}
                        <InlineContextChip
                          comment={comment}
                          label={comment.line
                            ? t('forge.comment.inlineAt', { path: comment.path ?? '', line: String(comment.line) })
                            : (comment.path ?? '')}
                        />
                      </div>
                      <SimpleMarkdownRenderer
                        content={comment.body}
                        className="typography-markdown-body text-foreground break-words [&_a]:no-underline [&_a:hover]:no-underline"
                        enableFileReferences={false}
                      />
                    </div>
                  ))}
                </div>
                {root.path && onReply ? (
                  <div className="flex items-center gap-1.5 pt-2">
                    <Button
                      variant="link"
                      size="xs"
                      onClick={() => onReply(root)}
                      aria-label={t('forge.actions.reply')}
                    >
                      {t('forge.actions.reply')}
                    </Button>
                  </div>
                ) : null}
                {renderReply ? renderReply(root) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
