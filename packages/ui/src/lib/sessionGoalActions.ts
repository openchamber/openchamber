import { abortCurrentOperation, patchSessionMetadata } from '@/sync/session-actions';
import {
  SESSION_GOAL_OBJECTIVE_CHAR_LIMIT,
  type SessionGoalPayload,
  type SessionGoalStatus,
} from '@/lib/sessionGoalMetadata';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const createGoalId = (): string =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const writeGoal = (
  sessionId: string,
  directory: string | undefined,
  update: (currentGoal: Record<string, unknown> | null) => Record<string, unknown> | null,
) =>
  patchSessionMetadata(sessionId, directory, (metadata) => {
    const namespace = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    const currentGoal = isRecord(namespace.goal) ? namespace.goal : null;
    const nextGoal = update(currentGoal);
    const nextNamespace = { ...namespace };
    if (nextGoal) {
      nextNamespace.goal = nextGoal;
    } else {
      delete nextNamespace.goal;
    }
    return { ...metadata, openchamber: nextNamespace };
  });

export interface SetSessionGoalInput {
  objective: string;
  tokenBudget: number | null;
}

/**
 * Create a new goal (fresh id resets accounting) or edit the existing one
 * (id and usage counters preserved).
 */
export async function setSessionGoal(
  sessionId: string,
  directory: string | undefined,
  input: SetSessionGoalInput,
  existing: SessionGoalPayload | null,
): Promise<void> {
  const objective = input.objective.trim().slice(0, SESSION_GOAL_OBJECTIVE_CHAR_LIMIT);
  if (!objective) {
    throw new Error('Goal objective must not be empty');
  }
  const tokenBudget = typeof input.tokenBudget === 'number' && Number.isFinite(input.tokenBudget) && input.tokenBudget > 0
    ? Math.floor(input.tokenBudget)
    : null;
  const now = Date.now();
  await writeGoal(sessionId, directory, (currentGoal) => {
    if (existing && currentGoal && currentGoal.id === existing.id && existing.status !== 'complete') {
      // Edit in place: keep accounting, reactivate, clear stale audit state.
      return {
        ...currentGoal,
        objective,
        tokenBudget,
        status: 'active',
        statusReason: 'resumed',
        blockedStreak: 0,
        updatedAt: now,
      };
    }
    return {
      id: createGoalId(),
      objective,
      status: 'active',
      tokenBudget,
      tokensUsed: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      note: '',
      statusReason: '',
      lastAccountedMessageID: '',
      createdAt: now,
      updatedAt: now,
    };
  });
}

export async function setSessionGoalStatus(
  sessionId: string,
  directory: string | undefined,
  status: Extract<SessionGoalStatus, 'active' | 'paused' | 'complete'>,
): Promise<void> {
  // Pausing a goal also stops the agent's current turn — same mental model
  // as the stop button, expressed through goal control. A no-op when the
  // session is already idle.
  if (status === 'paused') {
    void abortCurrentOperation(sessionId);
  }
  await writeGoal(sessionId, directory, (currentGoal) => {
    if (!currentGoal) return null;
    return {
      ...currentGoal,
      status,
      // 'resumed' is the server's kickoff signal for an already-idle session.
      statusReason: status === 'active' ? 'resumed' : (status === 'complete' ? 'marked by user' : ''),
      blockedStreak: 0,
      updatedAt: Date.now(),
    };
  });
}

export async function clearSessionGoal(sessionId: string, directory: string | undefined): Promise<void> {
  await writeGoal(sessionId, directory, () => null);
}
