import { z } from 'zod';

import type { GoalWriterChoice } from '@/lib/goalWriter';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useUIStore } from '@/stores/useUIStore';

// The local history of model and effort choices the user makes by hand
// (packages/web/server/lib/model-choices). The server keeps it, builds notes
// and Settings suggestions from it; this module sends choices and reads the
// answer, parsed once at the boundary. A choice never carries message text,
// only a size bucket of the input it was made for.

type ModelChoiceSurface = 'goal-writer' | 'composer';
type ModelChoiceInputSize = 'empty' | 'short' | 'medium' | 'long' | 'unknown';

type ModelSelection = { model: string; variant: string | null };

interface ModelChoice {
  surface: ModelChoiceSurface;
  /** `model` when the model changed, `effort` when only the effort did. */
  kind: 'model' | 'effort';
  chosen: ModelSelection;
  /** What was in effect before the choice: the goal window's default, or the composer's previous selection. */
  replaced: ModelSelection | null;
  sessionModel: string | null;
  inputSize: ModelChoiceInputSize;
}

const SHORT_INPUT_MAX = 280;
const MEDIUM_INPUT_MAX = 2_000;

/** The size bucket of an input of `length` characters; null when the input is not known. */
export const inputSizeBucket = (length: number | null): ModelChoiceInputSize => {
  if (length === null) return 'unknown';
  if (length === 0) return 'empty';
  if (length <= SHORT_INPUT_MAX) return 'short';
  if (length <= MEDIUM_INPUT_MAX) return 'medium';
  return 'long';
};

const sameSelection = (a: ModelSelection | null, b: ModelSelection): boolean => (
  a !== null && a.model === b.model && a.variant === b.variant
);

/**
 * The choice of `chosen` over `replaced`, or null when nothing changed: a
 * pick of what was already in effect is no choice.
 */
export const describeModelChoice = (
  input: Omit<ModelChoice, 'kind'>,
): ModelChoice | null => {
  if (sameSelection(input.replaced, input.chosen)) return null;
  const kind = input.replaced && input.replaced.model === input.chosen.model ? 'effort' : 'model';
  return { ...input, kind };
};

/**
 * Sends one choice. Fire and forget: a lost choice costs one data point and
 * must never get in the way of the pick itself. Nothing is sent while
 * recording is off (the server refuses then too) or in VS Code, which has
 * no OpenChamber server.
 */
export const recordModelChoice = (choice: ModelChoice | null): void => {
  if (!choice || isVSCodeRuntime() || !useUIStore.getState().modelChoiceRecordingEnabled) return;
  void runtimeFetch('/api/openchamber/model-choices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(choice),
  }).catch(() => undefined);
};

const modelRef = (choice: { providerID: string; modelID: string }): string => `${choice.providerID}/${choice.modelID}`;

/**
 * A goal written by a model picked in the goal window. `writerDefault` is
 * the Settings writer model, else the session's model writes.
 */
export const recordGoalWriterChoice = ({ writer, writerDefault, sessionModel, inputLength }: {
  writer: GoalWriterChoice;
  writerDefault: GoalWriterChoice | null;
  sessionModel: { providerID: string; modelID: string } | null;
  inputLength: number | null;
}): void => {
  const fallback = writerDefault ?? (sessionModel ? { ...sessionModel, variant: null } : null);
  recordModelChoice(describeModelChoice({
    surface: 'goal-writer',
    chosen: { model: modelRef(writer), variant: writer.variant },
    replaced: fallback ? { model: modelRef(fallback), variant: fallback.variant } : null,
    sessionModel: sessionModel ? modelRef(sessionModel) : null,
    inputSize: inputSizeBucket(inputLength),
  }));
};

const suggestionSchema = z.object({
  id: z.string().min(1),
  surface: z.literal('goal-writer'),
  model: z.string(),
  variant: z.string().nullable(),
  count: z.number(),
  total: z.number(),
});

const summarySchema = z.object({
  enabled: z.boolean(),
  total: z.number(),
  suggestions: z.array(suggestionSchema),
});

const decisionSchema = z.object({
  settings: z.object({ sessionGoalWriterModel: z.string(), sessionGoalWriterVariant: z.string() }).nullable(),
});

type ModelChoiceSummary = z.infer<typeof summarySchema>;
export type ModelChoiceSuggestion = z.infer<typeof suggestionSchema>;

/** Whether recording is on, how many choices are kept, and the suggestions on offer. Throws on failure. */
export const readModelChoices = async (signal?: AbortSignal): Promise<ModelChoiceSummary> => {
  const response = await runtimeFetch('/api/openchamber/model-choices?limit=0', { signal });
  if (!response.ok) throw new Error(`Reading model choices failed (${response.status})`);
  const parsed = summarySchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Model choices answered in an unknown shape');
  return parsed.data;
};

/** Removes every recorded choice and answer. */
export const clearModelChoices = async (): Promise<void> => {
  const response = await runtimeFetch('/api/openchamber/model-choices', { method: 'DELETE' });
  if (!response.ok) throw new Error(`Clearing model choices failed (${response.status})`);
};

/**
 * Approves or declines a suggestion. Approve writes the settings on the
 * server and returns what it wrote; decline returns null.
 */
export const answerModelChoiceSuggestion = async (
  id: string,
  decision: 'approved' | 'declined',
): Promise<{ sessionGoalWriterModel: string; sessionGoalWriterVariant: string } | null> => {
  const response = await runtimeFetch('/api/openchamber/model-choices/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, decision }),
  });
  if (!response.ok) throw new Error(`Answering the suggestion failed (${response.status})`);
  const parsed = decisionSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('The suggestion answer came back in an unknown shape');
  return parsed.data.settings;
};
