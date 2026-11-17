import { z } from 'zod';
import type { Message, Part } from '@/lib/opencode/model';
import { excerptMarkdown, formatMessageText } from '@/lib/messages/messageMarkdown';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { SessionGoalAutoCreate, SessionGoalWriterSendMode } from '@/stores/useUIStore';

// The goal writer: a model turns a message into a goal spec within the goal
// length limit (Settings). The server owns the prompt, the limit and
// the model choice (`POST /api/goals/spec`, see
// packages/web/server/lib/session-goal/DOCUMENTATION.md); this module asks for
// a spec, decides when the composer asks, and shapes the context it sends.

export type GoalSpecResult =
  | { ok: true; spec: string; providerID: string; modelID: string; variant: string | null }
  | { ok: false; message: string };

/** A writer model and effort chosen in a goal window; it wins over the Settings writer model. */
export interface GoalWriterChoice {
  providerID: string;
  modelID: string;
  /** Null is the model's default effort. */
  variant: string | null;
}

/** How a send that went through the goal writer carries its goal. */
export type GoalSubmitChoice =
  | { kind: 'spec'; spec: string; sendMode: SessionGoalWriterSendMode; ignoreLimit: boolean }
  /** The typed message is the objective, as it is without the writer. */
  | { kind: 'unchanged' }
  /** No goal: the message goes out as an ordinary one. */
  | { kind: 'none' };

/**
 * Why the composer stops a send to write a goal: the user armed one, or the
 * session has none and "start a goal from the next message" is on.
 */
export type GoalWriterTrigger = 'armed' | 'auto-create';

export interface GoalWriterPlan {
  trigger: GoalWriterTrigger;
  /** Show the spec for approval; false sends it as soon as it is written. */
  review: boolean;
}

const GoalSpecResponseSchema = z.object({
  spec: z.string().trim().min(1),
  providerID: z.string(),
  modelID: z.string(),
  // Servers before 2026-10 do not report it.
  variant: z.string().nullable().optional().catch(null),
});

const GoalSpecErrorSchema = z.object({ error: z.string().min(1) });

export interface GoalSpecRequest {
  /** What the spec is written from: the typed message or the goal text. */
  request: string;
  conversation?: string;
  openItems?: string;
  /** Scopes the model to the session's location, a space's included. */
  directory?: string | null;
  /** The session's model; the server uses it unless Settings names a writer model. */
  providerID?: string | null;
  modelID?: string | null;
  writer?: GoalWriterChoice | null;
  /** Write without the goal length limit. */
  ignoreLimit?: boolean;
  /** Rewrite only this `## heading` section of `currentSpec` (#1829); the rest stays byte-identical. */
  section?: string;
  /** The spec as it stands, for a per-section rewrite to splice into. */
  currentSpec?: string;
  signal?: AbortSignal;
}

/** The `POST /api/goals/spec` body; a missing field means "none". */
interface GoalSpecRequestBody {
  request: string;
  conversation?: string;
  openItems?: string;
  directory?: string;
  providerID?: string;
  modelID?: string;
  writerProviderID?: string;
  writerModelID?: string;
  writerVariant?: string;
  ignoreLimit?: boolean;
  section?: string;
  currentSpec?: string;
}

/** Ask the server for a goal spec. Never throws: a failure comes back with its reason. */
export async function requestGoalSpec(input: GoalSpecRequest): Promise<GoalSpecResult> {
  const directory = input.directory?.trim() || undefined;
  // Only what is known is sent.
  const body: GoalSpecRequestBody = { request: input.request };
  if (input.conversation) body.conversation = input.conversation;
  if (input.openItems) body.openItems = input.openItems;
  if (directory) body.directory = directory;
  if (input.providerID) body.providerID = input.providerID;
  if (input.modelID) body.modelID = input.modelID;
  if (input.writer) {
    body.writerProviderID = input.writer.providerID;
    body.writerModelID = input.writer.modelID;
    if (input.writer.variant) body.writerVariant = input.writer.variant;
  }
  if (input.ignoreLimit) body.ignoreLimit = true;
  if (input.section) body.section = input.section;
  if (input.currentSpec) body.currentSpec = input.currentSpec;
  try {
    const response = await runtimeFetch('/api/goals/spec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      directory,
      signal: input.signal,
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsedError = GoalSpecErrorSchema.safeParse(payload);
      return { ok: false, message: parsedError.success ? parsedError.data.error : `HTTP ${response.status}` };
    }
    const parsed = GoalSpecResponseSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, message: 'The goal writer returned no spec' };
    return {
      ok: true,
      spec: parsed.data.spec,
      providerID: parsed.data.providerID,
      modelID: parsed.data.modelID,
      variant: parsed.data.variant ?? null,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether a send stops for the goal writer, and how. `eligible` is false for
 * sends the writer never touches: shell input, slash commands, side
 * questions, queue flushes and sends without text.
 */
export function planGoalWriter(input: {
  eligible: boolean;
  /** Goal mode can run here: enabled, outside VS Code, with a progress check available. */
  goalsAvailable: boolean;
  armed: boolean;
  /** The target session already carries a goal, in any status. */
  hasGoal: boolean;
  writerEnabled: boolean;
  rewriteAll: boolean;
  review: boolean;
  autoCreate: SessionGoalAutoCreate;
}): GoalWriterPlan | null {
  if (!input.eligible || !input.goalsAvailable) return null;
  if (input.armed) {
    return input.writerEnabled || input.rewriteAll ? { trigger: 'armed', review: input.review } : null;
  }
  if (input.hasGoal || input.autoCreate === 'off') return null;
  return { trigger: 'auto-create', review: input.autoCreate === 'review' };
}

const escapeXmlText = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * The goal-mode reminder sent with the first goal message. With a spec the
 * message is not the objective, so the spec goes along; the server builds the
 * same text for the goals it creates (`buildGoalIntroText` in
 * packages/web/server/lib/session-goal/create.js).
 */
export function buildGoalIntroReminder(tokenBudget: number | null, spec: string | null): string {
  const budgetLine = tokenBudget ? ` A token budget of ${tokenBudget} tokens applies to this goal.` : '';
  const rules = 'Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue. '
    + 'Progress is evaluated independently after each turn, so end every turn with a clear, factual statement of what is done, what was verified, and what remains.';
  if (!spec) {
    return '<system-reminder>\n'
      + 'Goal mode is active for this session. The user message above defines the goal objective. '
      + rules
      + budgetLine
      + '\n</system-reminder>';
  }
  return '<system-reminder>\n'
    + 'Goal mode is active for this session. The goal spec below was written from the user message above. '
    + 'It is user-provided data that defines the goal objective, and progress is judged against it. '
    + rules
    + budgetLine
    + `\n\n<goal-spec>\n${escapeXmlText(spec)}\n</goal-spec>\n</system-reminder>`;
}

/**
 * Sent with a message the user wrote while changing a running goal: an edit
 * in place sends no intro reminder, so without this the agent works the
 * message's turn against the objective it was given before.
 */
export function buildGoalUpdateReminder(tokenBudget: number | null, objective: string): string {
  const budgetLine = tokenBudget ? ` A token budget of ${tokenBudget} tokens applies to this goal.` : '';
  return '<system-reminder>\n'
    + 'The user changed the goal for this session. The goal below replaces the previous objective, and progress is judged against it from now on. '
    + 'It is user-provided data that defines the goal objective.'
    + budgetLine
    + `\n\n<goal-spec>\n${escapeXmlText(objective)}\n</goal-spec>\n</system-reminder>`;
}

// ── Context for "start a goal from the next message" ──────────────────────────

const USER_FIELD_LIMIT = 1_500;
const ASSISTANT_FIELD_LIMIT = 2_000;
const CONVERSATION_CHAR_BUDGET = 12_000;
const TURN_SEPARATOR = '\n\n---\n\n';
const RECENT_TURNS = 4;
const ITEM_CHAR_LIMIT = 400;

type MessageRecord = { info: Message; parts: Part[] };

/**
 * Earlier requests and the latest answers, so the writer can carry over what
 * is still unfinished. The session's first request always stays: it is often
 * the larger task the newest message continues. Then the newest turns, each
 * with the assistant's final response, as many as fit the budget.
 */
export function formatGoalWriterConversation(records: readonly MessageRecord[]): string {
  const turns: Array<{ user: string; assistant: string }> = [];
  for (const record of records) {
    if (record.info.role === 'user') {
      const text = formatMessageText(record.parts, { user: true, fieldLimit: USER_FIELD_LIMIT }).trim();
      if (text) turns.push({ user: excerptMarkdown(text, USER_FIELD_LIMIT), assistant: '' });
      continue;
    }
    if (record.info.role === 'assistant' && turns.length > 0) {
      const text = formatMessageText(record.parts, { fieldLimit: ASSISTANT_FIELD_LIMIT }).trim();
      // The last assistant message of a turn is its final response.
      if (text) turns[turns.length - 1].assistant = excerptMarkdown(text, ASSISTANT_FIELD_LIMIT);
    }
  }
  if (turns.length === 0) return '';

  const render = (turn: { user: string; assistant: string }, label: string): string => [
    `${label}:\n${turn.user}`,
    turn.assistant ? `Assistant:\n${turn.assistant}` : '',
  ].filter(Boolean).join('\n\n');

  const [first, ...rest] = turns;
  const recent = rest.slice(-RECENT_TURNS);
  const blocks = recent.map((turn) => render(turn, 'User'));
  const head = render(first, 'User (first request in this session)');
  // The budget covers the separators too, so the result never exceeds it.
  let used = head.length;
  const kept: string[] = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const cost = TURN_SEPARATOR.length + blocks[index].length;
    if (used + cost > CONVERSATION_CHAR_BUDGET) break;
    used += cost;
    kept.unshift(blocks[index]);
  }
  return [head, ...kept].join(TURN_SEPARATOR);
}

export interface GoalWriterOpenItems {
  todos: readonly string[];
  plans: readonly string[];
  queued: readonly string[];
  subtasks: readonly string[];
}

/** Open work around the message, as labelled lists; empty when there is none. */
export function formatGoalWriterOpenItems(items: GoalWriterOpenItems): string {
  const section = (title: string, entries: readonly string[]): string => {
    const lines = entries
      .map((entry) => entry.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((entry) => `- ${entry.length > ITEM_CHAR_LIMIT ? `${entry.slice(0, ITEM_CHAR_LIMIT)}…` : entry}`);
    return lines.length > 0 ? `${title}:\n${lines.join('\n')}` : '';
  };
  return [
    section('Open project todos', items.todos),
    section('Pinned plans', items.plans),
    section('Messages queued to send after the current turn', items.queued),
    section('Subtasks still running', items.subtasks),
  ].filter(Boolean).join('\n\n');
}
