import type { Session } from '@opencode-ai/sdk/v2';
import { normalizePath } from '@/lib/pathNormalization';

export type GlobalSessionStructure = {
  activeSessionIds: readonly string[];
  activeRootIds: readonly string[];
  activeChildrenByParentId: ReadonlyMap<string, readonly string[]>;
  activeIdsByDirectory: ReadonlyMap<string, readonly string[]>;
};

export type GlobalSessionStructureMutation = {
  sessionId: string;
  previous: Session | null;
  next: Session | null;
};

type SessionLocation = {
  directory: string | null;
  parentId: string | null;
};

type BucketChange = {
  additions: Set<string>;
  removals: Set<string>;
};

type SessionIndexFields = {
  directory?: string | null;
  parentID?: string | null;
  project?: { worktree?: string | null } | null;
};

const indexFields = (session: Session): Session & SessionIndexFields => {
  // SAFETY: OpenCode session payloads expose these stable fields even though the SDK base Session omits them.
  return session as Session & SessionIndexFields;
};

const parentIdOf = (session: Session): string | null => (
  indexFields(session).parentID ?? null
);

export const resolveGlobalSessionDirectory = (session: Session): string | null => {
  const record = indexFields(session);

  return normalizePath(record.directory ?? null)
    ?? normalizePath(record.project?.worktree ?? null);
};

export const mergeSessionDirectoryMetadata = (incoming: Session, existing?: Session | null): Session => {
  if (!existing) return incoming;

  const incomingRecord = indexFields(incoming);
  const existingRecord = indexFields(existing);
  const incomingDirectory = normalizePath(incomingRecord.directory ?? null);
  const incomingWorktree = normalizePath(incomingRecord.project?.worktree ?? null);
  const existingDirectory = normalizePath(existingRecord.directory ?? null);
  const existingWorktree = normalizePath(existingRecord.project?.worktree ?? null);
  let changed = false;
  const next: typeof incomingRecord = { ...incomingRecord };

  if (!incomingDirectory && existingDirectory) {
    next.directory = existingRecord.directory;
    changed = true;
  }
  if (!incomingWorktree && existingWorktree) {
    next.project = {
      ...(existingRecord.project ?? {}),
      ...(incomingRecord.project ?? {}),
      worktree: existingRecord.project?.worktree,
    };
    changed = true;
  } else if (!incomingRecord.project && existingRecord.project) {
    next.project = existingRecord.project;
    changed = true;
  }

  return changed ? next : incoming;
};

const locationOf = (session: Session): SessionLocation | null => session.time?.archived ? null : ({
  directory: resolveGlobalSessionDirectory(session),
  parentId: parentIdOf(session),
});

const sameLocation = (left: SessionLocation, right: SessionLocation): boolean => (
  left.directory === right.directory
  && left.parentId === right.parentId
);

const appendToBucket = (buckets: Map<string, string[]>, key: string, sessionId: string): void => {
  const bucket = buckets.get(key);
  if (bucket) bucket.push(sessionId);
  else buckets.set(key, [sessionId]);
};

export const buildGlobalSessionStructure = (
  activeSessions: readonly Session[],
): GlobalSessionStructure => {
  const activeRootIds: string[] = [];
  const activeChildrenByParentId = new Map<string, string[]>();
  const activeIdsByDirectory = new Map<string, string[]>();

  const index = (
    session: Session,
    roots: string[],
    children: Map<string, string[]>,
    directories: Map<string, string[]>,
  ): void => {
    const location = locationOf(session);
    if (!location) return;
    if (location.parentId) appendToBucket(children, location.parentId, session.id);
    else roots.push(session.id);
    if (location.directory) appendToBucket(directories, location.directory, session.id);
  };

  for (const session of activeSessions) index(session, activeRootIds, activeChildrenByParentId, activeIdsByDirectory);

  return {
    activeSessionIds: activeSessions.map((session) => session.id),
    activeRootIds,
    activeChildrenByParentId,
    activeIdsByDirectory,
  };
};

const recordBucketChange = (
  changes: Map<string, BucketChange>,
  key: string,
  sessionId: string,
  operation: 'add' | 'remove',
): void => {
  const change = changes.get(key) ?? { additions: new Set<string>(), removals: new Set<string>() };
  if (operation === 'add') {
    change.removals.delete(sessionId);
    change.additions.delete(sessionId);
    change.additions.add(sessionId);
  } else {
    change.additions.delete(sessionId);
    change.removals.add(sessionId);
  }
  changes.set(key, change);
};

const applyListChange = (
  source: readonly string[],
  change: BucketChange,
): readonly string[] => {
  if (change.additions.size === 0 && change.removals.size === 0) return source;
  const additions = [...change.additions].reverse();
  const added = new Set(additions);
  const retained = source.filter((id) => !change.removals.has(id) && !added.has(id));
  const next = [...additions, ...retained];
  if (next.length === source.length && next.every((id, index) => id === source[index])) return source;
  return next;
};

const applyBucketChanges = (
  source: ReadonlyMap<string, readonly string[]>,
  changes: Map<string, BucketChange>,
): ReadonlyMap<string, readonly string[]> => {
  if (changes.size === 0) return source;
  let next: Map<string, readonly string[]> | null = null;
  for (const [key, change] of changes) {
    const previous = source.get(key) ?? [];
    const bucket = applyListChange(previous, change);
    if (bucket === previous) continue;
    next ??= new Map(source);
    if (bucket.length === 0) next.delete(key);
    else next.set(key, bucket);
  }
  return next ?? source;
};

export const applyGlobalSessionStructureMutations = (
  structure: GlobalSessionStructure,
  mutations: readonly GlobalSessionStructureMutation[],
): GlobalSessionStructure => {
  const activeRoots: BucketChange = { additions: new Set(), removals: new Set() };
  const activeSessions: BucketChange = { additions: new Set(), removals: new Set() };
  const activeChildren = new Map<string, BucketChange>();
  const activeDirectories = new Map<string, BucketChange>();

  const record = (location: SessionLocation, sessionId: string, operation: 'add' | 'remove'): void => {
    if (operation === 'add') {
      activeSessions.removals.delete(sessionId);
      activeSessions.additions.delete(sessionId);
      activeSessions.additions.add(sessionId);
    } else {
      activeSessions.additions.delete(sessionId);
      activeSessions.removals.add(sessionId);
    }
    if (location.parentId) recordBucketChange(activeChildren, location.parentId, sessionId, operation);
    else if (operation === 'add') {
      activeRoots.removals.delete(sessionId);
      activeRoots.additions.delete(sessionId);
      activeRoots.additions.add(sessionId);
    } else {
      activeRoots.additions.delete(sessionId);
      activeRoots.removals.add(sessionId);
    }
    if (location.directory) recordBucketChange(activeDirectories, location.directory, sessionId, operation);
  };

  for (const mutation of mutations) {
    const previousLocation = mutation.previous ? locationOf(mutation.previous) : null;
    const nextLocation = mutation.next ? locationOf(mutation.next) : null;
    if (previousLocation && nextLocation && sameLocation(previousLocation, nextLocation)) continue;
    if (previousLocation) record(previousLocation, mutation.sessionId, 'remove');
    if (nextLocation) record(nextLocation, mutation.sessionId, 'add');
  }

  const next: GlobalSessionStructure = {
    activeSessionIds: applyListChange(structure.activeSessionIds, activeSessions),
    activeRootIds: applyListChange(structure.activeRootIds, activeRoots),
    activeChildrenByParentId: applyBucketChanges(structure.activeChildrenByParentId, activeChildren),
    activeIdsByDirectory: applyBucketChanges(structure.activeIdsByDirectory, activeDirectories),
  };
  return next.activeSessionIds === structure.activeSessionIds
    && next.activeRootIds === structure.activeRootIds
    && next.activeChildrenByParentId === structure.activeChildrenByParentId
    && next.activeIdsByDirectory === structure.activeIdsByDirectory
    ? structure
    : next;
};
