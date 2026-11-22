/**
 * Notes and suggestions built from the recorded model choices. Deterministic:
 * the same events always give the same notes, and no model is asked.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** The goal writer settings a suggestion compares against; anything else reads as unset. */
const goalWriterSettingsSchema = z.object({
  sessionGoalWriterModel: z.string().trim().catch(''),
  sessionGoalWriterVariant: z.string().trim().catch(''),
});

/** A note needs at least this many matching choices. */
const MIN_NOTE_COUNT = 2;
/** A suggestion reads the surface's most recent choices only, so it follows today's habit. */
const SUGGESTION_WINDOW = 20;
/** And needs this many matching choices among them, ... */
const MIN_SUGGESTION_COUNT = 5;
/** ... making up at least this share of the window. */
const MIN_SUGGESTION_SHARE = 0.7;
/** A detail (input size, what it replaced) is named when it covers this share of the note's choices. */
const DOMINANT_SHARE = 0.7;
const MAX_NOTES = 20;

const SURFACE_PURPOSE = {
  'goal-writer': 'goal specs',
  composer: 'chat messages',
};

const POOL_PROVIDER = 'opencode-route';

const modelLabel = (ref) => {
  const separator = ref.indexOf('/');
  const provider = ref.slice(0, separator);
  const id = ref.slice(separator + 1);
  return provider === POOL_PROVIDER ? `pool ${id}` : id;
};

const selectionLabel = ({ model, variant }) => `${variant ? `${variant} effort` : 'default effort'} on ${modelLabel(model)}`;

/**
 * A selection's identity: a versioned, domain-separated hash of the canonical
 * tuple [model, variant], JSON-encoded so null stays distinct from every
 * string (including 'default' and '') and delimiters inside either field can
 * never shift a boundary. Fixed-size, so identities stay far under the
 * 400-character decision-id limit in store.js and routes.js however long
 * the model or variant is.
 */
const selectionDigest = (domain, { model, variant }) => createHash("sha256")
  .update(JSON.stringify([domain, model, variant ?? null]))
  .digest("hex");

const selectionKey = (selection) => `v2:${selectionDigest("model-choice-selection", selection)}`;

/** The value that covers at least `DOMINANT_SHARE` of `values`, or null. */
const dominant = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const [value, count] of counts) {
    if (count / values.length >= DOMINANT_SHARE) return value;
  }
  return null;
};

/** Choices of one surface grouped by what was chosen, largest group first; ties go to the most recent. */
const groupByChoice = (events) => {
  const groups = new Map();
  events.forEach((event, index) => {
    const key = selectionKey(event.chosen);
    const group = groups.get(key) ?? { chosen: event.chosen, events: [], lastIndex: 0 };
    group.events.push(event);
    group.lastIndex = index;
    groups.set(key, group);
  });
  return [...groups.values()].sort((a, b) => (b.events.length - a.events.length) || (b.lastIndex - a.lastIndex));
};

const bySurface = (events) => {
  const surfaces = new Map();
  for (const event of events) {
    const list = surfaces.get(event.surface) ?? [];
    list.push(event);
    surfaces.set(event.surface, list);
  }
  return surfaces;
};

/**
 * One note per surface and choice made at least twice, such as "picks low
 * effort on claude-opus-4 for goal specs (7 of 9 times)". Events are oldest
 * first, as the store keeps them.
 */
export const buildModelChoiceNotes = (events) => {
  const notes = [];
  for (const [surface, surfaceEvents] of bySurface(events)) {
    const total = surfaceEvents.length;
    for (const group of groupByChoice(surfaceEvents)) {
      const count = group.events.length;
      if (count < MIN_NOTE_COUNT) continue;
      const inputSize = dominant(group.events.map((event) => event.inputSize).filter((size) => size !== 'unknown'));
      const replacedKey = dominant(group.events.map((event) => (event.replaced ? selectionKey(event.replaced) : 'none')));
      const replaced = replacedKey && replacedKey !== 'none'
        ? group.events.find((event) => event.replaced && selectionKey(event.replaced) === replacedKey).replaced
        : null;
      let text = `picks ${selectionLabel(group.chosen)} for ${SURFACE_PURPOSE[surface]} (${count} of ${total} times)`;
      if (replaced) text += `, usually over ${selectionLabel(replaced)}`;
      if (inputSize && inputSize !== 'empty') text += `, mostly for ${inputSize} inputs`;
      notes.push({
        surface,
        model: group.chosen.model,
        variant: group.chosen.variant,
        count,
        total,
        replaced,
        inputSize,
        text,
      });
    }
  }
  return notes.sort((a, b) => b.count - a.count).slice(0, MAX_NOTES);
};

/**
 * Suggestion decision ids are v2 hashes of the same canonical tuple.
 * Legacy migration policy (#2095): pre-v2 ids (`goal-writer:<model>:<variant>`,
 * with null written as 'default') are fundamentally ambiguous — their field
 * boundaries cannot reliably be recovered — so they are preserved in the
 * store untouched but never match a v2 suggestion id. A suggestion decided
 * under a legacy id may therefore be offered once more; no legacy decision
 * is ever silently attributed to a different selection.
 */
export const goalWriterSuggestionId = (selection) => `goal-writer:v2:${selectionDigest("goal-writer-suggestion", selection)}`;

/**
 * Settings changes the notes support. Only the goal writer's default model
 * and effort are suggested: it is one setting with one meaning, the model the
 * goal window starts on. A suggestion needs a clear habit in the surface's
 * recent choices, must differ from the current setting, and is never offered
 * again once the user approved or declined it.
 */
export const buildModelChoiceSuggestions = ({ events, decisions, settings }) => {
  const decided = new Set(decisions.map((entry) => entry.id));
  const recent = events.filter((event) => event.surface === 'goal-writer').slice(-SUGGESTION_WINDOW);
  const [top] = groupByChoice(recent);
  if (!top) return [];
  const count = top.events.length;
  if (count < MIN_SUGGESTION_COUNT || count / recent.length < MIN_SUGGESTION_SHARE) return [];

  const current = goalWriterSettingsSchema.parse(settings);
  if (current.sessionGoalWriterModel === top.chosen.model && current.sessionGoalWriterVariant === (top.chosen.variant ?? '')) return [];

  const id = goalWriterSuggestionId(top.chosen);
  if (decided.has(id)) return [];
  return [{
    id,
    surface: 'goal-writer',
    model: top.chosen.model,
    variant: top.chosen.variant,
    count,
    total: recent.length,
    settings: {
      sessionGoalWriterModel: top.chosen.model,
      sessionGoalWriterVariant: top.chosen.variant ?? '',
    },
  }];
};
