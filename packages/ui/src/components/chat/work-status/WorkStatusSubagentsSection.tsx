import React from 'react';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { useI18n } from '@/lib/i18n';
import { useAllLiveSessions, useAllSessionStatuses, useDirectorySync } from '@/sync/sync-context';
import { useSessionWorkflowRuns } from '@/lib/workflows/store';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { normalizePath } from '@/lib/pathNormalization';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { useOpenChildSession } from './useOpenChildSession';
import { formatCost } from './subagentCost';
import { computeRollup } from './useSubagentCostRollup';
import type { State } from '@/sync/types';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const SECTION_ID = 'subagents';

const SubagentDuration: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const hasDuration = useHasSessionActivityDuration(sessionId, true);
  return hasDuration ? <SessionActivityDuration sessionId={sessionId} running /> : null;
};

/**
 * Running subagents and, more importantly, their blockers: a permission request
 * raised by a child session has no representation in the transcript, so this
 * panel is the only place it becomes visible.
 */
export const WorkStatusSubagentsSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);

  const liveSessions = useAllLiveSessions();
  const statuses = useAllSessionStatuses();
  // A workflow's agents are child sessions too; the Workflows section lists
  // them under their run, so they stay out of this list.
  const workflowRuns = useSessionWorkflowRuns(sessionId);
  const workflowAgentIds = React.useMemo(
    () => new Set(workflowRuns.flatMap((run) => run.agents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : [])))),
    [workflowRuns],
  );
  const children = React.useMemo(
    () => (sessionId ? liveSessions.filter((candidate) => candidate.parentID === sessionId && !workflowAgentIds.has(candidate.id)) : []),
    [liveSessions, sessionId, workflowAgentIds],
  );

  // Each child's own subtree total (its cost plus every descendant of its
  // own), so nested subagent-of-subagent cost rolls up under the immediate
  // child row shown here rather than disappearing. Computed from the list
  // already held: the hook would open a second live-session subscription.
  const { perChildCost } = React.useMemo(() => computeRollup(liveSessions, sessionId), [liveSessions, sessionId]);

  // One subscription covers every child: per-session hooks would multiply
  // store subscriptions by the number of subagents.
  const permissions = useDirectorySync(React.useCallback((state: State) => state.permission, []));
  const forms = useDirectorySync(React.useCallback((state: State) => state.form, []));
  const statusReady = useDirectorySync(
    React.useCallback((state: State) => state.sessionStatusReady, []),
    directory ?? undefined,
  );
  const statusInvalidated = useDirectorySync(
    React.useCallback((state: State) => state.sessionStatusInvalidated, []),
    directory ?? undefined,
  );
  // Every status event reaches the global store, whichever directory owns the
  // child, so a child seen going busy and then settling is known to be idle
  // even when the directory snapshot does not cover it. The last turn's
  // outcome outlives the live status: a child that went idle after an error
  // reads as failed, not done. Joined to a string so the selector stays
  // stable while nothing about these children changes.
  const observedChildren = useGlobalSessionStatusStore(React.useCallback((state) => children
    .flatMap((child) => {
      if (state.statusById.has(child.id)) return [`${child.id}\tbusy`];
      const observed = state.observedById.get(child.id);
      return observed ? [`${child.id}\t${observed.outcome === 'failed' ? 'failed' : 'settled'}`] : [];
    })
    .join('\n'), [children]));

  const setSectionExpanded = useUIStore((state) => state.setWorkStatusSectionExpanded);

  // Subagents appearing where there were none is the one moment this section
  // has something urgent to say, so it opens itself. Only on the empty→present
  // edge: re-expanding on every count change would fight a user who just
  // collapsed it.
  const hadChildren = React.useRef(children.length > 0);
  React.useEffect(() => {
    const present = children.length > 0;
    if (present && !hadChildren.current) setSectionExpanded(SECTION_ID, true);
    hadChildren.current = present;
  }, [children.length, setSectionExpanded]);

  const openChildSession = useOpenChildSession(directory);

  useReportWorkStatusPresence('subagents', children.length > 0);

  if (children.length === 0) return null;

  const observedById = new Map<string, string>();
  for (const line of observedChildren.split('\n')) {
    const [id, observed] = line.split('\t');
    if (id && observed) observedById.set(id, observed);
  }
  const panelDirectory = normalizePath(directory);
  const panelSpaceId = spaceIdOfDirectory(panelDirectory);
  const rows = children.map((child) => {
    const blocked = (permissions[child.id]?.length ?? 0) > 0;
    const asked = (forms[child.id]?.length ?? 0) > 0;
    const status = statuses[child.id]?.type;
    const observed = observedById.get(child.id);
    const busy = status === 'busy' || status === 'retry' || (!status && observed === 'busy');
    const failed = !busy && observed === 'failed';
    // The snapshot is the server's list of running sessions: the host's for
    // every host directory, a space's own for that space. So it also speaks
    // for a child that moved to another worktree, never across that boundary.
    const snapshotCovers = statusReady === true && !statusInvalidated?.[child.id]
      && panelDirectory !== null && spaceIdOfDirectory(normalizePath(child.directory)) === panelSpaceId;
    const done = !failed && !busy && (status === 'idle' || (!status && (snapshotCovers || observed === 'settled')));
    const finished = !blocked && !asked && (done || failed);
    // Blockers first, then running rows, then rows whose status is not known
    // yet, then finished ones: an unknown row must not push a working one down.
    const rank = blocked || asked ? 0 : busy ? 1 : finished ? 3 : 2;
    return { child, blocked, asked, busy, failed, done, rank };
  });
  // Newest first by creation within each rank, never by last activity: an
  // activity order reshuffled the rows on every step, moving them under the
  // pointer. A fully finished list reads exactly as it did at launch.
  rows.sort((left, right) => (left.rank - right.rank)
    || ((right.child.time?.created ?? 0) - (left.child.time?.created ?? 0)));

  const busyChildren = rows.filter((row) => row.busy).length;

  return (
    <WorkStatusCollapsibleSection
      id={SECTION_ID}
      title={t('chat.workStatus.section.subagents')}
      icon="ai-agent"
      defaultExpanded
      summary={busyChildren > 0 ? `${busyChildren}/${children.length}` : children.length}
    >
      <div className="max-h-56 overflow-y-auto">
        {rows.map(({ child, blocked, asked, busy, failed, done }) => {
          const label = child.title?.trim() || t('chat.workStatus.subagent.untitled');
          let icon: IconName = 'time';
          let iconColor: string | undefined;
          let statusLabel = '';
          if (blocked || asked) {
            icon = 'alert';
            iconColor = 'var(--status-warning)';
            statusLabel = t(blocked ? 'chat.workStatus.subagent.needsPermission' : 'chat.workStatus.subagent.askedQuestion');
          } else if (busy) {
            icon = 'record-circle';
            iconColor = 'var(--status-info)';
            statusLabel = t('chat.workStatus.subagent.working');
          } else if (failed) {
            icon = 'close-circle';
            iconColor = 'var(--status-error)';
            statusLabel = t('chat.workStatus.subagent.failed');
          } else if (done) {
            icon = 'checkbox-circle';
            iconColor = 'var(--status-success)';
            statusLabel = t('chat.workStatus.subagent.done');
          }
          const childCost = perChildCost.get(child.id) ?? 0;
          const modelName = getProviderModelDisplayName(
            providers.find((provider) => provider.id === child.model?.providerID),
            child.model?.id,
          );
          return (
            <WorkStatusRow
              key={child.id}
              onClick={directory ? () => openChildSession(child.id, label) : undefined}
              ariaLabel={[t('chat.workStatus.action.openSubagent', { name: label }), statusLabel].filter(Boolean).join('. ')}
              // The smaller status glyph sits centred in the panel's 14px icon
              // slot, so it lines up under the section icon and the label
              // starts where every other row's does.
              leading={(
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  <Icon name={icon} className="size-3" style={iconColor ? { color: iconColor } : undefined} />
                </span>
              )}
              label={label}
              tooltip={modelName || undefined}
              value={(
                <>
                  {blocked ? (
                    <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.needsPermission')}</WorkStatusValue>
                  ) : asked ? (
                    <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.askedQuestion')}</WorkStatusValue>
                  ) : busy ? <SubagentDuration sessionId={child.id} /> : null}
                  {childCost > 0 ? <WorkStatusValue tone="muted">{formatCost(childCost)}</WorkStatusValue> : null}
                </>
              )}
            />
          );
        })}
      </div>
    </WorkStatusCollapsibleSection>
  );
};
