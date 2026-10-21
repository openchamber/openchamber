import React from 'react';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { FILE_TREE_INDENT_PX } from '@/components/views/files/fileTreeRow';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { useAllLiveSessions, useAllSessionStatuses, useDirectorySync } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { normalizePath } from '@/lib/pathNormalization';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { buildChildrenIndex, formatCost } from './subagentCost';
import type { State } from '@/sync/types';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

/** A subagent and, nested under it, the subagents it launched. */
type SubagentNode = {
  session: Session;
  /** 0 for a subagent the viewed session launched, one more per level below. */
  depth: number;
  /** The subagent and every subagent below it, which its row speaks for. */
  subtreeIds: string[];
  /** What the subagent and every subagent below it cost. */
  cost: number;
  children: SubagentNode[];
};

const SECTION_ID = 'subagents';

const SubagentDuration: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const hasDuration = useHasSessionActivityDuration(sessionId, true);
  return hasDuration ? <SessionActivityDuration sessionId={sessionId} running /> : null;
};

/**
 * Running subagents and, more importantly, their blockers: a permission request
 * raised by a subagent at any level has no representation in the viewed
 * transcript, so this panel is the only place it becomes visible there. Every
 * subagent has a row, nested under the subagent that launched it, and each row
 * speaks for its subagent and everything that one launched.
 */
export const WorkStatusSubagentsSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const providers = useConfigStore((state) => state.providers);

  const liveSessions = useAllLiveSessions();
  const statuses = useAllSessionStatuses();
  // Built from the list already held, costs included: a cost hook would open
  // a second live-session subscription.
  const tree = React.useMemo(() => buildSubagentTree(liveSessions, sessionId), [liveSessions, sessionId]);
  const subagentIds = React.useMemo(() => tree.flatMap((node) => node.subtreeIds), [tree]);

  // One subscription covers every subagent: per-session hooks would multiply
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
  // subagent, so one seen going busy and then settling is known to be idle
  // even when the directory snapshot does not cover it. The last turn's
  // outcome outlives the live status: a subagent that went idle after an error
  // reads as failed, not done. Joined to a string so the selector stays stable
  // while nothing about these sessions changes.
  const observedSubagents = useGlobalSessionStatusStore(React.useCallback((state) => subagentIds
    .flatMap((id) => {
      if (state.statusById.has(id)) return [`${id}\tbusy`];
      const observed = state.observedById.get(id);
      return observed ? [`${id}\t${observed.outcome === 'failed' ? 'failed' : 'settled'}`] : [];
    })
    .join('\n'), [subagentIds]));

  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setSectionExpanded = useUIStore((state) => state.setWorkStatusSectionExpanded);

  // Subagents appearing where there were none is the one moment this section
  // has something urgent to say, so it opens itself. Only on the empty→present
  // edge: re-expanding on every count change would fight a user who just
  // collapsed it.
  const hadSubagents = React.useRef(tree.length > 0);
  React.useEffect(() => {
    const present = tree.length > 0;
    if (present && !hadSubagents.current) setSectionExpanded(SECTION_ID, true);
    hadSubagents.current = present;
  }, [tree.length, setSectionExpanded]);

  // Same branch the transcript's Task tool takes: surfaces that cannot host an
  // side panel navigate to the subagent's session instead of opening a tab.
  const openSubagentSession = React.useCallback((subagentId: string, label: string) => {
    if (!directory) return;
    if (isMobile || isVSCodeRuntime()) {
      setCurrentSession(subagentId, directory);
      return;
    }
    openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: `session:${subagentId}`,
      label,
      readOnly: true,
    });
  }, [directory, isMobile, openContextPanelTab, setCurrentSession]);

  useReportWorkStatusPresence('subagents', tree.length > 0);

  if (tree.length === 0) return null;

  const observedById = new Map<string, string>();
  for (const line of observedSubagents.split('\n')) {
    const [id, observed] = line.split('\t');
    if (id && observed) observedById.set(id, observed);
  }
  const panelDirectory = normalizePath(directory);
  // A session runs while its live status or the global store says so. The
  // global store can learn of a busy turn before the directory snapshot does,
  // so a busy report outranks an idle one, as in `getSessionLiveActivity`. The
  // same test covers the subagent and everything it launched.
  const isRunning = (id: string): boolean => {
    const type = statuses[id]?.type;
    return type === 'busy' || type === 'retry' || observedById.get(id) === 'busy';
  };
  const describeNode = (node: SubagentNode) => {
    const session = node.session;
    const blocked = node.subtreeIds.some((id) => (permissions[id]?.length ?? 0) > 0);
    const asked = node.subtreeIds.some((id) => (forms[id]?.length ?? 0) > 0);
    const status = statuses[session.id]?.type;
    const observed = observedById.get(session.id);
    const busy = node.subtreeIds.some(isRunning);
    const failed = !busy && observed === 'failed';
    // The snapshot only speaks for its own directory. Paths are compared
    // normalized: OpenCode may report a subagent's directory with a trailing
    // slash or Windows separators the panel's directory does not have.
    const snapshotCovers = statusReady === true && !statusInvalidated?.[session.id]
      && panelDirectory !== null && normalizePath(session.directory) === panelDirectory;
    const done = !failed && !busy && (status === 'idle' || (!status && (snapshotCovers || observed === 'settled')));
    const finished = !blocked && !asked && (done || failed);
    // Blockers first, then running rows, then rows whose status is not known
    // yet, then finished ones: an unknown row must not push a working one down.
    const rank = blocked || asked ? 0 : busy ? 1 : finished ? 3 : 2;
    return { node, blocked, asked, busy, failed, done, rank };
  };
  // Newest first by creation within each rank, never by last activity: an
  // activity order reshuffled the rows on every step, moving them under the
  // pointer. A fully finished list reads exactly as it did at launch. Siblings
  // are ordered at every level, and a subagent's own subagents follow it.
  const orderRows = (nodes: SubagentNode[]): Array<ReturnType<typeof describeNode>> => nodes
    .map(describeNode)
    .sort((left, right) => (left.rank - right.rank)
      || ((right.node.session.time?.created ?? 0) - (left.node.session.time?.created ?? 0)))
    .flatMap((row) => [row, ...orderRows(row.node.children)]);
  const rows = orderRows(tree);

  const busyRows = rows.filter((row) => row.busy).length;

  return (
    <WorkStatusCollapsibleSection
      id={SECTION_ID}
      title={t('chat.workStatus.section.subagents')}
      icon="ai-agent"
      defaultExpanded
      summary={busyRows > 0 ? `${busyRows}/${rows.length}` : rows.length}
    >
      <div className="max-h-56 overflow-y-auto">
        {rows.map(({ node, blocked, asked, busy, failed, done }) => {
          const session = node.session;
          const label = session.title?.trim() || t('chat.workStatus.subagent.untitled');
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
          const modelName = getProviderModelDisplayName(
            providers.find((provider) => provider.id === session.model?.providerID),
            session.model?.id,
          );
          return (
            // One tree step per level, as the sidebar's session tree indents.
            <div key={session.id} style={{ paddingInlineStart: `${node.depth * FILE_TREE_INDENT_PX}px` }}>
              <WorkStatusRow
                onClick={directory ? () => openSubagentSession(session.id, label) : undefined}
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
                // The title leads, since the row cuts a long one off.
                tooltip={modelName ? (
                  <>
                    <p className="font-medium">{label}</p>
                    <p>{modelName}</p>
                  </>
                ) : undefined}
                value={(
                  <>
                    {blocked ? (
                      <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.needsPermission')}</WorkStatusValue>
                    ) : asked ? (
                      <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.askedQuestion')}</WorkStatusValue>
                    ) : busy ? <SubagentDuration sessionId={session.id} /> : null}
                    {node.cost > 0 ? <WorkStatusValue tone="muted">{formatCost(node.cost)}</WorkStatusValue> : null}
                  </>
                )}
              />
            </div>
          );
        })}
      </div>
    </WorkStatusCollapsibleSection>
  );
};

/** Every subagent below `rootId`, each nested under the subagent that launched it. */
const buildSubagentTree = (sessions: Session[], rootId: string | null): SubagentNode[] => {
  if (!rootId) return [];
  const childrenByParent = buildChildrenIndex(sessions);
  // A malformed parent cycle must not place a session twice.
  const placed = new Set([rootId]);
  const launchedBy = (parentId: string, depth: number): SubagentNode[] => (childrenByParent.get(parentId) ?? [])
    .flatMap((session) => {
      if (placed.has(session.id)) return [];
      placed.add(session.id);
      const children = launchedBy(session.id, depth + 1);
      return [{
        session,
        depth,
        subtreeIds: [session.id, ...children.flatMap((child) => child.subtreeIds)],
        cost: (session.cost ?? 0) + children.reduce((sum, child) => sum + child.cost, 0),
        children,
      }];
    });
  return launchedBy(rootId, 0);
};
