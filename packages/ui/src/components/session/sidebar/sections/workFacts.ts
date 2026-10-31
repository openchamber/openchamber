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
  const inWork = top.some((session) => getSessionWork(session)?.state === 'open');
  const links = top.flatMap((session) => getLinkedIssues(session));
  let kind: SidebarWorkFacts['kind'] = 'session';
  if (ref.kind === 'group') kind = ref.group.space ? 'space' : 'worktree';
  else if (context.runKeyBySessionId.has(ref.rootSessionId)) kind = 'run';
  let pin: string | null = null;
  if (ref.kind === 'group') pin = worktree?.pinnedAt !== undefined ? worktree.pinList ?? DEFAULT_PIN_LIST : null;
  else pin = getSessionPinList(root);
  return {
    kind,
    scheduled: top.some((session) => scheduledRunSchema.safeParse(session.metadata).success),
    projectId: ref.projectId,
    pin,
    inWork,
    done: !inWork && top.some((session) => getSessionWork(session)?.state === 'done'),
    running: all.some((session) => context.live.activeIds.has(session.id)),
    needsAnswer: all.some((session) => context.live.blockingIds.has(session.id)),
    unread: top.some((session) => context.live.unreadIds.has(session.id)),
    failed: top.some((session) => context.live.failedIds.has(session.id)),
    looksDone: top.some((session) => isDoneSuggested(session)),
    hasPr: worktree?.kind === 'pr' || links.some(isLinkedChange),
    hasIssue: links.some((link) => !isLinkedChange(link) && link.kind !== 'tracker'),
    hasTrackerItem: links.some((link) => link.kind === 'tracker'),
    hasPlan: all.some((session) => context.planSessionIds.has(session.id)),
    hasGoal: top.some((session) => {
      const goal = getSessionGoal(session);
      return goal !== null && goal.status !== 'complete';
    }),
    lastActivityAt: all.reduce((latest, session) => Math.max(latest, session.time.updated), 0),
    texts: [
      ...top.map((session) => session.title ?? ''),
      ...(ref.kind === 'group' ? [ref.group.label, ref.group.branch ?? ''] : []),
    ],
  };
};
