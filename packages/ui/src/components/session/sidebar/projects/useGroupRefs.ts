import React from 'react';
import { useI18n } from '@/lib/i18n';
import { getLinkedSidebarIssues, type LinkedSidebarIssue } from '@/lib/linkedIssues';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { repositoryThread, workItem } from '@/lib/trackedItems/fromLinks';
import { useFreshestSourceControlVisualSummaryForBranch } from '@/stores/useGitHubPrStatusStore';
import { useTrackedIssueStates, useTrackedWorkItemStates } from '@/stores/useTrackedItemsStore';
import type { Session } from '@/lib/opencode/model';
import { getPrStatusLabel } from '../prStatusLabel';
import { buildSessionIssueItems } from '../sessions/sessionPrSummaries';
import type { SidebarRefLink } from '../sessions/SidebarRefLinks';
import type { SessionGroup } from '../types';
import { normalizePath } from '../utils';

const EMPTY_GROUP_ISSUES: readonly LinkedSidebarIssue[] = [];

/**
 * What a worktree or space row follows: its branch's change request, or
 * while there is none the issues its sessions work on (a worktree started
 * from an issue links it to its session, not to itself).
 */
export const useGroupRefs = (group: SessionGroup, sessions: readonly Session[], enabled: boolean) => {
  const { t } = useI18n();
  const urlMatcher = useRepositoryUrlMatcher();
  const prDirectory = enabled && !group.isMain && !group.isArchivedBucket ? normalizePath(group.directory ?? null) : null;
  const prBranch = prDirectory ? group.branch?.trim() || null : null;
  const prSummary = useFreshestSourceControlVisualSummaryForBranch(prDirectory, prBranch);
  const prColor = prSummary ? `var(--pr-${prSummary.visualState})` : undefined;
  const prDescriptor = urlMatcher.descriptorOf(prSummary?.provider ?? '');
  const prStatusLabel = getPrStatusLabel(prSummary, prDescriptor.terminology.changeRequest, t);
  const prReference = prSummary ? formatChangeRequestReference(prDescriptor, prSummary.number) : '';
  const prLabel = prSummary
    ? (prStatusLabel ? `${prReference} · ${prStatusLabel}` : prReference)
    : undefined;

  const issues = React.useMemo(() => {
    if (!enabled || prSummary || group.isMain || group.isArchivedBucket) return EMPTY_GROUP_ISSUES;
    const byKey = new Map<string, LinkedSidebarIssue>();
    for (const session of sessions) {
      for (const issue of getLinkedSidebarIssues(session, urlMatcher)) {
        if (!byKey.has(issue.key)) byKey.set(issue.key, issue);
      }
    }
    return byKey.size > 0 ? [...byKey.values()] : EMPTY_GROUP_ISSUES;
  }, [enabled, group.isArchivedBucket, group.isMain, prSummary, sessions, urlMatcher]);
  const repositoryIssueItems = React.useMemo(
    () => issues.flatMap((issue) => (issue.source === 'repository' ? [repositoryThread(issue.ref.thread, issue.ref)] : [])),
    [issues],
  );
  const issueStates = useTrackedIssueStates(repositoryIssueItems);
  const trackerItems = React.useMemo(
    () => issues.flatMap((issue) => (issue.source === 'tracker' ? [workItem(issue.provider, issue.identifier)] : [])),
    [issues],
  );
  const trackerStates = useTrackedWorkItemStates(trackerItems);
  const issueItems = React.useMemo(
    () => buildSessionIssueItems(issues, issueStates, trackerStates).map((item) => ({
      ...item,
      text: item.statusKey ? `${item.label} · ${t(item.statusKey)}` : item.statusText ? `${item.label} · ${item.statusText}` : item.label,
    })),
    [issueStates, issues, t, trackerStates],
  );
  const prLinks: SidebarRefLink[] = prSummary && prStatusLabel ? [{
    key: `pr:${prSummary.number}`,
    icon: 'git-pull-request',
    text: `${prReference} · ${prStatusLabel}`,
    title: prSummary.title,
    color: prColor,
    url: prSummary.url,
  }] : [];

  return {
    prSummary,
    prColor,
    prStatusLabel,
    prReference,
    prLabel,
    prLinks,
    issueItems,
    primaryIssue: issueItems[0] ?? null,
  };
};
