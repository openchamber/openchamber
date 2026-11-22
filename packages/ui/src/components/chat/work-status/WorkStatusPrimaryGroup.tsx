import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { useFreshestSourceControlVisualSummaryForBranch } from '@/stores/useGitHubPrStatusStore';
import { useSessionMessages } from '@/sync/sync-context';
import { useContextWindowLimits } from '@/hooks/useContextWindowLimits';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useSpaceProjectDirectory } from '@/lib/spaces/spaces-store';
import { useSpaceNameOf } from '@/lib/spaces/space-mark';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveUsageTone } from '@/lib/quota';
import { sessionEvents } from '@/lib/sessionEvents';
import { normalizePath } from '@/lib/pathNormalization';
import { computeContextUsage, computeLastReplyCacheHit } from './contextUsage';
import { formatCost } from './subagentCost';
import { useSubagentCostRollup } from './useSubagentCostRollup';
import {
  WorkStatusCallout,
  WorkStatusMeter,
  WorkStatusNote,
  WorkStatusPill,
  WorkStatusRow,
  WorkStatusSection,
  WorkStatusValue,
} from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { WorkStatusWarmingToggle } from './WorkStatusWarmingToggle';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { PrChecksValue } from './PrChecksValue';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { useLeaveWorkStatus } from './leaveWorkStatus';
import { prChecksTooltip } from './prChecks';
import { resolvePrRowTarget } from './prRowTarget';
import { isVSCodeRuntime } from '@/lib/desktop';
import { openExternalUrl } from '@/lib/url';
import { DiffCount } from '@/components/ui/diff-count';

type Props = {
  sessionId: string | null;
  directory: string | null;
  goalRow: React.ReactNode;
  showSession: boolean;
  showRepository: boolean;
  children: (sections: { session: React.ReactNode; repository: React.ReactNode }) => React.ReactNode;
};

const formatPercent = (percent: number): string => `${Math.min(percent, 999).toFixed(1)}%`;
const UNKNOWN_PERCENT = '\u2014';

export const WorkStatusPrimaryGroup: React.FC<Props> = ({ sessionId, directory, goalRow, showSession, showRepository, children }) => {
  const { t } = useI18n();
  const mobile = useMobileAppActions();
  const isVSCode = isVSCodeRuntime();
  const leaveWorkStatus = useLeaveWorkStatus();
  const openTrackerItem = useOpenTrackerItem();
  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const clearDiffCache = useGitStore((state) => state.clearDiffCache);

  const draftSpace = useDraftSpaceTarget();
  const repositoryDirectory = sessionId ? directory : panelContentDirectory(draftSpace, directory);
  const { gitDirectory } = useNestedGitDirectory(repositoryDirectory, { enabled: showRepository });

  const gitStatus = useGitStore(
    React.useCallback(
      (state) => (gitDirectory ? state.directories.get(gitDirectory)?.status ?? null : null),
      [gitDirectory],
    ),
  );

  const worktreeCreationPending = useWorktreeBootstrapPending(gitDirectory);
  const [postBootstrapRefreshDirectory, setPostBootstrapRefreshDirectory] = React.useState<string | null>(null);
  const awaitingPostBootstrapStatus = postBootstrapRefreshDirectory !== null
    && postBootstrapRefreshDirectory === gitDirectory;

  React.useEffect(() => {
    if (!showRepository || !gitDirectory || !git) return;
    if (worktreeCreationPending) {
      setPostBootstrapRefreshDirectory(gitDirectory);
      return;
    }
    if (awaitingPostBootstrapStatus) {
      let cancelled = false;
      void runBackgroundNetworkTask(() => fetchStatus(gitDirectory, git, {
        force: true,
        silent: true,
        throwOnError: true,
      }))
        .then(() => {
          if (!cancelled) {
            setPostBootstrapRefreshDirectory((current) => (current === gitDirectory ? null : current));
          }
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    void runBackgroundNetworkTask(() => ensureStatus(gitDirectory, git));
  }, [gitDirectory, git, ensureStatus, fetchStatus, showRepository, worktreeCreationPending, awaitingPostBootstrapStatus]);

  React.useEffect(() => {
    if (!showRepository || !gitDirectory || !git) return;
    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== normalizePath(gitDirectory)) return;
      if (hint.paths?.length) {
        clearDiffCache(gitDirectory, hint.paths);
      }
      void fetchStatus(gitDirectory, git, { silent: true });
    });
  }, [clearDiffCache, gitDirectory, fetchStatus, git, showRepository]);

  const branch = gitStatus?.current?.trim() || null;

  const nestedRepoLabel = React.useMemo(() => {
    if (!repositoryDirectory || !gitDirectory || gitDirectory === repositoryDirectory) return null;
    const rootPrefix = `${repositoryDirectory}/`;
    return gitDirectory.startsWith(rootPrefix) ? gitDirectory.slice(rootPrefix.length) : gitDirectory;
  }, [gitDirectory, repositoryDirectory]);

  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const spaceProjectDirectory = useSpaceProjectDirectory(directory);
  const spaceName = useSpaceNameOf(directory);
  const projectLabel = useProjectsStore(
    React.useCallback((state) => {
      const project = resolveProjectForSessionDirectory(
        state.projects,
        availableWorktreesByProject,
        directory,
        spaceProjectDirectory,
      );
      if (!project) return null;
      return project.label?.trim()
        || project.path.split('/').filter(Boolean).pop()
        || project.path;
    }, [availableWorktreesByProject, directory, spaceProjectDirectory]),
  );

  const prSummary = useFreshestSourceControlVisualSummaryForBranch(gitDirectory, branch);
  const prUrl = prSummary?.url ?? null;
  const prDescriptor = useSourceControlProvider(prSummary?.provider);
  const prTerm = prDescriptor.terminology.changeRequest;

  const sessionMessages = useSessionMessages(sessionId ?? '', directory ?? undefined);
  const { context: contextLimit } = useContextWindowLimits(sessionId, directory ?? undefined);

  const contextUsage = React.useMemo(
    () => computeContextUsage(sessionMessages, contextLimit),
    [sessionMessages, contextLimit],
  );

  const lastReplyCacheHit = React.useMemo(() => computeLastReplyCacheHit(sessionMessages), [sessionMessages]);

  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const openSurface = React.useCallback(
    (mode: 'git' | 'pr') => {
      if (!directory) return;
      if (isVSCode) {
        if (mode === 'pr' && prUrl) void openExternalUrl(prUrl);
        return;
      }
      if (mobile) {
        if (mode === 'git') mobile.openChanges();
        else if (prUrl) {
          openTrackerItem(prUrl, directory);
          leaveWorkStatus?.();
        }
        return;
      }
      if (mode === 'pr') openContextPanelTab(directory, { mode: 'pr' });
      else openContextSurface(directory, mode);
    },
    [directory, isVSCode, leaveWorkStatus, mobile, openContextPanelTab, openContextSurface, openTrackerItem, prUrl],
  );
  const openPr = resolvePrRowTarget({ directory, prUrl, mobile: Boolean(mobile), vscode: isVSCode })
    ? () => openSurface('pr')
    : undefined;
  const openContext = React.useCallback(() => {
    if (directory) openContextOverview(directory);
  }, [directory, openContextOverview]);

  const openChanges = React.useCallback(() => {
    if (!directory) return;
    if (mobile) mobile.openChanges();
    else openContextPanelTab(directory, { mode: 'diff', diffScope: 'working' });
  }, [directory, mobile, openContextPanelTab]);

  const changed = React.useMemo(() => {
    if (worktreeCreationPending || awaitingPostBootstrapStatus) return null;
    const files = gitStatus?.files ?? [];
    if (files.length === 0) return null;
    const stats = gitStatus?.diffStats;
    let additions = 0;
    let deletions = 0;
    if (stats) {
      for (const entry of [...Object.values(stats.staged ?? {}), ...Object.values(stats.working ?? {})]) {
        additions += entry?.insertions ?? 0;
        deletions += entry?.deletions ?? 0;
      }
    }
    return { files: files.length, additions, deletions, hasStats: Boolean(stats) };
  }, [gitStatus?.files, gitStatus?.diffStats, worktreeCreationPending, awaitingPostBootstrapStatus]);

  const attentionReason = gitStatus?.attentionReason
    ?? (gitStatus?.rebaseInProgress ? 'rebase' : null)
    ?? (gitStatus?.mergeInProgress ? 'merge' : null);
  const attentionLabel = attentionReason === 'merge' ? t('chat.workStatus.attention.merge')
    : attentionReason === 'rebase' ? t('chat.workStatus.attention.rebase')
      : attentionReason === 'cherry-pick' ? t('chat.workStatus.attention.cherryPick')
        : attentionReason === 'revert' ? t('chat.workStatus.attention.revert')
          : attentionReason === 'bisect' ? t('chat.workStatus.attention.bisect')
            : null;

  const usagePercent = contextUsage?.state === 'measured' ? contextUsage.percent : null;
  const usageTone = usagePercent === null ? null : resolveUsageTone(Math.round(usagePercent));
  const meterColor = usageTone === 'critical' ? 'var(--status-error)'
    : usageTone === 'warn' ? 'var(--status-warning)'
      : 'var(--muted-foreground)';

  const { totalCost, ownCost, subagentCost, subagentCount } = useSubagentCostRollup(sessionId);
  const cost = totalCost !== null && totalCost > 0 ? totalCost : null;
  const showCostBreakdown = cost !== null && subagentCount > 0 && subagentCost > 0;
  const hasSession = showSession && (contextUsage !== null || cost !== null || Boolean(goalRow));
  const hasRepository = showRepository && Boolean(spaceName || branch || changed || prSummary || attentionLabel);

  useReportWorkStatusPresence('session-repository', hasSession || hasRepository);

  return children({
      session: hasSession ? (
        <WorkStatusSection title={t('chat.workStatus.section.session')} icon="chat-4">
          {contextUsage !== null ? (
            <>
              <WorkStatusRow
                icon="donut-chart"
                onClick={directory && !mobile && !isVSCode ? openContext : undefined}
                ariaLabel={t('chat.workStatus.action.openContext')}
                label={t('chat.workStatus.context.label')}
                value={(
                  <>
                    <WorkStatusWarmingToggle sessionId={sessionId} directory={directory} />
                    <WorkStatusValue>
                      {`${usagePercent !== null ? formatPercent(usagePercent) : UNKNOWN_PERCENT}${cost !== null ? ` · ${formatCost(cost)}` : ''}`}
                    </WorkStatusValue>
                  </>
                )}
              />
              <WorkStatusMeter percent={usagePercent ?? 0} color={meterColor} />
              {contextUsage.state === 'compacted' ? (
                <WorkStatusNote tooltip={t('contextUsage.compacted.description')}>{t('contextUsage.compacted.short')}</WorkStatusNote>
              ) : null}
              {showCostBreakdown ? (
                <WorkStatusNote truncate>
                  {t('chat.workStatus.cost.breakdown', {
                    session: formatCost(ownCost),
                    subagents: formatCost(subagentCost),
                  })}
                </WorkStatusNote>
              ) : null}
            </>
          ) : null}
          {lastReplyCacheHit !== null ? (
            <WorkStatusRow
              icon="database-2"
              label={t('chat.workStatus.replyCacheHit')}
              tooltip={t('chat.workStatus.replyCacheHitDescription')}
              value={<WorkStatusValue>{`${lastReplyCacheHit.toFixed(1)}%`}</WorkStatusValue>}
            />
          ) : null}
          {goalRow}
        </WorkStatusSection>
      ) : null,

      repository: hasRepository ? (
        <WorkStatusSection
          title={t('chat.workStatus.section.project')}
          icon="folder"
          subject={projectLabel}
        >
          {attentionLabel ? <WorkStatusCallout>{attentionLabel}</WorkStatusCallout> : null}

          {spaceName ? <WorkStatusRow icon="instance" label={spaceName} labelDir="auto" tooltip={t('sessions.sidebar.group.space')} /> : null}

          {branch ? (
            <WorkStatusRow
              icon="git-branch"
              onClick={directory && !isVSCode ? () => openSurface('git') : undefined}
              ariaLabel={t('chat.workStatus.action.openGit')}
              label={branch}
              labelDir="ltr"
              value={(gitStatus?.ahead ?? 0) > 0 || (gitStatus?.behind ?? 0) > 0 ? (
                <>
                  {(gitStatus?.ahead ?? 0) > 0
                    ? <WorkStatusValue tone="muted">{`↑${gitStatus?.ahead}`}</WorkStatusValue> : null}
                  {(gitStatus?.behind ?? 0) > 0
                    ? <WorkStatusValue tone="muted">{`↓${gitStatus?.behind}`}</WorkStatusValue> : null}
                </>
              ) : undefined}
            />
          ) : null}

          {nestedRepoLabel ? (
            <WorkStatusRow
              icon="folder"
              onClick={directory && !isVSCode ? () => openSurface('git') : undefined}
              ariaLabel={t('chat.workStatus.action.openGit')}
              label={nestedRepoLabel}
              labelDir="ltr"
              muted
            />
          ) : null}

          {changed ? (
            <WorkStatusRow
              icon="file-edit"
              onClick={directory && !isVSCode ? openChanges : undefined}
              ariaLabel={t('chat.workStatus.action.openChanges')}
              label={changed.files === 1
                ? t('chat.workStatus.git.changedFileSingle', { count: changed.files })
                : t('chat.workStatus.git.changedFilePlural', { count: changed.files })}
              value={changed.hasStats && (changed.additions > 0 || changed.deletions > 0) ? (
                <DiffCount added={changed.additions} removed={changed.deletions} />
              ) : undefined}
            />
          ) : null}

          {prSummary ? (
            <>
              <WorkStatusRow
                icon="git-pull-request"
                onClick={openPr}
                ariaLabel={t(changeRequestCopy('chat.workStatus.action.openPr', prTerm))}
                iconColor={`var(--pr-${prSummary.visualState})`}
                label={prSummary.title ?? t(changeRequestCopy('chat.workStatus.pr.untitled', prTerm))}
                labelDir={prSummary.title ? 'auto' : undefined}
                value={(
                  <WorkStatusPill
                    color={`var(--pr-${prSummary.visualState})`}
                    background={`color-mix(in srgb, var(--pr-${prSummary.visualState}) 18%, transparent)`}
                  >
                    {prSummary.draft ? t('chat.workStatus.pr.draft') : formatChangeRequestReference(prDescriptor, prSummary.number)}
                  </WorkStatusPill>
                )}
              />
              {prSummary.checks && prSummary.checks.total > 0 ? (
                <WorkStatusRow
                  icon="checkbox-circle"
                  onClick={openPr}
                  ariaLabel={t(changeRequestCopy('chat.workStatus.action.openPr', prTerm))}
                  label={t('chat.workStatus.pr.checks')}
                  muted
                  tooltip={prChecksTooltip(prSummary.checks, t)}
                  value={<PrChecksValue checks={prSummary.checks} />}
                />
              ) : null}
            </>
          ) : null}
        </WorkStatusSection>
      ) : null,
  });
};
