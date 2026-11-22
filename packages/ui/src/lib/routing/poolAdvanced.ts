import { AUTONOMY_LEVELS, type AutonomyLevel, type ModelRoute, type ModelRouteTarget, type ModelRouteTuning } from '@/lib/routing/modelRoutesApi';

/** The model a budget or weight is keyed by: the target without its `#variant` suffix. */
export const targetReference = (target: ModelRouteTarget): string => {
  const label = typeof target === 'string' ? target : target.model;
  return label.split('#')[0];
};

/** A pattern such as `openai/*` names several models, so it cannot carry its own budget or weight. */
export const isConcreteTarget = (target: ModelRouteTarget): boolean => !targetReference(target).includes('*');

/** Blank or non-numeric form input means the setting is unset. */
/** The select's default entry stands for no value, so it clears the field; any other entry is the value. */
export const pickedValue = (picked: string): string | undefined => (picked === '__unset__' ? undefined : picked);

/** The autonomy select's default entry clears the level; each listed level stands for itself. */
export const pickedAutonomy = (picked: string): AutonomyLevel | undefined => AUTONOMY_LEVELS.find((level) => level === picked);

export const parseFormNumber = (value: string): number | undefined => {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Sets or removes one key; an undefined value removes it so OpenCode's default applies again. */
export const withOptional = <T extends object>(record: T | undefined, key: string, value: unknown): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...(record ?? {}) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
};

/** An object with no keys left is removed entirely rather than saved as `{}`. */
export const pruneEmpty = <T extends object>(record: T): T | undefined => (Object.keys(record).length === 0 ? undefined : record);

export const setRouteField = (route: ModelRoute, key: keyof ModelRoute, value: unknown): ModelRoute => {
  const next: Record<string, unknown> = { ...route };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as ModelRoute;
};

/** Writes one field of a per-target map (budgets or weights), dropping the map when it empties. */
export const setTargetEntry = <T extends object>(
  map: Record<string, T> | undefined,
  reference: string,
  entry: T | undefined,
): Record<string, T> | undefined => {
  const next: Record<string, T> = { ...(map ?? {}) };
  if (entry === undefined || Object.keys(entry).length === 0) delete next[reference];
  else next[reference] = entry;
  return pruneEmpty(next);
};

export type TargetOptions = {
  defaultVariant?: string;
  variants?: Record<string, string>;
  until?: number;
};

export const targetLabel = (target: ModelRouteTarget): string => (typeof target === 'string' ? target : target.model);

export const targetUntil = (target: ModelRouteTarget): number | undefined =>
  typeof target === 'string' ? undefined : target.until;

export const targetOptions = (target: ModelRouteTarget): TargetOptions =>
  typeof target === 'string' ? {} : { defaultVariant: target.defaultVariant, variants: target.variants, until: target.until };

/** A target with no options stays a plain string so the saved config keeps its short form. */
export const withTargetOptions = (target: ModelRouteTarget, options: TargetOptions): ModelRouteTarget => {
  const model = targetLabel(target);
  const kept: TargetOptions = {};
  if (options.defaultVariant) kept.defaultVariant = options.defaultVariant;
  if (options.variants && Object.keys(options.variants).length > 0) kept.variants = options.variants;
  if (options.until !== undefined) kept.until = options.until;
  return Object.keys(kept).length === 0 ? model : { model, ...kept };
};

const ROUTE_REFERENCE_PREFIX = 'opencode-route/';

/** The route id a target points at when it is another pool, or null for a model. */
export const routeReferenceID = (target: ModelRouteTarget): string | null => {
  const reference = targetReference(target);
  return reference.startsWith(ROUTE_REFERENCE_PREFIX) ? reference.slice(ROUTE_REFERENCE_PREFIX.length) : null;
};

export const routeReference = (routeID: string): string => `${ROUTE_REFERENCE_PREFIX}${routeID}`;

/** An epoch-millisecond instant as the local value a datetime-local input expects. */
export const epochToLocalInput = (epoch: number | undefined): string => {
  if (epoch === undefined) return '';
  const date = new Date(epoch);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

/** The automatic-review settings to save, or null when every field is back at its default. */
export const tuningToSave = (tuning: ModelRouteTuning): ModelRouteTuning | null => pruneEmpty(tuning) ?? null;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a weight key names a target, as the server reads it: the target's
 * reference, or a concrete model that a `*` target matches. Mirrors
 * `keyNamesTarget` in `packages/web/server/lib/routing/model-routes.js`.
 */
export const weightNamesTarget = (key: string, target: ModelRouteTarget): boolean => {
  const reference = targetReference(target);
  if (key === reference) return true;
  if (!reference.includes('*')) return false;
  const [provider, ...pattern] = reference.split('/');
  const [keyProvider, ...model] = key.split('/');
  if (provider !== keyProvider || model.length === 0) return false;
  return new RegExp(`^${pattern.join('/').split('*').map(escapeRegExp).join('.*')}$`).test(model.join('/'));
};

/** Drops the weights of targets the route no longer has, so a removed or edited target cannot block the save. */
export const withoutAbsentWeights = (route: ModelRoute): ModelRoute => {
  if (!route.weights) return route;
  const kept = Object.fromEntries(
    Object.entries(route.weights).filter(([key]) => route.targets.some((target) => weightNamesTarget(key, target))),
  );
  return setRouteField(route, 'weights', pruneEmpty(kept));
};
