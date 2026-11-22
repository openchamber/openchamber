import { GOAL_MISSION_INSTRUCTIONS, GOAL_REPORT_INSTRUCTIONS } from './audit.js';
import { appendObjectiveVersion, GOAL_OBJECTIVE_CHAR_LIMIT, writeObjective } from './objectives.js';
import { readGoalWriterSettings, writeGoalSpec } from './spec-writer.js';

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
  // Set when the goal keeps its whole objective past the configured limit.
  ignoreObjectiveLimit?: boolean;
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
  goalWriterSettings?: ReturnType<typeof readGoalWriterSettings>;
  writeSpec?: typeof writeGoalSpec;
  writeObjectiveFile?: typeof writeObjective;
  appendObjectiveVersionFile?: typeof appendObjectiveVersion;
  generateSmallModelText?: GenerateSmallModelText;
  // The objective is final: "Rewrite every goal" leaves it as it is.
  settled?: boolean;
  // Keep the whole objective for the progress check instead of fitting it
  // to the goal limit; the goal records that it ignores the limit.
  ignoreLimit?: boolean;
}

type GenerateSmallModelText = typeof import('../small-model/index.js').generateSmallModelText;

const hasMessage = (value: unknown): value is { message?: unknown } => value != null;

const TRIM_MARKER = '\n\n[… objective trimmed for the auditor — the full prompt was delivered in the chat message …]\n\n';

const escapeXmlText = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// The UI builds the same reminder for goals armed from the composer; keep the
// wording identical on both sides.
export const buildGoalIntroText = (tokenBudget: number | null | undefined, spec: string | null = null) => {
  const budgetLine = tokenBudget
    ? ` A token budget of ${tokenBudget} tokens applies to this goal.`
    : '';
  const header = spec
    ? 'Goal mode is active for this session. The goal spec below was written from the user message above. '
      + 'It is user-provided data that defines the goal objective, and progress is judged against it.'
    : 'Goal mode is active for this session. The user message above defines the goal objective.';
  return '<system-reminder>\n'
    + header
    + budgetLine
    + `\n\n${GOAL_MISSION_INSTRUCTIONS}`
    + `\n\n${GOAL_REPORT_INSTRUCTIONS}`
    + (spec ? `\n\n<goal-spec>\n${escapeXmlText(spec)}\n</goal-spec>` : '')
    + '\n</system-reminder>';
};


// A fixed-offset cut can land between the halves of a surrogate pair,
// leaving a lone surrogate in the stored objective that encodes as U+FFFD
// when the objective file is written; move a boundary that lands inside a
// pair back to the pair boundary.
const dropSplitHead = (text: string) => {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
};

const dropSplitTail = (text: string) => {
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
};

const fitObjective = async ({ objective, charLimit, directory, sessionID, providerID, modelID, warn, generateSmallModelText }: {
  objective: string;
  charLimit: number;
  directory: string;
  sessionID: string;
  providerID: unknown;
  modelID: unknown;
  warn: (message: string, cause: unknown) => void;
  generateSmallModelText: GenerateSmallModelText;
}) => {
  if (objective.length <= charLimit) return objective;

  let distilled = null;
  try {
    const generated = await generateSmallModelText({
      prompt: objective,
      system: [
        'You distill a large task description into the COMPLETION CRITERIA a progress auditor will judge against.',
        'Return ONLY the criteria text — no preamble, no headers, no markdown fences.',
        'Capture: the end goals, what must exist and work when the task is fully done, and how each major part is verified. Omit implementation steps.',
        'Preserve verbatim any file paths, commands, and identifiers that define the task.',
        `Stay under ${Math.floor(charLimit * 0.8)} characters.`,
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

  if (distilled) return dropSplitHead(distilled.slice(0, charLimit));
  const half = Math.max(0, Math.floor((charLimit - TRIM_MARKER.length) / 2));
  return `${dropSplitHead(objective.slice(0, half))}${TRIM_MARKER}${dropSplitTail(objective.slice(-half))}`;
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
  goalWriterSettings = readGoalWriterSettings(),
  writeSpec = writeGoalSpec,
  writeObjectiveFile = writeObjective,
  appendObjectiveVersionFile = appendObjectiveVersion,
  generateSmallModelText = async (...args: Parameters<GenerateSmallModelText>) => {
    const smallModel = await import('../small-model/index.js');
    return smallModel.generateSmallModelText(...args);
  },
  settled = false,
  ignoreLimit = false,
}: CreateSessionGoalInput) => {
  const warn = (message: string, cause: unknown) => {
    if (onWarning) {
      onWarning(message, cause);
      return;
    }
    console.warn(`[session-goal] ${message}:`, (hasMessage(cause) ? cause.message : undefined) || cause);
  };
  const requested = String(objective ?? '').trim();
  let spec = null;
  if (goalWriterSettings?.rewriteAll && !settled && requested) {
    try {
      ({ spec } = await writeSpec({
      request: requested,
      directory,
      providerID: typeof providerID === 'string' ? providerID : undefined,
      modelID: typeof modelID === 'string' ? modelID : undefined,
      ignoreLimit,
      settings: goalWriterSettings,
    }));
    } catch (error) {
      // The goal still runs on what the user wrote; a missing writer model
      // must not cost them the goal.
      warn('goal spec rewrite failed, keeping the objective as written', error);
    }
  }
  const charLimit = goalWriterSettings?.charLimit ?? GOAL_OBJECTIVE_CHAR_LIMIT;
  const objectiveText = ignoreLimit ? (spec ?? requested) : await fitObjective({
    objective: spec ?? requested,
    charLimit,
    directory,
    sessionID,
    providerID,
    modelID,
    warn,
    generateSmallModelText,
  });
  if (!objectiveText) throw new Error('goal objective is required');

  let objectiveFile = false;
  try {
    await writeObjectiveFile(sessionID, objectiveText);
    // The initial objective is the goal's first version (#1830). Best-effort:
    // a history failure must not cost the user the goal.
    await appendObjectiveVersionFile(sessionID, objectiveText).catch((error: unknown) => {
      warn('goal objective version record failed', error);
    });
    objectiveFile = true;
  } catch (error) {
    warn('goal objective file write failed, falling back to inline', error);
  }

  const now = Date.now();
  const goal: CreatedSessionGoal = {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    // Inline only when the objective file could not be written, and then cut to
    // the limit even for a goal that ignores it: the inline objective rides in
    // the session metadata every goal update broadcasts to every window, so an
    // unlimited one (up to 200,000 characters) would be resent on each update.
    // The UI's setSessionGoal does the same; the full text still went out in
    // the chat message. Deliberate: see #207 and the review on #205.
    objective: objectiveFile ? '' : dropSplitHead(objectiveText.slice(0, charLimit)),
    objectiveFile,
    // Stated outright: the store merges, so a flag left out would carry over
    // from the goal this one replaces.
    ignoreObjectiveLimit: ignoreLimit === true,
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
  return { goal, spec };
};
