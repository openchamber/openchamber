import React from 'react';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { useI18n } from '@/lib/i18n';
import { useAllLiveSessions, useAllSessionStatuses, useDirectorySync } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
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
  const isMobile = useUIStore((state) => state.isMobile);
  const providers = useConfigStore((state) => state.providers);

  const liveSessions = useAllLiveSessions();
  const statuses = useAllSessionStatuses();
  const children = React.useMemo(
    () => (sessionId ? liveSessions.filter((candidate) => candidate.parentID === sessionId) : []),
    [liveSessions, sessionId],
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
  // The last turn's outcome outlives the live status: a child that went idle
  // after an error reads as failed, not done. Joined to a string so the
  // selector stays stable while nothing about these children changes.
  const failedChildIds = useGlobalSessionStatusStore(React.useCallback((state) => children
    .filter((child) => state.observedById.get(child.id)?.outcome === 'failed')
    .map((child) => child.id)
    .join('\n'), [children]));

  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
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

  // Same branch the transcript's Task tool takes: surfaces that cannot host an
  // embedded panel navigate to the child session instead of opening a tab.
  const openChildSession = React.useCallback((childId: string, label: string) => {
    if (!directory) return;
    if (isEmbeddedSessionChat() || isMobile || isVSCodeRuntime()) {
      setCurrentSession(childId, directory);
      return;
    }
    openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: `session:${childId}`,
      label,
      readOnly: true,
    });
  }, [directory, isMobile, openContextPanelTab, setCurrentSession]);

  useReportWorkStatusPresence('subagents', children.length > 0);

  if (children.length === 0) return null;

  const failedIds = new Set(failedChildIds.split('\n'));
  const rows = children.map((child) => {
    const blocked = (permissions[child.id]?.length ?? 0) > 0;
    const asked = (forms[child.id]?.length ?? 0) > 0;
    const status = statuses[child.id]?.type;
    const busy = status === 'busy' || status === 'retry';
    const failed = !busy && failedIds.has(child.id);
    const done = !failed && (status === 'idle' || (!status && statusReady && child.directory === directory));
    return { child, blocked, asked, busy, failed, done, finished: !blocked && !asked && (done || failed) };
  });
  // Newest first by creation, never by last activity: an activity order
  // reshuffled the rows on every step, moving them under the pointer. Finished
  // rows sink below the unfinished ones but keep the same order among
  // themselves, so a fully finished list reads exactly as it did at launch.
  rows.sort((left, right) => (Number(left.finished) - Number(right.finished))
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
              // The smaller status glyph sits centred in the panel's 16px icon
              // slot, so it lines up under the section icon and the label
              // starts where every other row's does.
              leading={(
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <Icon name={icon} className="size-3.5" style={iconColor ? { color: iconColor } : undefined} />
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
