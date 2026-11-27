import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import type { SessionGroup, SessionNode } from '../types';
import type { ProjectSection } from '../projects/sessionProjectRender';
import type { TimelineActivity } from '../timelineDates';

export type SidebarWorkRef =
  | { kind: 'group'; key: string; projectId: string; group: SessionGroup }
  | { kind: 'session'; key: string; projectId: string | null; rootSessionId: string; chat?: boolean };

type SidebarGroupWorkRef = Extract<SidebarWorkRef, { kind: 'group' }>;

export type SidebarWorkIndex = {
  bySessionId: ReadonlyMap<string, SidebarWorkRef>;
  groupWorks: readonly SidebarGroupWorkRef[];
};

export const isGroupWork = (group: SessionGroup): boolean => (
  !group.isMain && group.isArchivedBucket !== true && (Boolean(group.space) || group.worktree !== null)
);

export type SidebarFolderMembership = { folderId: string; projectId: string };

export const findWorkFolderId = (ref: SidebarWorkRef, folderByMember: ReadonlyMap<string, SidebarFolderMembership>): string | null => {
  const memberId = ref.kind === 'group' ? worktreeFolderMemberId(ref.group.directory) : ref.rootSessionId;
  const membership = memberId ? folderByMember.get(memberId) : undefined;
  return membership?.projectId === ref.projectId ? membership?.folderId ?? null : null;
};

export const isFiledInFolder = (ref: SidebarWorkRef, folderByMember: ReadonlyMap<string, SidebarFolderMembership>): boolean => (
  findWorkFolderId(ref, folderByMember) !== null
);

export const collectSessionWorkInWork = (root: SessionNode): Session[] => {
  const inWork: Session[] = [];
  const stack: SessionNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (isSessionInWork(current.session)) inWork.push(current.session);
    for (const child of current.children) if (!child.session.parentID) stack.push(child);
  }
  return inWork;
};

const worktreeWorkGroupKey = (projectId: string, group: SessionGroup): string => `${projectId}:${group.id}`;

export const worktreeFolderMemberId = (directory: string | null): string | null => {
  const normalized = normalizePath(directory);
  return normalized ? `worktree:${normalized}` : null;
};

export const sessionWorkKey = (rootSessionId: string): string => `session:${rootSessionId}`;

export const buildSidebarWorkIndex = (sections: readonly ProjectSection[]): SidebarWorkIndex => {
  const bySessionId = new Map<string, SidebarWorkRef>();
  const groupWorks: SidebarGroupWorkRef[] = [];
  const claim = (node: SessionNode, ref: SidebarWorkRef): void => {
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || bySessionId.has(current.session.id)) continue;
      bySessionId.set(current.session.id, ref);
      stack.push(...current.children);
    }
  };
  for (const section of sections) {
    const projectId = section.project.id;
    for (const group of section.groups) {
      if (group.isArchivedBucket) continue;
      if (isGroupWork(group)) {
        const ref: SidebarGroupWorkRef = { kind: 'group', key: worktreeWorkGroupKey(projectId, group), projectId, group };
        groupWorks.push(ref);
        group.sessions.forEach((node) => claim(node, ref));
        continue;
      }
      for (const node of group.sessions) {
        claim(node, { kind: 'session', key: sessionWorkKey(node.session.id), projectId, rootSessionId: node.session.id });
      }
    }
  }
  return { bySessionId, groupWorks };
};

export const orderSidebarWorks = (
  orderedSessions: readonly Session[],
  index: SidebarWorkIndex,
  include: (session: Session) => boolean,
  archiveAnchors: ReadonlyMap<string, number> = EMPTY_ANCHORS,
  resolveUnindexedWork?: (session: Session) => SidebarWorkRef | undefined,
): SidebarWorkRef[] => {
  const rankByKey = new Map<string, { ref: SidebarWorkRef; rank: number }>();
  orderedSessions.forEach((session, position) => {
    if (!include(session)) return;
    const ref = index.bySessionId.get(session.id) ?? resolveUnindexedWork?.(session);
    if (ref && !rankByKey.has(ref.key)) rankByKey.set(ref.key, { ref, rank: position });
  });
  if (archiveAnchors.size === 0) return [...rankByKey.values()].map((entry) => entry.ref);
  for (const ref of index.groupWorks) {
    const anchor = archiveAnchors.get(ref.key);
    if (anchor === undefined) continue;
    const listed = rankByKey.get(ref.key);
    rankByKey.set(ref.key, { ref, rank: Math.min(listed?.rank ?? anchor, anchor) });
  }
  return [...rankByKey.values()].sort((left, right) => left.rank - right.rank).map((entry) => entry.ref);
};

export const buildSessionRootIndex = (
  rootSessions: readonly Session[],
  childrenMap: ReadonlyMap<string, readonly Session[]>,
): ReadonlyMap<string, string> => {
  const rootOf = new Map<string, string>();
  for (const root of rootSessions) {
    const stack: Session[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || rootOf.has(current.id)) continue;
      rootOf.set(current.id, root.id);
      stack.push(...(childrenMap.get(current.id) ?? []));
    }
  }
  return rootOf;
};

const isTrackedInWork = (session: Session, isChatDirectory: (directory: string | null | undefined) => boolean): boolean => (
  !session.parentID && !session.time?.archived && !isChatDirectory(session.directory) && isSessionInWork(session)
);

export const orderInWorkWorks = (
  orderedSessions: readonly Session[],
  index: SidebarWorkIndex,
  rootOf: ReadonlyMap<string, string>,
  isChatDirectory: (directory: string | null | undefined) => boolean,
): SidebarWorkRef[] => orderSidebarWorks(
  orderedSessions, index, (session) => isTrackedInWork(session, isChatDirectory), EMPTY_ANCHORS,
  (session) => index.bySessionId.get(rootOf.get(session.id) ?? ''),
);

export const selectInWorkSessions = (
  shown: readonly SidebarWorkRef[],
  orderedSessions: readonly Session[],
  index: SidebarWorkIndex,
  rootOf: ReadonlyMap<string, string>,
  isChatDirectory: (directory: string | null | undefined) => boolean,
): readonly Session[] => {
  if (shown.length === 0) return [];
  const keys = new Set(shown.map((ref) => ref.key));
  return orderedSessions.filter((session) => {
    if (!isTrackedInWork(session, isChatDirectory)) return false;
    const ref = index.bySessionId.get(session.id) ?? index.bySessionId.get(rootOf.get(session.id) ?? '');
    return ref !== undefined && keys.has(ref.key);
  });
};

export const buildWorktreeArchiveAnchors = ({
  groupWorks,
  archivedSessions,
  orderedSessions,
  orderValueOf,
  isPinned,
  isTopLevel,
}: {
  groupWorks: readonly SidebarGroupWorkRef[];
  archivedSessions: readonly Session[];
  orderedSessions: readonly Session[];
  orderValueOf: (session: Session) => number;
  isPinned: (session: Session) => boolean;
  isTopLevel: (session: Session) => boolean;
}): WorktreeArchiveAnchors => {
  if (groupWorks.length === 0 || archivedSessions.length === 0) return EMPTY_ARCHIVE;
  const keyByDirectory = new Map(groupWorks.flatMap((ref) => {
    const directory = normalizePath(ref.group.directory ?? null);
    return directory ? [[directory, ref.key] as const] : [];
  }));
  const newestByKey = new Map<string, number>();
  for (const session of archivedSessions) {
    if (session.parentID) continue;
    const key = keyByDirectory.get(normalizePath(session.directory ?? null) ?? '');
    if (!key) continue;
    newestByKey.set(key, Math.max(newestByKey.get(key) ?? Number.NEGATIVE_INFINITY, orderValueOf(session)));
  }
  if (newestByKey.size === 0) return EMPTY_ARCHIVE;
  const gapBefore = (isBoundary: (session: Session) => boolean) => {
    const tops = orderedSessions.flatMap((session, index) => (
      !isBoundary(session) || isPinned(session) ? [] : [{ index, value: orderValueOf(session) }]
    ));
    return (newest: number): number => tops.find((entry) => entry.value < newest)?.index ?? orderedSessions.length;
  };
  const rootGapBefore = gapBefore((session) => !session.parentID);
  const anchors = new Map<string, number>();
  for (const [key, newest] of newestByKey) anchors.set(key, rootGapBefore(newest) - 0.5);
  const timelineGapBefore = gapBefore(isTopLevel);
  const placed = [...newestByKey]
    .sort(([, left], [, right]) => right - left)
    .map(([key, newest]) => ({ key, before: timelineGapBefore(newest) }));
  const sharingGap = new Map<number, number>();
  for (const { before } of placed) sharingGap.set(before, (sharingGap.get(before) ?? 0) + 1);
  const placedInGap = new Map<number, number>();
  const timelineAnchors = new Map<string, number>();
  for (const { key, before } of placed) {
    const position = (placedInGap.get(before) ?? 0) + 1;
    placedInGap.set(before, position);
    timelineAnchors.set(key, before - 1 + position / ((sharingGap.get(before) ?? 1) + 1));
  }
  return { anchors, timelineAnchors, archivedAt: newestByKey };
};

export const resolveWorkActivity = ({
  orderedSessions,
  index,
  include,
  orderValueOf,
  isPinned,
  archivedAt,
}: {
  orderedSessions: readonly Session[];
  index: SidebarWorkIndex;
  include: (session: Session) => boolean;
  orderValueOf: (session: Session) => number;
  isPinned: (session: Session) => boolean;
  archivedAt: ReadonlyMap<string, number>;
}): ReadonlyMap<string, TimelineActivity> => {
  const activity = new Map<string, TimelineActivity>();
  for (const session of orderedSessions) {
    if (!include(session)) continue;
    const ref = index.bySessionId.get(session.id);
    if (!ref || activity.has(ref.key)) continue;
    activity.set(ref.key, isPinned(session) ? { kind: 'lead' } : { kind: 'active', at: orderValueOf(session) });
  }
  for (const [key, at] of archivedAt) {
    const listed = activity.get(key);
    if (listed?.kind !== 'lead') activity.set(key, { kind: 'active', at: Math.max(listed?.kind === 'active' ? listed.at : at, at) });
  }
  return activity;
};

export type WorktreeArchiveAnchors = {
  anchors: ReadonlyMap<string, number>;
  timelineAnchors: ReadonlyMap<string, number>;
  archivedAt: ReadonlyMap<string, number>;
};

const EMPTY_ANCHORS: ReadonlyMap<string, number> = new Map();
const EMPTY_ARCHIVE: WorktreeArchiveAnchors = { anchors: EMPTY_ANCHORS, timelineAnchors: EMPTY_ANCHORS, archivedAt: EMPTY_ANCHORS };
