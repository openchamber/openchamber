import type { Session } from '@/lib/opencode/model';
import type { SessionDraft } from '@/stores/useSessionDraftsStore';
import type { SessionSidebarTimelineEntry, SessionSidebarWorkEntry } from '../sessionSidebarRowModel';
import { localDayStart, type TimelineActivity } from '../timelineDates';
import { orderSidebarWorks, resolveWorkActivity, sessionWorkKey, type SidebarWorkIndex, type SidebarWorkRef, type WorktreeArchiveAnchors } from '../works/sidebarWorks';

const LEAD: TimelineActivity = { kind: 'lead' };
const UNSTARTED: TimelineActivity = { kind: 'unstarted' };

export const buildTimelineEntries = ({
  orderedSessions,
  workIndex,
  archive,
  include,
  isExcluded,
  isLiveSpace,
  orderValueOf,
  isPinned,
  rootDrafts,
  toWorkEntries,
}: {
  orderedSessions: readonly Session[];
  workIndex: SidebarWorkIndex;
  archive: WorktreeArchiveAnchors;
  include: (session: Session) => boolean;
  isExcluded: (ref: SidebarWorkRef) => boolean;
  isLiveSpace: (ref: SidebarWorkRef) => boolean;
  orderValueOf: (session: Session) => number;
  isPinned: (session: Session) => boolean;
  rootDrafts: readonly { draft: SessionDraft; projectId: string }[];
  toWorkEntries: (refs: readonly SidebarWorkRef[]) => readonly SessionSidebarWorkEntry[];
}): readonly SessionSidebarTimelineEntry[] => {
  const refs = orderSidebarWorks(orderedSessions, workIndex, include, archive.timelineAnchors).filter((ref) => !isExcluded(ref));
  const ordered = resolveWorkActivity({ orderedSessions, index: workIndex, include, orderValueOf, isPinned, archivedAt: archive.archivedAt });
  const activityByKey = new Map<string, TimelineActivity>(refs.map((ref) => [ref.key, ordered.get(ref.key) ?? UNSTARTED]));
  const seen = new Set(refs.map((ref) => ref.key));
  const unstarted = workIndex.groupWorks.filter((ref) => !seen.has(ref.key) && !isExcluded(ref));
  const isPinnedWorktree = (ref: SidebarWorkRef): boolean => ref.kind === 'group' && ref.group.worktree?.pinnedAt !== undefined;
  for (const ref of unstarted) activityByKey.set(ref.key, isLiveSpace(ref) ? LEAD : UNSTARTED);
  refs.unshift(...unstarted.filter(isLiveSpace));
  refs.push(...unstarted.filter((ref) => !isLiveSpace(ref)));
  for (const ref of refs) if (isPinnedWorktree(ref)) activityByKey.set(ref.key, LEAD);
  const withActivity = (entry: SessionSidebarWorkEntry): SessionSidebarTimelineEntry => {
    if (entry.kind === 'draft') return { ...entry, activity: LEAD };
    const key = entry.kind === 'group' ? entry.groupKey : sessionWorkKey(entry.item.node.session.id);
    return { ...entry, activity: activityByKey.get(key) ?? UNSTARTED };
  };
  const entries = [
    ...rootDrafts.map(({ draft, projectId }): SessionSidebarWorkEntry => ({ kind: 'draft', draft, projectId })),
    ...toWorkEntries([...refs.filter(isPinnedWorktree), ...refs.filter((ref) => !isPinnedWorktree(ref))]),
  ].map(withActivity);
  return byDay(entries);
};

const dayOf = (entry: SessionSidebarTimelineEntry): number => (entry.activity.kind === 'active' ? localDayStart(entry.activity.at) : 0);

const byDay = (entries: SessionSidebarTimelineEntry[]): SessionSidebarTimelineEntry[] => {
  const slots = entries.flatMap((entry, index) => (entry.activity.kind === 'active' ? [index] : []));
  const active = slots.map((index) => entries[index]).sort((left, right) => dayOf(right) - dayOf(left));
  slots.forEach((slot, index) => { entries[slot] = active[index]; });
  return entries;
};
