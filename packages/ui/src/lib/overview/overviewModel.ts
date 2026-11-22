import { z } from 'zod';
import type { Session } from '@/lib/opencode/model';
import { getCurrentSessionAssist } from '@/lib/sessionAssistMetadata';
import { isDoneSuggested, isSessionInWork } from '@/lib/sessionWorkMetadata';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { isSessionUnread } from '@/sync/session-unread';
import type { WorktreeMetadata } from '@/types/worktree';

export const OVERVIEW_STALLED_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
export const OVERVIEW_STALE_WORKTREE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
export const OVERVIEW_UNTRACKED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type OverviewActivity = 'running' | 'subagent' | 'shell' | 'image' | 'pullRequest' | 'extensionWait';

export type OverviewBlocking = 'permission' | 'question';

export type OverviewSessionFacts = {
  session: Session;
  activity: OverviewActivity | null;
  blocking: OverviewBlocking | null;
  prs: readonly PrVisualSummary[];
  prsPending: boolean;
  issues: ReadonlyArray<'open' | 'completed' | 'dropped' | null>;
  worktreeDirty: boolean | null;
};

export type OverviewWaitingReason = 'permission' | 'question' | 'error' | 'checks' | 'conflict' | 'finished';
export type OverviewDoneSignal = 'merged' | 'issueClosed' | 'issueDropped' | 'hint';
export type OverviewVeto = 'failed' | 'suggestion' | 'uncommitted';

export type OverviewSessionRow =
  | { section: 'waiting'; session: Session; reason: OverviewWaitingReason; pr: PrVisualSummary | null }
  | { section: 'running'; session: Session; activity: OverviewActivity }
  | { section: 'done'; session: Session; signal: OverviewDoneSignal }
  | { section: 'working'; session: Session; signal: OverviewDoneSignal | null; veto: OverviewVeto | null; stalled: boolean };

const kindSchema = z.object({ openchamber: z.object({ kind: z.string() }) });

const sessionKind = (session: Session): string | null => kindSchema.safeParse(session.metadata).data?.openchamber.kind ?? null;

const blockedReason = (prs: readonly PrVisualSummary[]): { reason: 'checks' | 'conflict'; pr: PrVisualSummary } | null => {
  const blocked = prs.find((pr) => pr.visualState === 'blocked');
  if (!blocked) return null;
  return { reason: blocked.mergeableState !== 'dirty' && blocked.checks?.state === 'failure' ? 'checks' : 'conflict', pr: blocked };
};

export const isOverviewFollowed = (session: Session, context: { workEnabled: boolean; now: number }): boolean => (
  context.workEnabled ? isSessionInWork(session) : context.now - session.time.updated < OVERVIEW_UNTRACKED_WINDOW_MS
);

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

export function classifyOverviewSession(
  facts: OverviewSessionFacts,
  context: { workEnabled: boolean; now: number },
): OverviewSessionRow | null {
  const { session } = facts;
  const kind = sessionKind(session);
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
  working: Array<Extract<OverviewSessionRow, { section: 'working' }>>;
  stalled: Array<Extract<OverviewSessionRow, { section: 'working' }>>;
};

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

export const overviewLeftOutOfDone = (sections: OverviewSessionSections) => (
  [...sections.working, ...sections.stalled].filter((row) => row.signal !== null)
);

export type OverviewWorktreeLosses = { uncommittedFiles: number; unpushed: boolean | null };

export const isNothingLost = (losses: OverviewWorktreeLosses): boolean => losses.uncommittedFiles === 0 && losses.unpushed === false;

export type OverviewWorktreeFacts = {
  worktree: WorktreeMetadata;
  project: { id: string; path: string };
  pr: 'merged' | 'open' | 'closed' | 'none' | 'unknown';
  mergedHeadSha: string | null;
  sessions: readonly Session[];
  inUse: boolean;
  git: { losses: OverviewWorktreeLosses; lastCommitAt: number | null } | null;
};

export type OverviewCleanupRow = {
  kind: 'merged' | 'stale';
  facts: OverviewWorktreeFacts;
  losses: OverviewWorktreeLosses;
};

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
