import type { Session } from '@/lib/opencode/model';
import { SESSION_GOAL_CHAR_LIMIT_MAX } from '@/lib/sessionGoalLimits';

// Session goal driven by the server's session-goal runtime, stored under
// session.metadata.openchamber.goal. The UI writes goals (create/edit/
// pause/resume/clear) by patching this metadata; the server loop accounts
// usage, checks progress with Jev or the small model, and auto-continues the
// session until the goal settles.
export type SessionGoalStatus = 'active' | 'paused' | 'blocked' | 'budgetLimited' | 'complete';

const SESSION_GOAL_STATUSES: SessionGoalStatus[] = ['active', 'paused', 'blocked', 'budgetLimited', 'complete'];

export interface SessionGoalPayload {
  id: string;
  objective: string;
  /** True when the objective text lives in a server-side file keyed by session id. */
  objectiveFile: boolean;
  /**
   * Hash of the objective text as last saved ('' for goals saved before
   * revisions existed). Accounting merge-writes preserve it; a save that
   * changes the objective replaces it — the edit-conflict signal for
   * file-backed goals, whose text the record itself does not carry.
   */
  objectiveRevision: string;
  /** The user switched this goal's length limit off in the goal editor. */
  ignoreObjectiveLimit: boolean;
  status: SessionGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  turnsUsed: number;
  statusReason: string;
  evaluationProviderID: string;
  evaluationModelID: string;
  lastAccountedMessageID: string;
  createdAt: number;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isGoalStatus = (value: unknown): value is SessionGoalStatus =>
  typeof value === 'string' && (SESSION_GOAL_STATUSES as string[]).includes(value);

export function getSessionGoal(session: Session | null | undefined): SessionGoalPayload | null {
  const metadata = (session as { metadata?: unknown } | null | undefined)?.metadata;
  if (!isRecord(metadata)) return null;
  const namespace = metadata.openchamber;
  if (!isRecord(namespace)) return null;
  const goal = namespace.goal;
  if (!isRecord(goal)) return null;

  const id = typeof goal.id === 'string' ? goal.id : '';
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : '';
  const objectiveFile = goal.objectiveFile === true;
  if (!id || (!objective && !objectiveFile) || !isGoalStatus(goal.status)) return null;

  const tokenBudget = typeof goal.tokenBudget === 'number' && Number.isFinite(goal.tokenBudget) && goal.tokenBudget > 0
    ? Math.floor(goal.tokenBudget)
    : null;
  const asCount = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

  return {
    id,
    // The limit is applied when a goal is saved; reading keeps what was saved.
    objective: objective.slice(0, SESSION_GOAL_CHAR_LIMIT_MAX),
    objectiveFile,
    objectiveRevision: typeof goal.objectiveRevision === 'string' ? goal.objectiveRevision : '',
    ignoreObjectiveLimit: goal.ignoreObjectiveLimit === true,
    status: goal.status,
    tokenBudget,
    tokensUsed: asCount(goal.tokensUsed),
    turnsUsed: asCount(goal.turnsUsed),
    statusReason: typeof goal.statusReason === 'string' ? goal.statusReason : '',
    evaluationProviderID: typeof goal.evaluationProviderID === 'string' ? goal.evaluationProviderID : '',
    evaluationModelID: typeof goal.evaluationModelID === 'string' ? goal.evaluationModelID : '',
    lastAccountedMessageID: typeof goal.lastAccountedMessageID === 'string' ? goal.lastAccountedMessageID : '',
    createdAt: typeof goal.createdAt === 'number' ? goal.createdAt : 0,
    updatedAt: typeof goal.updatedAt === 'number' ? goal.updatedAt : 0,
  };
}

export function formatGoalTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}K`;
  if (count >= 1_000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}
