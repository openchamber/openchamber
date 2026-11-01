import * as React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import type {
  Issue,
  IssueComment,
  Label,
  MilestoneChoice,
  RepositoryIssueReference,
  RepositoryReference,
  RepositorySelector,
} from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { useRepositoryBinding } from '@/lib/source-control/repository-binding';
import { effectiveRepositoryBinding } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';

import { IssueFilterMenu } from '../../references/IssueFilterMenu';
import { useChoiceOptions, type ChoiceOptionsState } from '../../references/issueFilterOptions';
import { useRepositoryReadContext, useRepositoryReferenceList, useRepositoryReferenceProvider } from '../../references/referenceSources';
import { labelColor, referenceNumberLabel, repositoryStateLook, type IssueFilter } from '../../references/referencePickerItems';
import { resolveComposerReferences } from '../../references/resolveComposerReferences';
import { usePendingComposerReferences } from '../../chat/composer/pendingComposerReferences';
import { KnowledgeEntryView } from './KnowledgeEntryView';
import { issueToRepositoryReference } from './issueReference';

type OpenIssueRead =
  | { status: 'loading' }
  | { status: 'ready'; issue: Issue; comments: IssueComment[] }
  | { status: 'failed' };

type IssuesSectionProps = {
  directory: string;
  filter: IssueFilter;
  onFilterChange: (patch: Partial<IssueFilter>) => void;
  openIssueNumber: number | null;
  onOpenIssue: (number: number | null) => void;
  /** Wide: this section is the list column only; the panel renders the detail beside it. */
  split: boolean;
  /** False beside the list (split layout), where there is nothing to go back to. */
  showBack?: boolean;
};

/**
 * The project's issues, filtered, with the full issue opened in place: the
 * complete body and comment thread, milestone, labels, state and author.
 * Nothing truncates: a failed list read shows the failure state, never an
 * empty list that reads as "no issues".
 */
export const IssuesSection: React.FC<IssuesSectionProps> = ({ directory, filter, onFilterChange, openIssueNumber, onOpenIssue, split, showBack }) => {
  const { t } = useI18n();
  const { sourceControl } = useRuntimeAPIs();
  const readContext = useRepositoryReadContext(directory);
  const context = readContext && readContext !== 'missing' ? readContext : null;
  const providerId = useRepositoryReferenceProvider(directory);
  const descriptor = useSourceControlProvider(providerId);

  const list = useRepositoryReferenceList({
    enabled: context !== null,
    directory,
    kind: 'issue',
    filter,
    query: '',
  });

  // The project the detail read names. The binding is the authority: the read
  // context names provider and instance, and the binding entry for them names
  // the repository. Null for a project with no provider entry, where the read
  // names the directory alone.
  const binding = useRepositoryBinding(directory, sourceControl, context !== null);
  const project = React.useMemo<RepositorySelector | null>(() => {
    const read = binding.read;
    if (!context || !read) return null;
    const bound = effectiveRepositoryBinding(read).providers
      .find((entry) => entry.provider === context.provider && entry.instance === context.instance);
    return bound?.repository ? { owner: bound.repository.owner, repo: bound.repository.name } : null;
  }, [binding.read, context]);

  // The option reads name no project: the server resolves the repository from
  // the read context's directory, as the list read does, so an unconfigured
  // project reads its options instead of leaving the dropdowns in loading.
  const labels = useChoiceOptions<Label>(
    React.useCallback(
      async () => (context ? sourceControl.referenceLabels(context) : []),
      [context, sourceControl],
    ),
    context ? `${context.provider}:${context.directory}:labels` : null,
  );
  const milestones = useChoiceOptions<MilestoneChoice>(
    React.useCallback(
      async () => (context ? sourceControl.referenceMilestones(context) : []),
      [context, sourceControl],
    ),
    context ? `${context.provider}:${context.directory}:milestones` : null,
  );

  const [openIssue, setOpenIssue] = React.useState<OpenIssueRead | null>(null);
  React.useEffect(() => {
    // In the split layout the panel renders a second, detail-only instance
    // beside the list; the list column keeps its hands off the detail read.
    if (openIssueNumber === null || !context || split) {
      setOpenIssue(null);
      return;
    }
    let cancelled = false;
    setOpenIssue({ status: 'loading' });
    const projectSelector = project ? { owner: project.owner, name: project.repo } : undefined;
    void Promise.all([
      sourceControl.issueGet(context, openIssueNumber, projectSelector),
      sourceControl.issueComments(context, openIssueNumber, projectSelector),
    ]).then(([issue, comments]) => {
      if (cancelled) return;
      setOpenIssue(issue ? { status: 'ready', issue, comments } : { status: 'failed' });
    }, () => {
      if (!cancelled) setOpenIssue({ status: 'failed' });
    });
    return () => { cancelled = true; };
  }, [context, openIssueNumber, project, sourceControl, split]);

  const attachToSession = (issue: Issue) => {
    if (!context) return;
    void resolveComposerReferences(
      [{ source: 'repository', reference: issueToRepositoryReference(issue, context.primaryRemote), includeDiff: false }],
      {
        sourceControl,
        context,
        readTrackerDetail: () => Promise.reject(new Error('n/a')),
        trackerName: () => '',
      },
    ).then(({ references, failures }) => {
      if (references.length > 0) usePendingComposerReferences.getState().push(references);
      const failure = failures[0];
      if (failure) toast.error(t('sourceBoard.error.attachFailed', { item: failure.label }), { description: failure.error });
    });
  };

  // The host's own page for the issue; the runtime link path opens it,
  // through the VS Code and desktop bridges where they exist.
  const openOnHost = (issue: Issue) => {
    void openExternalUrl(issue.url);
  };

  if (!context) {
    return <p className="typography-meta text-muted-foreground">{t('issuesPanel.empty')}</p>;
  }

  const milestoneName = filter.milestoneNames[0] ?? null;
  const openDetail = openIssue?.status === 'ready' ? openIssue.issue : null;

  const detail = openDetail ? (
    <IssueDetail
      issue={openDetail}
      comments={openIssue?.status === 'ready' ? openIssue.comments : []}
      milestoneName={milestoneName}
      providerLabel={descriptor.label}
      showBack={showBack ?? !split}
      onAttach={() => attachToSession(openDetail)}
      onOpenOnHost={() => openOnHost(openDetail)}
      onClose={() => onOpenIssue(null)}
    />
  ) : openIssue?.status === 'loading' ? (
    <div className="flex h-full items-center justify-center gap-2 typography-meta text-muted-foreground">
      <Icon name="loader-4" className="size-4 animate-spin" />
      {t('references.picker.loading')}
    </div>
  ) : null;

  const listContent = (
    <IssuesList
      rows={list.items}
      listStatus={list.status}
      listUnavailable={list.unavailable}
      listError={list.error}
      onRetry={() => void list.retry()}
      openIssueNumber={openIssueNumber}
      onOpenIssue={onOpenIssue}
      filter={filter}
      onFilterChange={onFilterChange}
      labels={labels}
      milestones={milestones}
      showLabel={descriptor.features.labels}
      showMilestone={descriptor.features.milestones}
      descriptor={descriptor}
    />
  );

  // Wide: the panel renders the detail in its own column beside this one.
  if (split) return listContent;
  // A detail that failed to read falls back to the list, the way the panel's
  // other sections do for an entry that cannot be shown.
  return openIssueNumber !== null ? (detail ?? listContent) : listContent;
};

type IssuesListProps = {
  rows: RepositoryReference[];
  listStatus: 'loading' | 'ready' | 'unavailable' | 'error';
  listUnavailable: 'disconnected' | 'no-repo' | null;
  listError: string | null;
  onRetry: () => void;
  openIssueNumber: number | null;
  onOpenIssue: (number: number | null) => void;
  filter: IssueFilter;
  onFilterChange: (patch: Partial<IssueFilter>) => void;
  labels: ChoiceOptionsState<Label> | null;
  milestones: ChoiceOptionsState<MilestoneChoice> | null;
  showLabel: boolean;
  showMilestone: boolean;
  descriptor: SourceControlProviderDescriptor;
};

/**
 * The filtered issue list: the shared filter menu, the loading, failure and
 * empty states, and the rows (number, title, state dot, milestone chip).
 * The panel's scroller owns the vertical scroll.
 */
const IssuesList: React.FC<IssuesListProps> = ({
  rows, listStatus, listUnavailable, listError, onRetry, openIssueNumber, onOpenIssue,
  filter, onFilterChange, labels, milestones, showLabel, showMilestone, descriptor,
}) => {
  const { t } = useI18n();
  const issues = rows.filter((item): item is RepositoryIssueReference => item.kind === 'issue');
  // The list read carries no per-issue milestone; the milestone filter narrows
  // the list to one, so its name is true for every row it shows.
  const milestoneName = filter.milestoneNames[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center justify-start pb-2">
        <IssueFilterMenu
          filter={filter}
          onFilterChange={onFilterChange}
          labels={labels}
          milestones={milestones}
          showLabel={showLabel}
          showMilestone={showMilestone}
        />
      </div>

      {listStatus === 'loading' ? (
        <div className="flex items-center justify-center gap-2 py-8 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          {t('references.picker.loading')}
        </div>
      ) : listStatus === 'error' || listUnavailable !== null ? (
        // A failed list read says so; it never reads as "no issues".
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <span className="break-words typography-meta text-[var(--status-error-text)]">
            {t('references.picker.error.load', { error: listError ?? listUnavailable ?? '' })}
          </span>
          <Button size="sm" variant="outline" onClick={onRetry}>{t('references.picker.actions.retry')}</Button>
        </div>
      ) : (
        <>
          {listError ? (
            // A refresh that failed keeps the last good list; the banner says so.
            <div className="mb-1 flex items-center gap-2 rounded-lg bg-[var(--status-error-background)] px-2.5 py-1.5 typography-meta text-[var(--status-error-text)]">
              <span className="min-w-0 flex-1 break-words">{t('references.picker.error.refresh', { error: listError })}</span>
              <Button size="xs" variant="ghost" onClick={onRetry}>{t('references.picker.actions.retry')}</Button>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            {issues.length === 0 ? (
              <p className="px-1 py-4 text-center typography-meta text-muted-foreground">{t('issuesPanel.empty')}</p>
            ) : null}
            {issues.map((issue) => {
              const look = repositoryStateLook(issue, null);
              const selected = openIssueNumber === issue.number;
              return (
                <button
                  key={issue.number}
                  type="button"
                  data-knowledge-entry-id={String(issue.number)}
                  onClick={() => onOpenIssue(selected ? null : issue.number)}
                  aria-current={selected ? 'true' : undefined}
                  aria-label={`${referenceNumberLabel(issue, descriptor)}: ${issue.title}`}
                  className={cn(
                    'w-full rounded-lg border border-border/60 bg-surface-elevated px-2.5 py-2 text-start transition-colors',
                    'hover:border-[var(--interactive-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected && 'border-[var(--interactive-selection)] bg-interactive-selection/40',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: look.color }} />
                    <span className="typography-micro text-muted-foreground/60">{referenceNumberLabel(issue, descriptor)}</span>
                    <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground" title={issue.title}>{issue.title}</span>
                  </span>
                  {milestoneName ? (
                    <span className="mt-1 flex ps-4">
                      <span className="rounded-full bg-interactive-selection/15 px-1.5 typography-micro text-interactive-selection-foreground/80">{milestoneName}</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

type IssueDetailProps = {
  issue: Issue;
  comments: IssueComment[];
  milestoneName: string | null;
  providerLabel: string;
  showBack: boolean;
  onAttach: () => void;
  onOpenOnHost: () => void;
  onClose: () => void;
};

/** The full issue in place: complete body, full comment thread, milestone, labels, state and author. */
const IssueDetail: React.FC<IssueDetailProps> = ({ issue, comments, milestoneName, providerLabel, showBack, onAttach, onOpenOnHost, onClose }) => {
  const { t } = useI18n();
  const labelChips = (issue.labels ?? []).map((label) => {
    const color = labelColor(label.color);
    return (
      <span
        key={label.name}
        className="rounded-full border border-border/60 px-2 typography-micro"
        style={color ? { backgroundColor: `${color}22` } : undefined}
      >
        {label.name}
      </span>
    );
  });

  return (
    <KnowledgeEntryView
      backLabel={t('issuesPanel.back')}
      showBack={showBack}
      meta={(
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="typography-micro text-muted-foreground/60">#{issue.number}</span>
            <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground" title={issue.title}>{issue.title}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 typography-micro text-muted-foreground">
            <span>{issue.state === 'open' ? t('issuesPanel.detail.state.open') : t('issuesPanel.detail.state.closed')}</span>
            {issue.author ? <span>{t('issuesPanel.detail.author')}: {issue.author.username}</span> : null}
            {milestoneName ? <span>{t('issuesPanel.detail.milestone')}: {milestoneName}</span> : null}
          </div>
        </div>
      )}
      actions={(
        <>
          <Button size="sm" variant="outline" onClick={onAttach}>{t('issuesPanel.actions.attach')}</Button>
          <Button size="sm" variant="ghost" onClick={onOpenOnHost}>{t('issuesPanel.actions.openOnHost', { provider: providerLabel })}</Button>
        </>
      )}
      onClose={onClose}
    >
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-4 pb-3">
          {labelChips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">{labelChips}</div>
          ) : null}

          {issue.body ? (
            <SimpleMarkdownRenderer content={issue.body} className="markdown-content" enableFileReferences={false} />
          ) : null}

          {comments.length > 0 ? (
            <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
              {comments.map((comment) => (
                <div key={comment.id} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 typography-micro text-muted-foreground">
                    <span className="font-medium text-foreground/80">{comment.author?.username ?? '?'}</span>
                    {comment.createdAt ? <span>{new Date(comment.createdAt).toLocaleDateString()}</span> : null}
                  </div>
                  <SimpleMarkdownRenderer content={comment.body} className="markdown-content typography-meta" enableFileReferences={false} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </KnowledgeEntryView>
  );
};
