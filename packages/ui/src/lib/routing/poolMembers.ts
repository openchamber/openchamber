import { parseModelSelection } from '@/lib/modelIdentifier';
import { pruneEmpty, routeReferenceID, targetEntry, targetLabel, targetReference } from '@/lib/routing/poolAdvanced';
import type { ModelRouteTarget } from '@/lib/routing/modelRoutesApi';

type ObjectTarget = Exclude<ModelRouteTarget, string>;

/**
 * How a pool member's effort is set, as OpenCode reads its entry:
 * `provider/model` sends no effort (the provider's default), `{ model,
 * defaultVariant }` runs at that effort when the pool is picked without one,
 * and `provider/model#variant` runs at that effort whatever the pool is
 * picked at.
 */
type MemberEffort = { mode: 'provider' } | { mode: 'default' | 'locked'; variant: string };

/** What a pool member is: one model, another pool, or a pattern that covers several models. */
type MemberKind =
  | { kind: 'model'; providerID: string; modelID: string }
  | { kind: 'pool'; poolID: string }
  | { kind: 'pattern'; providerID: string };

export const memberKind = (target: ModelRouteTarget): MemberKind => {
  const poolID = routeReferenceID(target);
  if (poolID !== null) return { kind: 'pool', poolID };
  const reference = targetReference(target);
  const slash = reference.indexOf('/');
  const providerID = reference.slice(0, slash);
  const modelID = reference.slice(slash + 1);
  return providerID === '*' || modelID.includes('*') ? { kind: 'pattern', providerID } : { kind: 'model', providerID, modelID };
};

/** A `#variant` suffix is authoritative even when the entry also carries a default OpenCode ignores. */
export const memberEffort = (target: ModelRouteTarget): MemberEffort => {
  const pinned = parseModelSelection(targetLabel(target))?.variant;
  if (pinned) return { mode: 'locked', variant: pinned };
  const { defaultVariant } = targetEntry(target);
  return defaultVariant ? { mode: 'default', variant: defaultVariant } : { mode: 'provider' };
};

// An entry with nothing but its model keeps the short string form in the config.
const compactTarget = (target: ObjectTarget): ModelRouteTarget => (Object.keys(target).length === 1 ? target.model : target);

/** Edits one member field while every other option of its stored entry stays as it was. */
export const withMemberField = <K extends keyof ObjectTarget>(target: ModelRouteTarget, key: K, value: ObjectTarget[K] | undefined): ModelRouteTarget => {
  const next = { ...targetEntry(target) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return compactTarget(next);
};

/** Provider default writes no effort, a default can be overridden by the pool's level, and a lock pins it. */
export const withMemberEffort = (target: ModelRouteTarget, effort: MemberEffort): ModelRouteTarget => {
  const current = memberEffort(target);
  const same = current.mode === effort.mode
    && (current.mode === 'provider' || (effort.mode !== 'provider' && current.variant === effort.variant));
  if (same) return target;
  const next = { ...targetEntry(target), model: targetReference(target) + (effort.mode === 'locked' ? `#${effort.variant}` : '') };
  if (effort.mode === 'default') next.defaultVariant = effort.variant;
  else delete next.defaultVariant;
  return compactTarget(next);
};

/**
 * Unlocks a pinned member without changing how it runs: its effort becomes the
 * default, and every listed level runs at that same effort. A level the
 * member deliberately sits out (`false`) stays out.
 */
export const unlockMemberWithRemaps = (target: ModelRouteTarget, levels: readonly string[]): ModelRouteTarget => {
  const effort = memberEffort(target);
  if (effort.mode !== 'locked') return target;
  const variants = { ...targetEntry(target).variants };
  for (const level of levels) if (variants[level] !== false) variants[level] = effort.variant;
  return withMemberField(withMemberEffort(target, { mode: 'default', variant: effort.variant }), 'variants', pruneEmpty(variants));
};
