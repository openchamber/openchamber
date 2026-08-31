import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useNestedGitDirectory } from '@/hooks/useNestedGitDirectory';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { useFreshestPrVisualSummaryForBranch } from '@/stores/useGitHubPrStatusStore';
import { useSessionMessages } from '@/sync/sync-context';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveUsageTone } from '@/lib/quota';
import { sessionEvents } from '@/lib/sessionEvents';
import { normalizePath } from '@/lib/pathNormalization';
import { computeContextUsage } from './contextUsage';
import { formatCost } from './subagentCost';
import { useSubagentCostRollup } from './useSubagentCostRollup';
import {
  WorkStatusCallout,
  WorkStatusMeter,
  WorkStatusPill,
  WorkStatusRow,
  WorkStatusSection,
  WorkStatusValue,
} from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

type Props = {
  sessionId: string | null;
  directory: string | null;
  /** Rendered first inside the Session section; owns its own dialog. */
  goalRow: React.ReactNode;
  showSession: boolean;
  showRepository: boolean;
};

// Matches the header readout exactly: one decimal, capped the same way, so the
// two places that report context fill never disagree by a rounding step.
const formatPercent = (percent: number): string => `${Math.min(percent, 999).toFixed(1)}%`;

/**
 * The persistent readouts — how full the context is, what the working tree and
 * the pull request look like. All of it stays true for as long as the session
 * is open, so it sits above anything episodic.
 */
export const WorkStatusPrimaryGroup: React.FC<Props> = ({ sessionId, directory, goalRow, showSession, showRepository }) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const clearDiffCache = useGitStore((state) => state.clearDiffCache);

  // The repository the readouts describe. Same resolution as the Git tab: the
  // session directory itself when it is a repository, otherwise the nested
  // repository selected (or auto-selected) for it, so a session in a plain
  // folder of repositories still reports the branch and changes the Git tab
  // shows. Navigation below stays keyed on `directory` — context-panel tabs
  // are per project root.
  const { gitDirectory } = useNestedGitDirectory(directory, { enabled: showRepository });

  const gitStatus = useGitStore(
    React.useCallback(
      (state) => (gitDirectory ? state.directories.get(gitDirectory)?.status ?? null : null),
      [gitDirectory],
    ),
  );

  // Warm the shared git cache through the background-network gate so the panel
  // never competes with the chat's own bootstrap traffic for sockets.
  React.useEffect(() => {
    if (!showRepository || !gitDirectory || !git) return;
    void runBackgroundNetworkTask(() => ensureStatus(gitDirectory, git));
  }, [gitDirectory, git, ensureStatus, showRepository]);

  // Own the live invalidation for the repository readout. The desktop
  // composer's changed-files row no longer renders, so this panel must not
  // depend on ChatInput (or an opened Git surface) to refresh the shared cache
  // on its behalf.
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

  // Which repository under the project the branch belongs to. Only meaningful
  // when the readouts come from a nested repository; for a project that is a
  // repository itself the section header already names it.
  const nestedRepoLabel = React.useMemo(() => {
    if (!directory || !gitDirectory || gitDirectory === directory) return null;
    const rootPrefix = `${directory}/`;
    return gitDirectory.startsWith(rootPrefix) ? gitDirectory.slice(rootPrefix.length) : gitDirectory;
  }, [directory, gitDirectory]);

  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  // Worktrees normally sit beside rather than beneath their project directory,
  // so a prefix match alone cannot find their owning project. Reuse the shared
  // session-directory resolver, which consults the discovered worktree map.
  const projectLabel = useProjectsStore(
    React.useCallback((state) => {
      const project = resolveProjectForSessionDirectory(
        state.projects,
        availableWorktreesByProject,
        directory,
      );
      if (!project) return null;
      return project.label?.trim()
        || project.path.split('/').filter(Boolean).pop()
        || project.path;
    }, [availableWorktreesByProject, directory]),
  );

  // Read-only: PR watching is owned by the background tracker. Starting a watch
  // here would multiply GitHub requests per open session, which is exactly the
  // fan-out the PR-status concurrency gate exists to prevent.
  const prSummary = useFreshestPrVisualSummaryForBranch(gitDirectory, branch);

  // `getCurrentModel` is an imperative getter: its reference never changes, so
  // calling it in render subscribes to nothing. Subscribe to the selected model
  // ids and recompute the limits from those.
  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const sessionMessages = useSessionMessages(sessionId ?? '', directory ?? undefined);

  const contextLimit = React.useMemo(() => {
    const currentModel = getCurrentModel();
    const limit = currentModel && typeof currentModel.limit === 'object' && currentModel.limit !== null
      ? (currentModel.limit as Record<string, unknown>)
      : null;
    return limit && typeof limit.context === 'number' ? limit.context : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getter output tracks the selected model ids
  }, [getCurrentModel, currentProviderId, currentModelId]);

  // Computed from this session's own messages rather than through
  // `useSessionUIStore.getContextUsage`, which reads the *current* directory's
  // store and so loses the readout for any session held elsewhere. See
  // `contextUsage.ts`.
  const contextUsage = React.useMemo(
    () => computeContextUsage(sessionMessages, contextLimit),
    [sessionMessages, contextLimit],
  );

  const openContextSurface = useUIStore((state) => state.openContextSurface);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const openSurface = React.useCallback(
    (mode: 'git' | 'pr') => { if (directory) openContextSurface(directory, mode); },
    [directory, openContextSurface],
  );
  // Working-tree diff without a target path: the panel opens on the whole
  // change set rather than picking a file on the user's behalf.
  // Same destination as the header's context readout.
  const openContext = React.useCallback(() => {
    if (directory) openContextOverview(directory);
  }, [directory, openContextOverview]);

  const openChanges = React.useCallback(() => {
    if (directory) openContextPanelTab(directory, { mode: 'diff', diffScope: 'working' });
  }, [directory, openContextPanelTab]);

  // Working-tree changes, from the same git status the Git panel reads.
  //
  // `Session.summary` looks like the natural source and is not: OpenCode resets
  // it to zeros at the start of every turn and only ever fills per-message
  // `summary.diffs`, so session-level totals are always 0/0/0. The `session.diff`
  // event is reset to an empty array too, and carries real content only on
  // revert. Git status is the one authoritative, already-cached answer.
  const changed = React.useMemo(() => {
    const files = gitStatus?.files ?? [];
    if (files.length === 0) return null;
    const stats = gitStatus?.diffStats;
    let additions = 0;
    let deletions = 0;
    if (stats) {
      for (const entry of Object.values(stats)) {
        additions += entry?.insertions ?? 0;
        deletions += entry?.deletions ?? 0;
      }
    }
    return { files: files.length, additions, deletions, hasStats: Boolean(stats) };
  }, [gitStatus?.files, gitStatus?.diffStats]);

  const attentionReason = gitStatus?.attentionReason
    ?? (gitStatus?.rebaseInProgress ? 'rebase' : null)
    ?? (gitStatus?.mergeInProgress ? 'merge' : null);
  const attentionLabel = attentionReason === 'merge' ? t('chat.workStatus.attention.merge')
    : attentionReason === 'rebase' ? t('chat.workStatus.attention.rebase')
      : attentionReason === 'cherry-pick' ? t('chat.workStatus.attention.cherryPick')
        : attentionReason === 'revert' ? t('chat.workStatus.attention.revert')
          : attentionReason === 'bisect' ? t('chat.workStatus.attention.bisect')
            : null;

  const usagePercent = contextUsage?.percent ?? null;
  // Colour threshold uses the rounded percentage, matching what the header
  // feeds `resolveUsageTone`; the displayed number stays unrounded.
  const usageTone = usagePercent === null ? null : resolveUsageTone(Math.round(usagePercent));
  // Same tone ramp as the header's context icon — healthy is success, not
  // primary, so a full bar reads as a warning rather than as brand colour.
  const meterColor = usageTone === 'critical' ? 'var(--status-error)'
    : usageTone === 'warn' ? 'var(--status-warning)'
      : 'var(--status-success)';

  // Rollup total: own cost plus every descendant subagent's cost, recursively
  // (see useSubagentCostRollup). Shown here instead of session.cost alone, so
  // spend that ran in a spawned subagent doesn't hide from the reader.
  const { totalCost, ownCost, subagentCost, subagentCount } = useSubagentCostRollup(sessionId);
  const cost = totalCost !== null && totalCost > 0 ? totalCost : null;
  // The total answers "what has this cost"; the split answers "why is it more
  // than the session I am looking at". Only worth a line once subagents exist —
  // without them the total *is* the session's own cost and the row would
  // restate the number directly above it.
  const showCostBreakdown = cost !== null && subagentCount > 0 && subagentCost > 0;
  const hasSession = showSession && (usagePercent !== null || cost !== null || Boolean(goalRow));
  const hasRepository = showRepository && Boolean(branch || changed || prSummary || attentionLabel);

  useReportWorkStatusPresence('session-repository', hasSession || hasRepository);

  if (!hasSession && !hasRepository) return null;

  return (
    <>
      {hasSession ? (
        <WorkStatusSection title={t('chat.workStatus.section.session')}>
          {usagePercent !== null ? (
            <>
              <WorkStatusRow
                icon="donut-chart"
                onClick={directory ? openContext : undefined}
                ariaLabel={t('chat.workStatus.action.openContext')}
                label={t('chat.workStatus.context.label')}
                value={(
                  <>
                    <WorkStatusValue>{formatPercent(usagePercent)}</WorkStatusValue>
                    {/* No icon of its own: the sprite has no currency glyph, and
                        spend belongs with consumption anyway. The `$` labels it. */}
                    {cost !== null ? <WorkStatusValue tone="muted">{formatCost(cost)}</WorkStatusValue> : null}
                  </>
                )}
              />
              <WorkStatusMeter percent={usagePercent} color={meterColor} />
              {/* Caption, not a row: it explains the figure above it rather
                  than reporting a reading of its own, so it carries no icon
                  and no label column. */}
              {showCostBreakdown ? (
                <p className="mx-1 mb-1 truncate text-[11px] leading-4 text-muted-foreground tabular-nums">
                  {t('chat.workStatus.cost.breakdown', {
                    session: formatCost(ownCost),
                    subagents: formatCost(subagentCost),
                  })}
                </p>
              ) : null}
            </>
          ) : null}
          {/* Below the context readout: the goal is a standing instruction,
              while context is the live number the reader came for. */}
          {goalRow}
        </WorkStatusSection>
      ) : null}

      {hasRepository ? (
        <WorkStatusSection
          title={t('chat.workStatus.section.project')}
          summary={projectLabel}
        >
          {attentionLabel ? <WorkStatusCallout>{attentionLabel}</WorkStatusCallout> : null}

          {/* Branch first: the changes below are the changes *on it*, and the
              row reads as a caption to the branch rather than a loose number. */}
          {branch ? (
            <WorkStatusRow
              icon="git-branch"
              onClick={directory ? () => openSurface('git') : undefined}
              ariaLabel={t('chat.workStatus.action.openGit')}
              label={branch}
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
              onClick={directory ? () => openSurface('git') : undefined}
              ariaLabel={t('chat.workStatus.action.openGit')}
              label={nestedRepoLabel}
              muted
            />
          ) : null}

          {changed ? (
            <WorkStatusRow
              icon="file-edit"
              onClick={directory ? openChanges : undefined}
              ariaLabel={t('chat.workStatus.action.openChanges')}
              // The count names the row, matching the composer's changed-files
              // bar; the diffstat stays the trailing value.
              label={changed.files === 1
                ? t('chat.workStatus.git.changedFileSingle', { count: changed.files })
                : t('chat.workStatus.git.changedFilePlural', { count: changed.files })}
              value={changed.hasStats && (changed.additions > 0 || changed.deletions > 0) ? (
                <>
                  <WorkStatusValue tone="success">{`+${changed.additions}`}</WorkStatusValue>
                  {/* Neutral separator: colouring it would imply it carries a
                      status of its own. */}
                  <WorkStatusValue tone="muted">/</WorkStatusValue>
                  <WorkStatusValue tone="error">{`−${changed.deletions}`}</WorkStatusValue>
                </>
              ) : undefined}
            />
          ) : null}

          {prSummary ? (
            <>
              <WorkStatusRow
                icon="git-pull-request"
                onClick={directory ? () => openSurface('pr') : undefined}
                ariaLabel={t('chat.workStatus.action.openPr')}
                iconColor={`var(--pr-${prSummary.visualState})`}
                label={prSummary.title ?? t('chat.workStatus.pr.untitled')}
                value={(
                  <WorkStatusPill
                    color={`var(--pr-${prSummary.visualState})`}
                    background={`color-mix(in srgb, var(--pr-${prSummary.visualState}) 18%, transparent)`}
                  >
                    {prSummary.draft ? t('chat.workStatus.pr.draft') : `#${prSummary.number}`}
                  </WorkStatusPill>
                )}
              />
              {prSummary.checks && prSummary.checks.total > 0 ? (
                <WorkStatusRow
                  icon="checkbox-circle"
                  onClick={directory ? () => openSurface('pr') : undefined}
                  ariaLabel={t('chat.workStatus.action.openPr')}
                  label={t('chat.workStatus.pr.checks')}
                  muted
                  value={(
                    <>
                      {prSummary.checks.failure > 0 ? (
                        <WorkStatusValue tone="error">
                          {t('chat.workStatus.pr.checksFailed', { count: prSummary.checks.failure })}
                        </WorkStatusValue>
                      ) : null}
                      {prSummary.checks.pending > 0 ? (
                        <WorkStatusValue tone="warning">
                          {t('chat.workStatus.pr.checksPending', { count: prSummary.checks.pending })}
                        </WorkStatusValue>
                      ) : null}
                      {prSummary.checks.failure === 0 && prSummary.checks.pending === 0 ? (
                        <WorkStatusValue tone="success">
                          {t('chat.workStatus.pr.checksPassed', { count: prSummary.checks.success })}
                        </WorkStatusValue>
                      ) : null}
                    </>
                  )}
                />
              ) : null}
            </>
          ) : null}
        </WorkStatusSection>
      ) : null}
    </>
  );
};
