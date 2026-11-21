import { GOAL_MISSION_INSTRUCTIONS, GOAL_REPORT_INSTRUCTIONS } from './audit.js';
import { GOAL_OBJECTIVE_CHAR_LIMIT, writeObjective } from './objectives.js';

export interface CreatedSessionGoal {
  id: string;
  objective: string;
  objectiveFile: boolean;
  status: 'active';
  tokenBudget: number | null;
  tokensUsed: number;
  turnsUsed: number;
  blockedStreak: number;
  note: string;
  statusReason: string;
  lastAccountedMessageID: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionGoalInput {
  baseUrl?: string;
  authHeaders?: HeadersInit;
  sessionID: string;
  directory: string;
  objective: unknown;
  tokenBudget?: number | null | undefined;
  providerID?: unknown;
  modelID?: unknown;
  onWarning?: (message: string, cause: unknown) => void;
  persistSessionGoal?: ((sessionID: string, directory: string, goal: CreatedSessionGoal) => void) | null;
}

const hasMessage = (value: unknown): value is { message?: unknown } => value != null;

const TRIM_MARKER = '\n\n[… objective trimmed for the auditor — the full prompt was delivered in the chat message …]\n\n';

export const buildGoalIntroText = (tokenBudget: number | null | undefined) => {
  const budgetLine = tokenBudget
    ? ` A token budget of ${tokenBudget} tokens applies to this goal.`
    : '';
  return '<system-reminder>\n'
    + 'Goal mode is active for this session. The user message above defines the goal objective.'
    + budgetLine
    + `\n\n${GOAL_MISSION_INSTRUCTIONS}`
    + `\n\n${GOAL_REPORT_INSTRUCTIONS}`
    + '\n</system-reminder>';
};

const fitObjective = async ({ objective, directory, sessionID, providerID, modelID, warn }: {
  objective: string;
  directory: string;
  sessionID: string;
  providerID: unknown;
  modelID: unknown;
  warn: (message: string, cause: unknown) => void;
}) => {
  if (objective.length <= GOAL_OBJECTIVE_CHAR_LIMIT) return objective;

  let distilled = null;
  try {
    const { generateSmallModelText } = await import('../small-model/index.js');
    const generated = await generateSmallModelText({
      prompt: objective,
      system: [
        'You distill a large task description into the COMPLETION CRITERIA a progress auditor will judge against.',
        'Return ONLY the criteria text — no preamble, no headers, no markdown fences.',
        'Capture: the end goals, what must exist and work when the task is fully done, and how each major part is verified. Omit implementation steps.',
        'Preserve verbatim any file paths, commands, and identifiers that define the task.',
        'Stay under 4000 characters.',
        'Write in the same language as the task text.',
      ].join('\n'),
      directory,
      sessionID,
      preferredProviderID: providerID,
      preferredModelID: modelID,
    });
    distilled = generated?.text.trim() ?? null;
  } catch (error) {
    warn('goal objective distillation failed', error);
  }

  if (distilled) return distilled.slice(0, GOAL_OBJECTIVE_CHAR_LIMIT);
  const half = Math.max(0, Math.floor((GOAL_OBJECTIVE_CHAR_LIMIT - TRIM_MARKER.length) / 2));
  return `${objective.slice(0, half)}${TRIM_MARKER}${objective.slice(-half)}`;
};

export const createSessionGoal = async ({
  baseUrl,
  authHeaders,
  sessionID,
  directory,
  objective,
  tokenBudget = null,
  providerID,
  modelID,
  onWarning,
  persistSessionGoal,
}: CreateSessionGoalInput) => {
  const warn = (message: string, cause: unknown) => {
    if (onWarning) {
      onWarning(message, cause);
      return;
    }
    console.warn(`[session-goal] ${message}:`, (hasMessage(cause) ? cause.message : undefined) || cause);
  };
  const objectiveText = await fitObjective({
    objective: String(objective ?? '').trim(),
    directory,
    sessionID,
    providerID,
    modelID,
    warn,
  });
  if (!objectiveText) throw new Error('goal objective is required');

  let objectiveFile = false;
  try {
    await writeObjective(sessionID, objectiveText);
    objectiveFile = true;
  } catch (error) {
    warn('goal objective file write failed, falling back to inline', error);
  }

  const now = Date.now();
  const goal: CreatedSessionGoal = {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    objective: objectiveFile ? '' : objectiveText.slice(0, GOAL_OBJECTIVE_CHAR_LIMIT),
    objectiveFile,
    status: 'active',
    tokenBudget: tokenBudget || null,
    tokensUsed: 0,
    turnsUsed: 0,
    blockedStreak: 0,
    note: '',
    statusReason: '',
    lastAccountedMessageID: '',
    createdAt: now,
    updatedAt: now,
  };
  void baseUrl;
  void authHeaders;
  if (!persistSessionGoal) {
    throw new Error('goal mode needs a session metadata store to save the goal in');
  }
  await persistSessionGoal(sessionID, directory, goal);
  return goal;
};
