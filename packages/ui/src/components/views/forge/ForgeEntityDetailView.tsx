import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useI18n } from '@/lib/i18n';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type {
  ForgeChecksResult,
  ForgeCommitsResult,
  ForgeEntityRef,
  ForgeIssueDetail,
  ForgeProvider,
  ForgePullRequestContext,
  ForgeTimelineResult,
} from '@/lib/forge/provider';
import type { ForgeComment, ForgeTimelineEvent } from '@/lib/forge/types';
import { ForgeMetadataChips } from './ForgeMetadataChips';
import { ForgeCommitsSection } from './ForgeCommitsSection';
import { ForgeFilesDiffSection } from './ForgeFilesDiffSection';
import { ForgeTimelineSection } from './ForgeTimelineSection';
import { ForgeChecksSection } from './ForgeChecksSection';
import {
  ForgeCommentComposer,
  ForgeEntityActions,
  ForgeMetadataEditor,
  ForgeThreadReply,
} from './actions';

interface ForgeEntityDetailViewProps {
  provider: ForgeProvider;
  directory: string;
  number: number;
  options?: {
    sourceRepo?: string | null;
    kind?: 'pull' | 'issue';
  };
  /** Optional CTA target for the not-connected notice. */
  onOpenSettings?: () => void;
}

interface PullData {
  context: ForgePullRequestContext | null;
  commits: ForgeCommitsResult | null;
  timeline: ForgeTimelineResult | null;
  checks: ForgeChecksResult | null;
}

const markdownClassName =
  'typography-markdown-body text-foreground break-words [&_a]:no-underline [&_a:hover]:no-underline';

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="typography-ui-label font-semibold text-foreground">{children}</h4>
);

const LoadingBlock: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2 py-1 typography-micro text-muted-foreground">
      <Icon name="loader-4" className="size-4 animate-spin" />
      {label}
    </div>
    <Skeleton className="h-6 w-2/3" />
    <Skeleton className="h-5 w-full" />
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-16 w-full" />
  </div>
);

const ErrorBlock: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-center gap-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)]/40 px-3 py-2 typography-micro text-[var(--status-error)]">
    <Icon name="error-warning" className="size-4 shrink-0" />
    {message}
  </div>
);

const NotConnectedBlock: React.FC<{ onOpenSettings?: () => void }> = ({ onOpenSettings }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/40 bg-surface-elevated px-4 py-3">
      <div className="typography-ui-label text-foreground">{t('forge.notConnected')}</div>
      {onOpenSettings ? (
        <Button variant="outline" size="sm" className="w-fit" onClick={onOpenSettings}>
          {t('gitView.pr.actions.openSettings')}
        </Button>
      ) : null}
    </div>
  );
};

/**
 * Self-loading detail view for a forge pull request or issue. Owns all data
 * fetching through the provider facade (context/issue plus commits, timeline,
 * and checks where the provider implements them) and renders the presentational
 * section components. Sections stay capability-gated: GitHub check runs ride on
 * the pull-request context, Gitea statuses come from `getChecks`, GitLab has no
 * checks surface.
 */
export const ForgeEntityDetailView: React.FC<ForgeEntityDetailViewProps> = ({ provider, directory, number, options, onOpenSettings }) => {
  const { t } = useI18n();
  const isIssue = (options?.kind ?? 'pull') === 'issue';
  const sourceRepo = options?.sourceRepo ?? null;

  const [pull, setPull] = useState<PullData | null>(null);
  const [issueDetail, setIssueDetail] = useState<ForgeIssueDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Bumped after a successful write so the owning load effect re-runs; never
  // bumped on render, so writes are the only trigger.
  const [reloadToken, setReloadToken] = useState(0);
  // Comments posted through this view are appended locally so they appear
  // immediately; a later context refresh reconciles them with authoritative
  // server data (and the load effect clears the local list).
  const [localComments, setLocalComments] = useState<ForgeComment[]>([]);
  // Id of the thread root the user is replying to (renders ForgeThreadReply
  // under that thread card).
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const ref = useMemo<ForgeEntityRef>(() => ({ kind: isIssue ? 'issue' : 'pull', number }), [isIssue, number]);

  const appendComment = useCallback((comment: ForgeComment) => {
    setLocalComments((previous) => [...previous, comment]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPull(null);
    setIssueDetail(null);
    setLocalComments([]);
    setIsLoading(true);

    if (isIssue) {
      if (!provider.getIssue) {
        setIsLoading(false);
        return;
      }
      void provider
        .getIssue(directory, number, { sourceRepo })
        .then((detail) => {
          if (cancelled) return;
          setIssueDetail(detail);
          setIsLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setIsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    const canCommits = typeof provider.getCommits === 'function';
    const canTimeline = typeof provider.getTimeline === 'function';
    const canChecks = provider.capabilities.checks === 'commit-statuses' && typeof provider.getChecks === 'function';

    void (async () => {
      const context = provider.getPullRequestContext
        ? await provider.getPullRequestContext(directory, number, { includeDiff: true, sourceRepo })
        : null;
      const [commits, timeline, checks] = await Promise.all([
        canCommits ? provider.getCommits!(directory, number, { sourceRepo }) : Promise.resolve(null),
        canTimeline ? provider.getTimeline!(directory, number, { sourceRepo }) : Promise.resolve(null),
        canChecks ? provider.getChecks!(directory, number, { sourceRepo }) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setPull({ context, commits, timeline, checks });
      setIsLoading(false);
    })().catch(() => {
      if (cancelled) return;
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [directory, isIssue, number, provider, reloadToken, sourceRepo]);

  const mergedComments = useMemo<ForgeComment[]>(() => {
    const derived = isIssue
      ? issueDetail?.comments ?? []
      : [...(pull?.context?.issueComments ?? []), ...(pull?.context?.reviewComments ?? [])];
    return [...localComments, ...derived];
  }, [isIssue, issueDetail?.comments, localComments, pull?.context]);

  const timelineEvents = useMemo<ForgeTimelineEvent[]>(() => pull?.timeline?.events ?? [], [pull?.timeline]);

  const checksForPull = useMemo<{ kind: 'check-runs' | 'commit-statuses'; summary: ForgeChecksResult['checks'] } | null>(() => {
    const context = pull?.context;
    if (!context) return null;
    const checksResult = pull?.checks;
    if (provider.capabilities.checks === 'check-runs') {
      return context.checks ? { kind: 'check-runs', summary: context.checks } : null;
    }
    if (provider.capabilities.checks === 'commit-statuses') {
      return checksResult ? { kind: 'commit-statuses', summary: checksResult.checks } : null;
    }
    return null;
  }, [pull?.context, provider.capabilities.checks, pull?.checks]);

  const canReply = typeof provider.replyToThread === 'function';

  const handleReply = useCallback((comment: ForgeComment) => {
    setReplyingTo(comment.id);
  }, []);

  const renderThreadReply = useCallback(
    (comment: ForgeComment): React.ReactNode => {
      if (comment.id !== replyingTo) return null;
      return (
        <ForgeThreadReply
          provider={provider}
          directory={directory}
          ref={ref}
          thread={{ inReplyToId: comment.id, path: comment.path ?? null, line: comment.line ?? null }}
          onPosted={(created) => {
            appendComment(created);
            setReplyingTo(null);
          }}
          onCancel={() => setReplyingTo(null)}
        />
      );
    },
    [appendComment, directory, provider, ref, replyingTo],
  );

  if (isLoading) {
    return <LoadingBlock label={t('forge.loading')} />;
  }

  if (isIssue) {
    if (!issueDetail || !issueDetail.connected) {
      return <NotConnectedBlock onOpenSettings={onOpenSettings} />;
    }
    const issue = issueDetail.issue;
    if (!issue) {
      return <ErrorBlock message={t('forge.error')} />;
    }
    const issueState = issue.state === 'closed' ? 'closed' : 'open';
    const stateColor = `var(--pr-${issueState})`;
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Icon name="sticky-note" className="size-4 shrink-0" style={{ color: stateColor }} />
          <h3 className="min-w-0 truncate typography-ui-header font-semibold text-foreground">{issue.title}</h3>
          <span className="typography-meta text-muted-foreground">#{issue.number}</span>
          <span className="typography-micro shrink-0" style={{ color: stateColor }}>
            {t(`forge.state.${issueState}`)}
          </span>
        </div>
        <ForgeEntityActions provider={provider} directory={directory} ref={ref} issue={issue} onChanged={reload} />
        <ForgeMetadataChips kind="issue" issue={issue} />
        <ForgeMetadataEditor
          provider={provider}
          directory={directory}
          ref={ref}
          labels={issue.labels ?? []}
          assignees={issue.assignees ?? []}
          milestone={issue.milestone}
          onChanged={reload}
        />
        {issue.body ? (
          <SimpleMarkdownRenderer content={issue.body} className={markdownClassName} enableFileReferences={false} />
        ) : null}
        <section aria-label={t('forge.section.timeline')}>
          <SectionTitle>{t('forge.section.timeline')}</SectionTitle>
          <ForgeTimelineSection
            events={[]}
            comments={mergedComments}
            error={issueDetail.commentsError ?? null}
            onReply={canReply ? handleReply : undefined}
            renderReply={canReply ? renderThreadReply : undefined}
          />
        </section>
        <ForgeCommentComposer provider={provider} directory={directory} ref={ref} onPosted={appendComment} />
      </div>
    );
  }

  if (!pull || !pull.context || !pull.context.connected) {
    return <NotConnectedBlock onOpenSettings={onOpenSettings} />;
  }
  const context = pull.context;
  const pr = context.pr;
  if (!pr) {
    return <ErrorBlock message={t('forge.error')} />;
  }

  const stateColor = `var(--pr-${pr.state})`;
  const stateIcon = pr.state === 'merged'
    ? 'git-merge'
    : pr.state === 'closed'
      ? 'git-close-pull-request'
      : 'git-pull-request';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name={stateIcon} className="size-4 shrink-0" style={{ color: stateColor }} />
        <h3 className="min-w-0 truncate typography-ui-header font-semibold text-foreground">{pr.title}</h3>
        <span className="typography-meta text-muted-foreground">#{pr.number}</span>
        <span className="typography-micro shrink-0" style={{ color: stateColor }}>
          {t(`forge.state.${pr.state}` as never)}
        </span>
        {pr.draft ? (
          <span className="inline-flex items-center rounded border border-border/60 bg-surface-elevated px-1.5 py-px typography-micro text-foreground">
            {t('forge.draft')}
          </span>
        ) : null}
      </div>

      <ForgeEntityActions provider={provider} directory={directory} ref={ref} pr={pr} onChanged={reload} />

      <ForgeMetadataChips kind="pull" pr={pr} />

      {checksForPull ? (
        <section aria-label={t('forge.section.checks')}>
          <SectionTitle>{t('forge.section.checks')}</SectionTitle>
          <ForgeChecksSection
            kind={checksForPull.kind}
            summary={checksForPull.summary}
            error={provider.capabilities.checks === 'commit-statuses' ? (pull.checks?.error ?? null) : null}
          />
        </section>
      ) : null}

      {typeof provider.getCommits === 'function' ? (
        <section aria-label={t('forge.section.commits')}>
          <SectionTitle>{t('forge.section.commits')}</SectionTitle>
          <ForgeCommitsSection commits={pull.commits?.commits ?? null} error={pull.commits?.error ?? null} />
        </section>
      ) : null}

      <section aria-label={t('forge.section.files')}>
        <SectionTitle>{t('forge.section.files')}</SectionTitle>
        <ForgeFilesDiffSection files={context.files ?? null} diff={context.diff} />
      </section>

      <section aria-label={t('forge.section.timeline')}>
        <SectionTitle>{t('forge.section.timeline')}</SectionTitle>
        <ForgeTimelineSection
          events={timelineEvents}
          comments={mergedComments}
          error={pull.timeline?.error ?? null}
          onReply={canReply ? handleReply : undefined}
          renderReply={canReply ? renderThreadReply : undefined}
        />
      </section>
      <ForgeCommentComposer provider={provider} directory={directory} ref={ref} onPosted={appendComment} />
    </div>
  );
};
