import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/sync/sync-context';
import { subscribeDirectoryPermission, subscribeDirectoryQuestion } from '@/sync/child-store';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { formatCost } from './subagentCost';
import { useDirectorySubagentCostRollup } from './useSubagentCostRollup';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const SECTION_ID = 'subagents';

type DirectoryStore = ReturnType<typeof useDirectoryStore>;

type SubagentChildrenSnapshot = {
  children: Session[];
  busyById: Record<string, boolean>;
};

const EMPTY_SUBAGENT_CHILDREN: SubagentChildrenSnapshot = { children: [], busyById: {} };

const childCreatedAt = (session: Session): number => session.time?.created ?? 0;

/**
 * Equal when the same children are shown with the same labels and busy state.
 * `time.updated` is deliberately absent: streaming bumps it without changing
 * anything this section renders, so treating those bumps as different would
 * re-render on every unrelated session publication.
 */
const areSubagentChildrenEqual = (
  left: SubagentChildrenSnapshot,
  right: SubagentChildrenSnapshot,
): boolean => {
  if (left === right) return true;
  if (left.children.length !== right.children.length) return false;
  for (let index = 0; index < left.children.length; index += 1) {
    const leftChild = left.children[index];
    const rightChild = right.children[index];
    if (leftChild.id !== rightChild.id || leftChild.title !== rightChild.title) return false;
    if (left.busyById[leftChild.id] !== right.busyById[rightChild.id]) return false;
  }
  return true;
};

/**
 * Direct children of `sessionId` and their busy state, read from one directory
 * store instead of the directory-wide session/status aggregates. The snapshot
 * is cached and compared on child identity, label and busy state, so unrelated
 * session or status publications resolve to the same reference and React bails
 * out before re-rendering the section.
 */
function useSubagentChildren(store: DirectoryStore, sessionId: string | null): SubagentChildrenSnapshot {
  const cacheRef = React.useRef<SubagentChildrenSnapshot | null>(null);

  const getSnapshot = React.useCallback((): SubagentChildrenSnapshot => {
    if (!sessionId) return EMPTY_SUBAGENT_CHILDREN;
    const state = store.getState();
    const children = state.session
      .filter((candidate) => candidate.parentID === sessionId)
      .sort((left, right) => {
        // `time.created` is stable, unlike `time.updated`, so the newest
        // subagent stays on top without a volatile ordering input.
        const byCreated = childCreatedAt(right) - childCreatedAt(left);
        if (byCreated !== 0) return byCreated;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
    const busyById: Record<string, boolean> = {};
    for (const child of children) {
      busyById[child.id] = state.session_status?.[child.id]?.type === 'busy';
    }
    const next: SubagentChildrenSnapshot = { children, busyById };
    const cached = cacheRef.current;
    if (cached && areSubagentChildrenEqual(cached, next)) return cached;
    cacheRef.current = next;
    return next;
  }, [store, sessionId]);

  const subscribe = React.useCallback((notify: () => void) => {
    if (!sessionId) return () => undefined;
    return store.subscribe((state, previous) => {
      if (state.session !== previous.session || state.session_status !== previous.session_status) {
        notify();
      }
    });
  }, [store, sessionId]);

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type SubagentBlockers = Record<string, 'permission' | 'question'>;

const areBlockersEqual = (left: SubagentBlockers, right: SubagentBlockers): boolean => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
};

/**
 * Pending permission/question presence per direct child, keyed by child ID.
 * Uses the per-session sidecar channels, so a blocker raised anywhere else in
 * the directory never notifies this section.
 */
function useSubagentBlockers(store: DirectoryStore, childIds: readonly string[]): SubagentBlockers {
  const cacheRef = React.useRef<{ ids: readonly string[]; blockers: SubagentBlockers } | null>(null);

  const getSnapshot = React.useCallback(() => {
    const state = store.getState();
    const blockers: SubagentBlockers = {};
    for (const id of childIds) {
      if ((state.permission[id]?.length ?? 0) > 0) blockers[id] = 'permission';
      else if ((state.question[id]?.length ?? 0) > 0) blockers[id] = 'question';
    }
    const cached = cacheRef.current;
    if (cached && cached.ids === childIds && areBlockersEqual(cached.blockers, blockers)) {
      cacheRef.current = { ids: childIds, blockers: cached.blockers };
      return cached.blockers;
    }
    cacheRef.current = { ids: childIds, blockers };
    return blockers;
  }, [store, childIds]);

  const subscribe = React.useCallback((notify: () => void) => {
    if (childIds.length === 0) return () => undefined;
    const unsubscribers = childIds.flatMap((id) => [
      subscribeDirectoryPermission(store, id, notify),
      subscribeDirectoryQuestion(store, id, notify),
    ]);
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [store, childIds]);

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Running subagents and, more importantly, their blockers: a permission request
 * raised by a child session has no representation in the transcript, so this
 * panel is the only place it becomes visible.
 */
export const WorkStatusSubagentsSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);

  const store = useDirectoryStore(directory ?? undefined);
  const { children, busyById } = useSubagentChildren(store, sessionId);
  const childIds = React.useMemo(() => children.map((child) => child.id), [children]);
  const blockers = useSubagentBlockers(store, childIds);

  // Each child's own subtree total (its cost plus every descendant of its
  // own), so nested subagent-of-subagent cost rolls up under the immediate
  // child row shown here rather than disappearing.
  const { perChildCost } = useDirectorySubagentCostRollup(sessionId, directory);

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

  const busyChildren = children.filter((child) => busyById[child.id]).length;

  return (
    <WorkStatusCollapsibleSection
      id={SECTION_ID}
      title={t('chat.workStatus.section.subagents')}
      icon="ai-agent"
      defaultExpanded
      summary={busyChildren > 0 ? `${busyChildren}/${children.length}` : children.length}
    >
      <div className="max-h-56 overflow-y-auto">
        {children.map((child) => {
          const blocker = blockers[child.id];
          const busy = busyById[child.id] === true;
          const label = child.title?.trim() || t('chat.workStatus.subagent.untitled');
          const childCost = perChildCost.get(child.id) ?? 0;
          return (
            <WorkStatusRow
              key={child.id}
              onClick={directory ? () => openChildSession(child.id, label) : undefined}
              ariaLabel={t('chat.workStatus.action.openSubagent', { name: label })}
              label={label}
              value={(
                <>
                  {blocker === 'permission' ? (
                    <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.needsPermission')}</WorkStatusValue>
                  ) : blocker === 'question' ? (
                    <WorkStatusValue tone="warning">{t('chat.workStatus.subagent.askedQuestion')}</WorkStatusValue>
                  ) : busy ? (
                    <WorkStatusValue tone="info">{t('chat.workStatus.subagent.working')}</WorkStatusValue>
                  ) : (
                    <WorkStatusValue tone="muted">{t('chat.workStatus.subagent.done')}</WorkStatusValue>
                  )}
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
