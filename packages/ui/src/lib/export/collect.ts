/**
 * Collecting the sessions an export covers.
 *
 * The export starts from one session and needs every session below it: the
 * subagents the orchestrator started, and their own subagents. The parent
 * session's records name the children they started; the session list names
 * the rest of the lineage. Both are needed, because a subagent that is still
 * running may be named by a call that has not settled yet.
 *
 * Loading is bounded: a session with hundreds of subagents must not open
 * hundreds of requests at once, and one child that fails to load must not
 * fail the export.
 */

import type { ExportFinding, ExportSourceSession } from './events';

/**
 * A session as the export reads it: the identity and the labels, without
 * the rest of the session record.
 */
export type ExportSession = {
  id: string;
  parentID?: string;
  title: string;
  agent?: string;
  /** The session's creation time, in milliseconds since the epoch. */
  createdAt?: number;
  /**
   * The id of the call that started this session, when the session has no id
   * of its own.
   *
   * A child the caller knows only by its description has no session id, so
   * the call that recorded the description is what ties it to the history.
   */
  invocationKey?: string;
};

/** One message and its parts, as the source recorded them. */
export type ExportSourceRecord = { info: import('@/lib/opencode/model').Message; parts: import('@/lib/opencode/model').Part[] };

/** Loads one session's records. Returns null when the session is gone. */
export type ExportRecordLoader = (sessionID: string) => Promise<ExportSourceRecord[] | null>;

/** How many descendant sessions are loaded at the same time. */
const MAX_CONCURRENT_LOADS = 4;

export type CollectedSession = ExportSourceSession & {
  /** How deep the session sits below the exported root. */
  depth: number;
  /** The session's creation time, when the list knew it. */
  createdAt?: number;
  /**
   * The id of the call that started this session, when the session has no
   * session id of its own.
   */
  invocationKey?: string;
};

type CollectionResult = {
  /** The exported session and every descendant that could be loaded. */
  sessions: CollectedSession[];
  /**
   * The descendants the export expected but could not load.
   *
   * They are kept as sessions rather than as bare ids, so the export can say
   * which sub-agent is missing and place the gap where the reader expects it.
   */
  missing: MissingSession[];
  /** What the collection could not establish. */
  findings: ExportFinding[];
};

/** A descendant session whose history the export could not load. */
export type MissingSession = {
  session: ExportSession;
  /** How deep the session sits below the exported root. */
  depth: number;
};

/** A descendant session and how deep it sits below the exported root. */
type DescendantSession = {
  session: ExportSession;
  depth: number;
};

/** The descendants of a session, and whether the lineage loops. */
type DescendantSessions = {
  descendants: DescendantSession[];
  cyclic: boolean;
};

/**
 * The descendants of `root` in the session list, each before its children.
 *
 * The walk stops at a session it has already visited, so a lineage that points
 * back at itself ends the walk instead of looping. A child that is missing
 * from the list is not an error: the export may still have its records from
 * the call that started it.
 *
 * This is the one place the lineage is walked. The dialog's count of
 * sub-agent tasks and the export's own list of descendants come from here, so
 * the number the user is shown and the number the document carries cannot
 * drift apart.
 */
const collectDescendantSessions = (
  root: ExportSession,
  sessions: readonly ExportSession[],
): DescendantSessions => {
  const childrenByParentId = new Map<string, ExportSession[]>();
  for (const session of sessions) {
    const parentId = session.parentID;
    if (!parentId) continue;
    const siblings = childrenByParentId.get(parentId) ?? [];
    siblings.push(session);
    childrenByParentId.set(parentId, siblings);
  }

  const descendants: DescendantSession[] = [];
  const visited = new Set<string>([root.id]);
  let cyclic = false;

  const visit = (parentId: string, depth: number): void => {
    for (const child of childrenByParentId.get(parentId) ?? []) {
      if (visited.has(child.id)) {
        cyclic = true;
        continue;
      }
      visited.add(child.id);
      descendants.push({ session: child, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(root.id, 1);

  return { descendants, cyclic };
};

/**
 * The sub-agent sessions below `root` in the session list.
 *
 * The export dialog counts the sub-agent tasks a session has with this, and
 * the export covers the same sessions with it. One walk, two callers.
 */
export const listDescendantSessions = (
  root: ExportSession,
  sessions: readonly ExportSession[],
): ExportSession[] => collectDescendantSessions(root, sessions).descendants.map((entry) => entry.session);

/**
 * The sessions the client knows, as the export reads them.
 *
 * The session list is the only place the lineage lives, so both the dialog
 * and the export read the lineage from the same list, in the same shape.
 */
export const readExportSessions = (sessions: readonly {
  id: string;
  parentID?: string;
  title: string;
  agent?: string;
  time: { created: number };
}[]): ExportSession[] => sessions.map((session) => ({
  id: session.id,
  parentID: session.parentID,
  title: session.title,
  agent: session.agent,
  createdAt: session.time.created,
}));

/**
 * The sessions an export covers, when the caller already holds their records.
 *
 * A caller that has the whole tree in hand — the Sidebar's export dialog, or
 * a caller that read the records itself — does not need the loader, and the
 * export should not ask for one.
 */
export const collectLoadedSessions = (options: {
  root: ExportSession;
  /** Every session the client knows, active and archived. */
  sessions: readonly ExportSession[];
  /** The records of the sessions the caller holds, keyed by session id. */
  records: ReadonlyMap<string, ExportSourceRecord[]>;
}): CollectionResult => {
  const { root, sessions, records } = options;
  const findings: ExportFinding[] = [];
  const missing: MissingSession[] = [];

  const { descendants, cyclic } = collectDescendantSessions(root, sessions);
  if (cyclic) {
    findings.push({
      kind: 'cyclic-lineage',
      sessionID: root.id,
      detail: 'The session lineage points back at itself; the export stopped where the cycle begins.',
    });
  }

  const rootRecords = records.get(root.id);
  if (!rootRecords) {
    findings.push({
      kind: 'load-failure',
      sessionID: root.id,
      detail: 'The session history could not be loaded.',
    });
    return { sessions: [], missing, findings };
  }

  const collected: CollectedSession[] = [{
    sessionID: root.id,
    title: root.title,
    agent: root.agent,
    parentID: root.parentID,
    records: rootRecords,
    depth: 0,
  }];

  for (const { session, depth } of descendants) {
    const sessionRecords = records.get(session.id);
    if (!sessionRecords) {
      missing.push({ session, depth });
      continue;
    }
    collected.push({
      sessionID: session.id,
      title: session.title,
      agent: session.agent,
      parentID: session.parentID,
      records: sessionRecords,
      invocationKey: session.invocationKey,
      depth,
    });
  }

  return { sessions: collected, missing, findings };
};

/**
 * Loads the exported session and every descendant, with a bounded number of
 * concurrent loads.
 *
 * A child that fails to load is recorded as missing and the export continues:
 * a partial history with an honest notice beats a failed export.
 */
export const collectExportSessions = async (options: {
  root: ExportSession;
  /** Every session the client knows, active and archived. */
  sessions: readonly ExportSession[];
  load: ExportRecordLoader;
}): Promise<CollectionResult> => {
  const { root, sessions, load } = options;
  const findings: ExportFinding[] = [];
  const missing: MissingSession[] = [];

  const { descendants, cyclic } = collectDescendantSessions(root, sessions);
  if (cyclic) {
    findings.push({
      kind: 'cyclic-lineage',
      sessionID: root.id,
      detail: 'The session lineage points back at itself; the export stopped where the cycle begins.',
    });
  }

  const rootRecords = await load(root.id);
  const collected: CollectedSession[] = [];

  if (!rootRecords) {
    findings.push({
      kind: 'load-failure',
      sessionID: root.id,
      detail: 'The session history could not be loaded.',
    });
    return { sessions: collected, missing, findings };
  }

  collected.push({
    sessionID: root.id,
    title: root.title,
    agent: root.agent,
    parentID: root.parentID,
    records: rootRecords,
    createdAt: root.createdAt,
    depth: 0,
  });

  // The descendants are loaded in waves: a wide tree would otherwise open one
  // request per child at once.
  const queue = [...descendants];
  while (queue.length > 0) {
    const wave = queue.splice(0, MAX_CONCURRENT_LOADS);
    const loaded = await Promise.all(wave.map(async ({ session, depth }) => {
      const records = await load(session.id).catch(() => null);
      return { session, depth, records };
    }));

    for (const { session, depth, records } of loaded) {
      if (!records) {
        missing.push({ session, depth });
        continue;
      }
      collected.push({
        sessionID: session.id,
        title: session.title,
        agent: session.agent,
        parentID: session.parentID,
        records,
        createdAt: session.createdAt,
        invocationKey: session.invocationKey,
        depth,
      });
    }
  }

  return { sessions: collected, missing, findings };
};
