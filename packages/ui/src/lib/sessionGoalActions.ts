import { abortCurrentOperation, patchSessionMetadata } from '@/sync/session-actions';
import type { Metadata } from '@/lib/opencode/model';
import { distillGoalObjective } from '@/lib/smallModel';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { deleteGoalObjectiveFile, writeGoalObjectiveFile } from '@/lib/goalObjectiveFiles';
import { wrapSystemReminder } from '@/lib/systemReminder';
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
  expectedRuntimeKey?: string,
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
  }, expectedRuntimeKey);

export interface SetSessionGoalInput {
  objective: string;
  tokenBudget: number | null;
}

export const sessionGoalIntro = (tokenBudget: number | null): string => {
  const budgetLine = tokenBudget
    ? ` A token budget of ${tokenBudget} tokens applies to this goal.`
    : '';
  return wrapSystemReminder(
    'Goal mode is active for this session. The user message above defines the goal objective.'
    + budgetLine
    + '\n\nWork autonomously through the entire objective in this one run. The user is away and is not reading progress updates.\n'
    + '- When a step is finished, start the next one in the same run.\n'
    + '- Decide open questions yourself with the most sensible default, note the choice, and go on.\n'
    + '- When something fails, find the cause and try another route.\n'
    + '- Check each part by running it, and fix what the check finds.\n'
    + '- Autonomy covers the objective\'s own work. Leave out irreversible or outward-facing actions it does not ask for.\n'
    + '\nYour final message is read by an independent check, and it ends the run. Send it only when the whole objective is done and verified, or when only the user can unblock you. Stopping with work you could still do yourself is an early stop.\n'
    + '\nBefore that message, stop every background command you started that does not finish on its own, such as a dev server or a watcher.\n'
    + '\nEnd that message with a short status block, in the language of your reply, with exactly these four lines:\n'
    + '- Done: what is finished.\n'
    + '- Verified: how you checked it (the command, test or file), or "not verified".\n'
    + '- Remaining: the parts of the objective you still have to do yourself, or "nothing".\n'
    + '- Needs from the user: what only the user can provide before you can go on (credentials, access, a choice you cannot safely default), or "nothing".\n'
    + 'Unless the objective asks for them, testing in the app, review and committing are the user\'s steps after the work, not remaining work and not blockers. When it asks for them, such as a commit or a pull request, they are part of the work. Report what is true: unfinished work goes in Remaining.',
  );
};

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
  expectedRuntimeKey?: string,
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
  }, expectedRuntimeKey);
}

export async function setSessionGoalStatus(
  sessionId: string,
  directory: string | undefined,
  status: Extract<SessionGoalStatus, 'active' | 'paused' | 'complete'>,
): Promise<void> {
  if (status === 'paused') {
    void abortCurrentOperation(sessionId);
  }
  await writeGoal(sessionId, directory, (currentGoal) => {
    if (!currentGoal) return null;
    return {
      ...currentGoal,
      status,
      statusReason: status === 'active' ? 'resumed' : (status === 'complete' ? 'marked by user' : ''),
      blockedStreak: 0,
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
  if (wasActive) {
    void abortCurrentOperation(sessionId);
  }
}
