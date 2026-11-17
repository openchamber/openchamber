import React from 'react';
import { useI18n } from '@/lib/i18n';
import { getLinkedSidebarChanges, getLinkedSidebarIssues, type LinkedSidebarChange, type LinkedSidebarIssue } from '@/lib/linkedIssues';
import type { Session } from '@/lib/opencode/model';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { repositoryThread, workItem } from '@/lib/trackedItems/fromLinks';
import { useFreshestSourceControlVisualSummaryForBranch, type PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useTrackedIssueStates, useTrackedPullVisualSummaries, useTrackedWorkItemStates } from '@/stores/useTrackedItemsStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { getPrStatusLabel } from '../prStatusLabel';
import { resolveSessionPrLookup } from './sessionNodeItemUtils';
import { buildSessionIssueItems, combineSessionPrSummaries, findLinkedPrsWithoutState } from './sessionPrSummaries';
import type { SidebarRefLink } from './SidebarRefLinks';

const EMPTY_LINKED_SIDEBAR_ISSUES: readonly LinkedSidebarIssue[] = [];
const EMPTY_LINKED_SIDEBAR_CHANGES: readonly LinkedSidebarChange[] = [];

export type SessionRefLine = SidebarRefLink;

export function useSessionRefLines(session: Session, worktree: WorktreeMetadata | null | undefined, isVSCode: boolean) {
  const { t } = useI18n();
  const prLookup = React.useMemo(
    () => resolveSessionPrLookup(worktree, isVSCode),
    [isVSCode, worktree],
  );
  const branchPrSummary = useFreshestSourceControlVisualSummaryForBranch(prLookup?.directory ?? null, prLookup?.branch ?? null);
  const urlMatcher = useRepositoryUrlMatcher();
  const linkedChanges = React.useMemo(
    () => (isVSCode ? EMPTY_LINKED_SIDEBAR_CHANGES : getLinkedSidebarChanges(session, urlMatcher)),
    [isVSCode, session, urlMatcher],
  );
  const repositoryChangeLinks = React.useMemo(
    () => linkedChanges.flatMap((change) => (change.repository ? [{ item: repositoryThread('pull', change.repository), url: change.url, title: change.title }] : [])),
    [linkedChanges],
  );
  const repositoryChangeVisuals = useTrackedPullVisualSummaries(repositoryChangeLinks);
  const prSummaries = React.useMemo(
    () => combineSessionPrSummaries(
      branchPrSummary,
      repositoryChangeVisuals.filter((summary): summary is PrVisualSummary => summary !== null),
    ),
    [branchPrSummary, repositoryChangeVisuals],
  );
  const linkedPrsWithoutState = React.useMemo(
    () => findLinkedPrsWithoutState(linkedChanges, prSummaries),
    [linkedChanges, prSummaries],
  );
  const uncolouredChanges = React.useMemo(() => linkedChanges.filter((change) => !change.repository), [linkedChanges]);
  const branchPrIconColor = branchPrSummary ? `var(--pr-${branchPrSummary.visualState})` : undefined;
  const linkedIssues = React.useMemo(
    () => (isVSCode ? EMPTY_LINKED_SIDEBAR_ISSUES : getLinkedSidebarIssues(session, urlMatcher)),
    [isVSCode, session, urlMatcher],
  );
  const repositoryIssueItems = React.useMemo(
    () => linkedIssues.flatMap((issue) => (issue.source === 'repository' ? [repositoryThread(issue.ref.thread, issue.ref)] : [])),
    [linkedIssues],
  );
  const repositoryIssueStates = useTrackedIssueStates(repositoryIssueItems);
  const linkedWorkItems = React.useMemo(
    () => linkedIssues.flatMap((issue) => (issue.source === 'tracker' ? [workItem(issue.provider, issue.identifier)] : [])),
    [linkedIssues],
  );
  const linkedWorkItemStates = useTrackedWorkItemStates(linkedWorkItems);
  const refLines = React.useMemo((): SessionRefLine[] => {
    if (prSummaries.length > 0 || linkedPrsWithoutState.length > 0 || uncolouredChanges.length > 0) {
      const summaryLines = prSummaries.map((summary): SessionRefLine => {
        const descriptor = urlMatcher.descriptorOf(summary.provider ?? '');
        const label = getPrStatusLabel(summary, descriptor.terminology.changeRequest, t);
        const reference = formatChangeRequestReference(descriptor, summary.number);
        return {
          key: `${summary.provider ?? ''}:${summary.repo?.owner ?? ''}/${summary.repo?.repo ?? ''}#${summary.number}`,
          icon: 'git-pull-request',
          label: reference,
          color: `var(--pr-${summary.visualState})`,
          url: summary.url,
          title: summary.title,
          status: label,
          text: label ? `${reference} · ${label}` : reference,
        };
      });
      const otherLines = [...linkedPrsWithoutState, ...uncolouredChanges].map((change): SessionRefLine => ({
        key: change.key,
        icon: 'git-pull-request',
        label: change.identifier,
        url: change.url,
        title: change.title,
        text: change.identifier,
      }));
      return [...summaryLines, ...otherLines];
    }
    return buildSessionIssueItems(linkedIssues, repositoryIssueStates, linkedWorkItemStates).map((item) => ({
      key: item.key,
      icon: item.icon,
      label: item.label,
      color: item.color ?? undefined,
      url: item.url,
      title: item.title,
      status: item.statusKey ? t(item.statusKey) : item.statusText,
      text: item.statusKey ? `${item.label} · ${t(item.statusKey)}` : item.statusText ? `${item.label} · ${item.statusText}` : item.label,
    }));
  }, [linkedIssues, linkedWorkItemStates, linkedPrsWithoutState, prSummaries, repositoryIssueStates, t, uncolouredChanges, urlMatcher]);
  return { refLines, branchPrIconColor };
}
