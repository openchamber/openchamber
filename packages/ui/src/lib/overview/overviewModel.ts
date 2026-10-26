import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { getCurrentSessionAssist } from '@/lib/sessionAssistMetadata';
import { isDoneSuggested, isSessionInWork } from '@/lib/sessionWorkMetadata';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { isSessionUnread } from '@/sync/session-unread';
import type { WorktreeMetadata } from '@/types/worktree';

/** An in-work session with no activity for this long is stalled. */
export const OVERVIEW_STALLED_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** A worktree without a PR and without activity for this long is offered for removal. */
export const OVERVIEW_STALE_WORKTREE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** With In work off, sessions touched within this window stand in for the ones in work. */
export const OVERVIEW_UNTRACKED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** What keeps a session's turn open (see `useSessionTurnActivity`). */
export type OverviewActivity = 'running' | 'subagent' | 'shell';

/** What a session waits on: a permission, or a question, form or page that needs an answer. */
export type OverviewBlocking = 'permission' | 'question';

/** What the overview knows about one top-level session. Live facts come from the stores; the rest is read off the record. */
export type OverviewSessionFacts = {
  session: Session;
  activity: OverviewActivity | null;
  /** A request of the session or of a subagent below it. */
  blocking: OverviewBlocking | null;
  /** The worktree branch's PR and the PRs linked to the session, whose state is known. */
  prs: readonly PrVisualSummary[];
  /** One of those PRs has no known state yet; a merged neighbour then proves nothing. */
  prsPending: boolean;
  /** Linked issues and tickets: open, completed, dropped (not planned, canceled), or null while unknown. */
  issues: ReadonlyArray<'open' | 'completed' | 'dropped' | null>;
  /** Uncommitted files in the session's own linked worktree; null outside one or before git answered. */
  worktreeDirty: boolean | null;
};

export type OverviewWaitingReason = 'permission' | 'question' | 'error' | 'checks' | 'conflict' | 'finished';
export type OverviewDoneSignal = 'merged' | 'issueClosed' | 'issueDropped' | 'hint';
/** Why a session that is not running and not waiting is not done. */
export type OverviewVeto = 'failed' | 'suggestion' | 'uncommitted';

export type OverviewSessionRow =
  /** `pr` is the blocked change request behind a `conflict` or `checks` reason, so the page can open it. */
  | { section: 'waiting'; session: Session; reason: OverviewWaitingReason; pr: PrVisualSummary | null }
  | { section: 'running'; session: Session; activity: OverviewActivity }
  | { section: 'done'; session: Session; signal: OverviewDoneSignal }
  /** In work and idle, with no done signal or a veto against it. `stalled` once nothing happened for days. */
  | { section: 'working'; session: Session; signal: OverviewDoneSignal | null; veto: OverviewVeto | null; stalled: boolean };

const kindSchema = z.object({ openchamber: z.object({ kind: z.string() }) });

const sessionKind = (session: Session): string | null => kindSchema.safeParse(session.metadata).data?.openchamber.kind ?? null;

// Orange means failed checks or a conflict (`prVisualStateOf`); a blocked PR
// whose checks did not fail is one GitHub cannot merge.
const blockedReason = (prs: readonly PrVisualSummary[]): { reason: 'checks' | 'conflict'; pr: PrVisualSummary } | null => {
  const blocked = prs.find((pr) => pr.visualState === 'blocked');
  if (!blocked) return null;
  return { reason: blocked.mergeableState !== 'dirty' && blocked.checks?.state === 'failure' ? 'checks' : 'conflict', pr: blocked };
};

/**
 * Whether a session's unread end and PRs are the user's to look at: in work,
 * or, with In work off, touched in the last two weeks. Without that window
 * every old session nobody reopened would wait on the user forever.
 */
export const isOverviewFollowed = (session: Session, context: { workEnabled: boolean; now: number }): boolean => (
  context.workEnabled ? isSessionInWork(session) : context.now - session.time.updated < OVERVIEW_UNTRACKED_WINDOW_MS
);

// A merged PR closes the work only while no other PR of the session is still
// open or unknown; a closed unmerged one says nothing either way. Linked issues close it
// once none is open or unknown: done if any was completed, dropped if every one
// was not planned or canceled.
const doneSignalOf = (facts: OverviewSessionFacts): OverviewDoneSignal | null => {
  const merged = facts.prs.some((pr) => pr.prState === 'merged');
  if (merged && !facts.prsPending && !facts.prs.some((pr) => pr.prState === 'open')) return 'merged';
  if (facts.issues.length > 0 && facts.issues.every((state) => state === 'completed' || state === 'dropped')) {
    return facts.issues.includes('completed') ? 'issueClosed' : 'issueDropped';
  }
  return isDoneSuggested(facts.session) ? 'hint' : null;
};

const vetoOf = (facts: OverviewSessionFacts): OverviewVeto | null => {
  if (facts.session.outcome === 'failed') return 'failed';
  if (getCurrentSessionAssist(facts.session)?.suggestion) return 'suggestion';
  return facts.worktreeDirty === true ? 'uncommitted' : null;
};

/**
 * Where a top-level session goes on the overview, or null when it has no
 * place there. A request for the user always shows; a running session always
 * shows. The rest follows `isOverviewFollowed`, and a failed scheduled run
 * shows as well.
 */
export function classifyOverviewSession(
  facts: OverviewSessionFacts,
  context: { workEnabled: boolean; now: number },
): OverviewSessionRow | null {
  const { session } = facts;
  const kind = sessionKind(session);
  // A `/btw` side question belongs to the session it was asked in.
  if (session.parentID || session.time.archived !== undefined || kind === 'btw') return null;

  if (facts.blocking) return { section: 'waiting', session, reason: facts.blocking, pr: null };
  if (facts.activity) return { section: 'running', session, activity: facts.activity };

  const inWork = context.workEnabled && isSessionInWork(session);
  const followed = isOverviewFollowed(session, context);
  const unread = isSessionUnread(session);
  if (unread && session.outcome === 'failed' && (followed || kind === 'scheduled')) {
    return { section: 'waiting', session, reason: 'error', pr: null };
  }
  if (!followed) return null;
  const blocked = blockedReason(facts.prs);
  if (blocked) return { section: 'waiting', session, reason: blocked.reason, pr: blocked.pr };
  if (unread) return { section: 'waiting', session, reason: 'finished', pr: null };
  if (!inWork) return null;

  const signal = doneSignalOf(facts);
  const veto = vetoOf(facts);
  if (signal && !veto) return { section: 'done', session, signal };
  return { section: 'working', session, signal, veto, stalled: context.now - session.time.updated >= OVERVIEW_STALLED_AFTER_MS };
}

const WAITING_ORDER = {
  permission: 0,
  question: 1,
  error: 2,
  conflict: 3,
  checks: 4,
  finished: 5,
} satisfies Record<OverviewWaitingReason, number>;

const updatedAt = (session: Session): number => session.time.updated;
const newestFirst = (left: { session: Session }, right: { session: Session }) => updatedAt(right.session) - updatedAt(left.session);

export type OverviewSessionSections = {
  waiting: Array<Extract<OverviewSessionRow, { section: 'waiting' }>>;
  running: Array<Extract<OverviewSessionRow, { section: 'running' }>>;
  done: Array<Extract<OverviewSessionRow, { section: 'done' }>>;
  /** In work, idle, not done, recent. */
  working: Array<Extract<OverviewSessionRow, { section: 'working' }>>;
  /** In work, idle, not done, untouched for days. */
  stalled: Array<Extract<OverviewSessionRow, { section: 'working' }>>;
};

/** Every session sorted into its section: what waits on the user first by urgency, the rest newest first. */
export function buildOverviewSessionSections(
  facts: readonly OverviewSessionFacts[],
  context: { workEnabled: boolean; now: number },
): OverviewSessionSections {
  const sections: OverviewSessionSections = { waiting: [], running: [], done: [], working: [], stalled: [] };
  for (const entry of facts) {
    const row = classifyOverviewSession(entry, context);
    if (!row) continue;
    if (row.section === 'waiting') sections.waiting.push(row);
    else if (row.section === 'running') sections.running.push(row);
    else if (row.section === 'done') sections.done.push(row);
    else if (row.stalled) sections.stalled.push(row);
    else sections.working.push(row);
  }
  sections.waiting.sort((left, right) => (WAITING_ORDER[left.reason] - WAITING_ORDER[right.reason]) || newestFirst(left, right));
  sections.running.sort(newestFirst);
  sections.done.sort(newestFirst);
  sections.working.sort(newestFirst);
  sections.stalled.sort(newestFirst);
  return sections;
}

/** Sessions with a done signal that a veto keeps out of "Looks done": a bulk Done lists them as left out. */
export const overviewLeftOutOfDone = (sections: OverviewSessionSections) => (
  [...sections.working, ...sections.stalled].filter((row) => row.signal !== null)
);

/** What removing a worktree would lose: uncommitted files, and commits nowhere else (null when git could not tell). */
export type OverviewWorktreeLosses = { uncommittedFiles: number; unpushed: boolean | null };

export const isNothingLost = (losses: OverviewWorktreeLosses): boolean => losses.uncommittedFiles === 0 && losses.unpushed === false;

export type OverviewWorktreeFacts = {
  worktree: WorktreeMetadata;
  project: { id: string; path: string };
  /** The branch's change request, or `unknown` while its state has not been read. */
  pr: 'merged' | 'open' | 'closed' | 'none' | 'unknown';
  /** The merged change request's last commit; removal checks nothing is past it. */
  mergedHeadSha: string | null;
  /** Sessions working there, subsessions included. */
  sessions: readonly Session[];
  /** A session there is running or on screen, or the worktree is the directory on screen. */
  inUse: boolean;
  /** Null until git answered; nothing is offered on a guess. */
  git: { losses: OverviewWorktreeLosses; lastCommitAt: number | null } | null;
};

export type OverviewCleanupRow = {
  kind: 'merged' | 'stale';
  facts: OverviewWorktreeFacts;
  losses: OverviewWorktreeLosses;
};

/**
 * A worktree the overview offers to remove: its PR merged, or no open PR and
 * no activity for two weeks. One with a session in work is offered on that
 * session's row instead, and one in use waits.
 */
export function classifyOverviewWorktree(
  facts: OverviewWorktreeFacts,
  context: { workEnabled: boolean; now: number },
): OverviewCleanupRow | null {
  if (facts.inUse || !facts.git) return null;
  if (context.workEnabled && facts.sessions.some((session) => !session.parentID && isSessionInWork(session))) return null;
  const { losses, lastCommitAt } = facts.git;
  if (facts.pr === 'merged') return { kind: 'merged', facts, losses };
  if (facts.pr !== 'none' && facts.pr !== 'closed') return null;
  const lastActivity = Math.max(lastCommitAt ?? 0, ...facts.sessions.map(updatedAt));
  if (lastActivity === 0 || context.now - lastActivity < OVERVIEW_STALE_WORKTREE_AFTER_MS) return null;
  return { kind: 'stale', facts, losses };
}
