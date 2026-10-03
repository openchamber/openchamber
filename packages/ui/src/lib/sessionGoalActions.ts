import { abortCurrentOperation, patchSessionMetadata } from '@/sync/session-actions';
import type { Metadata } from '@/lib/opencode/model';
import { distillGoalObjective } from '@/lib/smallModel';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { deleteGoalObjectiveFile, writeGoalObjectiveFile } from '@/lib/goalObjectiveFiles';
import {
  SESSION_GOAL_OBJECTIVE_CHAR_LIMIT,
  type SessionGoalPayload,
  type SessionGoalStatus,
} from '@/lib/sessionGoalMetadata';

const isRecord = (value: unknown): value is Metadata =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const createGoalId = (): string =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const writeGoal = (
  sessionId: string,
  directory: string | undefined,
  update: (currentGoal: Metadata | null) => Metadata | null,
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
// Any goal source can exceed the objective limit (huge plans, pasted specs,
// long composer prompts). The working agent received the full text in chat;
// only the AUDITOR is bound by the limit — so oversized objectives are
// distilled into completion criteria by the small model, and on a transient
// distillation failure a head+tail excerpt keeps the intent (top) and the
// acceptance criteria (bottom), sacrificing the middle.
const TRIM_MARKER = '\n\n[… objective trimmed for the auditor — the full text was delivered in the chat message …]\n\n';

const fitObjective = async (raw: string): Promise<string> => {
  if (raw.length <= SESSION_GOAL_OBJECTIVE_CHAR_LIMIT) {
    return raw;
  }
  const distilled = await distillGoalObjective(raw);
  if (distilled) {
    return distilled.slice(0, SESSION_GOAL_OBJECTIVE_CHAR_LIMIT);
  }
  const half = Math.max(0, Math.floor((SESSION_GOAL_OBJECTIVE_CHAR_LIMIT - TRIM_MARKER.length) / 2));
  const dictionary = useI18nStore.getState().dictionary;
  toast.error(formatMessage(dictionary, 'chat.goal.toast.distillFallback'));
  return `${raw.slice(0, half)}${TRIM_MARKER}${raw.slice(-half)}`;
};

export async function setSessionGoal(
  sessionId: string,
  directory: string | undefined,
  input: SetSessionGoalInput,
  existing: SessionGoalPayload | null,
): Promise<void> {
  const rawObjective = input.objective.trim();
  if (!rawObjective) {
    throw new Error('Goal objective must not be empty');
  }
  const objective = await fitObjective(rawObjective);
  const tokenBudget = typeof input.tokenBudget === 'number' && Number.isFinite(input.tokenBudget) && input.tokenBudget > 0
    ? Math.floor(input.tokenBudget)
    : null;
  const objectiveFile = await writeGoalObjectiveFile(sessionId, objective);
  const now = Date.now();
  await writeGoal(sessionId, directory, (currentGoal): Metadata => {
    if (existing && currentGoal && currentGoal.id === existing.id && existing.status !== 'complete') {
      // Edit in place: keep accounting, reactivate, clear stale audit state.
      return {
        ...currentGoal,
        objective: objectiveFile ? '' : objective,
        objectiveFile,
        tokenBudget,
        status: 'active',
        statusReason: 'resumed',
        blockedStreak: 0,
        updatedAt: now,
      };
    }
    return {
      id: createGoalId(),
      objective: objectiveFile ? '' : objective,
      objectiveFile,
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
      // An explicit resume grants a fresh auto-continuation allowance —
      // otherwise a goal blocked on the turn cap would re-block on the very
      // next tick and Resume would be a dead end.
      ...(status === 'active' ? { turnsUsed: 0 } : {}),
      updatedAt: Date.now(),
    };
  });
}

export async function clearSessionGoal(sessionId: string, directory: string | undefined): Promise<void> {
  let wasActive = false;
  await writeGoal(sessionId, directory, (currentGoal) => {
    wasActive = currentGoal?.status === 'active';
    return null;
  });
  deleteGoalObjectiveFile(sessionId);
  // Removing a running goal is a "stop" too — abort the current turn like
  // pause does. A no-op when the session is idle.
  if (wasActive) {
    void abortCurrentOperation(sessionId);
  }
}
