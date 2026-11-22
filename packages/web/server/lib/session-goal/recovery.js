// Recovery from a turn that ended in an error, for an active goal. Most errors
// are transient: the loop continues with a prompt that names the error. A
// refusal, or an error that belongs to the serving provider or model (auth,
// quota, a model it no longer serves), moves the session to another model:
// another effort of the same model, the same model from another provider, then
// OpenCode's default model. The goal blocks only when every alternative has
// been tried or ordinary errors keep repeating.

import { z } from 'zod';

/** Consecutive errored turns the loop recovers from before it blocks the goal. */
export const ORDINARY_ERROR_LIMIT = 3;
/** Hard bound on consecutive recoveries of any kind, alternatives included. */
export const RECOVERY_STREAK_LIMIT = 8;

const REFUSAL_ERRORS = new Set(['provider.content-filter', 'ContentFilterError']);
// Errors that indict the serving provider or model, not the request: another
// try on the same model would fail the same way.
const LEG_ERRORS = new Set([
  'provider.auth',
  'ProviderAuthError',
  'provider.quota',
  'provider.no-route',
  'provider.unsupported-operation',
  'provider.empty-completion',
]);

/** 'refusal' | 'leg' | 'ordinary' for a turn error name (v2 `type`, v1 `name`). */
export const classifyTurnError = (errorName) => {
  if (REFUSAL_ERRORS.has(errorName)) return 'refusal';
  if (LEG_ERRORS.has(errorName)) return 'leg';
  return 'ordinary';
};

export const modelKey = (ref) => `${ref.providerID}/${ref.id}#${ref.variant ?? ''}`;

const modelRefSchema = z.object({
  providerID: z.string().min(1),
  id: z.string().min(1),
  variant: z.string().min(1).optional().catch(undefined),
});
const catalogModelSchema = z.object({
  providerID: z.string().min(1),
  id: z.string().min(1),
  modelID: z.string().min(1).optional().catch(undefined),
  enabled: z.boolean().optional().catch(undefined),
  variants: z.array(z.object({ id: z.string().min(1) })).catch([]),
});
const triedSchema = z.array(z.string().min(1)).catch([]);

/** The model a turn ran on, or null when the record does not name one. */
export const parseModelRef = (value) => {
  const parsed = modelRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** A stored `recoveryTried` list; anything else reads as empty. */
export const parseRecoveryTried = (value) => triedSchema.parse(value);

/**
 * OpenCode's `/api/model` list and `/api/model/default` answer, as the walk
 * reads them. An entry that does not parse is dropped alone; a list that is
 * not a list is unknown (null), never an empty catalog.
 */
export const parseModelChoices = (catalog, defaultModel) => {
  if (!Array.isArray(catalog)) return null;
  const models = [];
  for (const entry of catalog) {
    const parsed = catalogModelSchema.safeParse(entry);
    if (parsed.success) models.push(parsed.data);
  }
  return { catalog: models, defaultModel: parseModelRef(defaultModel) };
};

/**
 * The next model to move the session to, or null when none is left. `current`
 * is the model that served the failed turn (`{ providerID, id, variant }`),
 * `catalog` OpenCode's `/api/model` list, `defaultModel` its `/api/model/default`.
 * A refusal may clear on another effort of the same model; a leg error cannot,
 * so it only looks at other providers.
 */
export const pickRecoveryModel = ({ kind, current, catalog, defaultModel, tried }) => {
  const skip = new Set([...tried, modelKey(current)]);
  const usable = catalog.filter((model) => model.enabled !== false);
  const entry = usable.find((model) => model.providerID === current.providerID && model.id === current.id);
  const candidates = [];
  if (entry && kind === 'refusal') {
    for (const variant of entry.variants) {
      candidates.push({ providerID: entry.providerID, id: entry.id, variant: variant.id });
    }
  }
  if (entry) {
    const apiId = entry.modelID ?? entry.id;
    for (const model of usable) {
      if (model.providerID === current.providerID) continue;
      if ((model.modelID ?? model.id) === apiId) candidates.push({ providerID: model.providerID, id: model.id });
    }
  }
  if (defaultModel && (kind === 'refusal' || defaultModel.providerID !== current.providerID)) {
    candidates.push({ providerID: defaultModel.providerID, id: defaultModel.id });
  }
  return candidates.find((candidate) => !skip.has(modelKey(candidate))) ?? null;
};

const describeError = (errorName, error) => {
  const message = String(error?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return message ? `${errorName || 'error'}: ${message}` : (errorName || 'an unnamed error');
};

/** The lead of the continuation prompt after an ordinary error. */
export const buildErrorRecoveryLead = ({ errorName, error }) => [
  `The previous turn ended with an error (${describeError(errorName, error)}).`,
  'Most errors like this are transient. Pick up from where the turn stopped and keep working toward the goal.',
  'If the error came from something you can fix yourself, such as a failing tool, the environment, a configuration or a dependency, fix it and continue. Report the goal as blocked only when you cannot go on without the user.',
];

/** The lead of the continuation prompt after the session moved to another model. */
export const buildModelSwitchLead = ({ kind, errorName, error, from, to }) => [
  kind === 'refusal'
    ? `The previous reply from ${from.providerID}/${from.id} was refused by the provider (${describeError(errorName, error)}).`
    : `The previous turn failed on ${from.providerID}/${from.id} (${describeError(errorName, error)}).`,
  `The session now runs on ${to.providerID}/${to.id}${to.variant ? ` at ${to.variant} effort` : ''}. Pick up from where the work stopped and keep going.`,
];
