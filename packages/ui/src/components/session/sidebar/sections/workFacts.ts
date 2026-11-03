import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { getLinkedIssues, isLinkedChange } from '@/lib/linkedIssues';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import { getSessionPinList } from '@/lib/sessionPins';
import { getSessionWork, isDoneSuggested } from '@/lib/sessionWorkMetadata';
import { DEFAULT_PIN_LIST, type SidebarWorkFacts } from '@/lib/sidebarSections';
import type { SessionNode } from '../types';
import type { SidebarWorkRef } from '../works/sidebarWorks';

/**
 * What the user's sections ask of the live state, read only while a shown
 * section filters on it: sessions running, sessions with a permission, a
 * question or a page waiting on the user, and top-level sessions whose last
 * turn is unread or failed.
 */
export type SidebarLiveFacts = {
  activeIds: ReadonlySet<string>;
  blockingIds: ReadonlySet<string>;
  unreadIds: ReadonlySet<string>;
  failedIds: ReadonlySet<string>;
};

/** A session a scheduled task started (`scheduled-tasks/runtime.js` marks it so at creation). */
const scheduledRunSchema = z.object({ openchamber: z.object({ kind: z.literal('scheduled') }) });

/**
 * What one session's own record says, read once per record: a session update
 * arrives as a new record, so an unchanged session is never parsed again
 * however often the sections are worked out (each parse costs about 1 µs, and
 * a sidebar holds thousands of sessions).
 */
type SessionRecordFacts = {
  work: 'open' | 'done' | null;
  looksDone: boolean;
  scheduled: boolean;
  pin: string | null;
  openGoal: boolean;
  hasChange: boolean;
  hasIssue: boolean;
  hasTrackerItem: boolean;
};

const recordFactsCache = new WeakMap<Session, SessionRecordFacts>();

const recordFacts = (session: Session): SessionRecordFacts => {
  const cached = recordFactsCache.get(session);
  if (cached) return cached;
  const links = getLinkedIssues(session);
  const goal = getSessionGoal(session);
  const facts: SessionRecordFacts = {
    work: getSessionWork(session)?.state ?? null,
    looksDone: isDoneSuggested(session),
    scheduled: scheduledRunSchema.safeParse(session.metadata).success,
    pin: getSessionPinList(session),
    openGoal: goal !== null && goal.status !== 'complete',
    hasChange: links.some(isLinkedChange),
    hasIssue: links.some((link) => !isLinkedChange(link) && link.kind !== 'tracker'),
    hasTrackerItem: links.some((link) => link.kind === 'tracker'),
  };
  recordFactsCache.set(session, facts);
  return facts;
};

/** Sessions a project plan was sent to, read only while a shown section asks for plans. */
type SidebarPlanFacts = ReadonlySet<string>;

export const EMPTY_SIDEBAR_LIVE_FACTS: SidebarLiveFacts = {
  activeIds: new Set(), blockingIds: new Set(), unreadIds: new Set(), failedIds: new Set(),
};

type FactsContext = {
  sessionById: ReadonlyMap<string, Session>;
  childrenMap: ReadonlyMap<string, readonly Session[]>;
  runKeyBySessionId: ReadonlyMap<string, string>;
  live: SidebarLiveFacts;
  planSessionIds: SidebarPlanFacts;
};

/** Every session of a work, the subagents included, and its top-level ones. */
const collectWorkSessions = (ref: SidebarWorkRef, context: FactsContext) => {
  const all: Session[] = [];
  if (ref.kind === 'group') {
    const stack: SessionNode[] = [...ref.group.sessions];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      all.push(node.session);
      stack.push(...node.children);
    }
  } else {
    const root = context.sessionById.get(ref.rootSessionId);
    const stack: Session[] = root ? [root] : [];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const session = stack.pop();
      if (!session || seen.has(session.id)) continue;
      seen.add(session.id);
      all.push(session);
      stack.push(...(context.childrenMap.get(session.id) ?? []));
    }
  }
  // A subagent's own state never counts for the work, as in In work.
  return { all, top: all.filter((session) => !session.parentID) };
};

export const buildSidebarWorkFacts = (ref: SidebarWorkRef, context: FactsContext): SidebarWorkFacts => {
  const { all, top } = collectWorkSessions(ref, context);
  const worktree = ref.kind === 'group' ? ref.group.worktree : null;
  const root = ref.kind === 'session' ? context.sessionById.get(ref.rootSessionId) ?? null : null;
  const topFacts = top.map(recordFacts);
  const inWork = topFacts.some((facts) => facts.work === 'open');
  let kind: SidebarWorkFacts['kind'] = 'session';
  if (ref.kind === 'group') kind = ref.group.space ? 'space' : 'worktree';
  else if (context.runKeyBySessionId.has(ref.rootSessionId)) kind = 'run';
  let pin: string | null = null;
  if (ref.kind === 'group') pin = worktree?.pinnedAt !== undefined ? worktree.pinList ?? DEFAULT_PIN_LIST : null;
  else pin = root ? recordFacts(root).pin : null;
  return {
    kind,
    scheduled: topFacts.some((facts) => facts.scheduled),
    projectId: ref.projectId,
    pin,
    inWork,
    done: !inWork && topFacts.some((facts) => facts.work === 'done'),
    running: all.some((session) => context.live.activeIds.has(session.id)),
    needsAnswer: all.some((session) => context.live.blockingIds.has(session.id)),
    unread: top.some((session) => context.live.unreadIds.has(session.id)),
    failed: top.some((session) => context.live.failedIds.has(session.id)),
    looksDone: topFacts.some((facts) => facts.looksDone),
    hasPr: worktree?.kind === 'pr' || topFacts.some((facts) => facts.hasChange),
    hasIssue: topFacts.some((facts) => facts.hasIssue),
    hasTrackerItem: topFacts.some((facts) => facts.hasTrackerItem),
    hasPlan: all.some((session) => context.planSessionIds.has(session.id)),
    hasGoal: topFacts.some((facts) => facts.openGoal),
    lastActivityAt: all.reduce((latest, session) => Math.max(latest, session.time.updated), 0),
    texts: [
      ...top.map((session) => session.title ?? ''),
      ...(ref.kind === 'group' ? [ref.group.label, ref.group.branch ?? ''] : []),
    ],
  };
};
