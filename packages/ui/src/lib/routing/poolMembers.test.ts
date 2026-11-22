import { describe, expect, test } from 'bun:test';
import { memberEffort, withMemberEffort, unlockMemberWithRemaps } from './poolMembers';
import { modelRouteSchema, type ModelRouteTarget } from './modelRoutesApi';
import { targetEntry } from './poolAdvanced';
import { parseModelSelection } from '@/lib/modelIdentifier';

// Oracle: OpenCode's target resolution, pinned b70580b model-resolver.ts.
// The suffix wins; a requested level maps first; absent a request uses the
// target default. `false` excludes the member before it can run. The entry's
// fields are read through `targetEntry`, a plain accessor, not the logic under test.
const resolved = (target: ModelRouteTarget, requested?: string): string | false | undefined => {
  const object = targetEntry(target);
  if (requested && object.variants?.[requested] === false) return false;
  return parseModelSelection(object.model)?.variant
    ?? (requested === undefined ? object.defaultVariant : object.variants?.[requested] ?? requested);
};

describe('pool member effort', () => {
  test('recognizes locks, overridable defaults and an unset provider default', () => {
    expect(memberEffort('openai/luna#high')).toEqual({ mode: 'locked', variant: 'high' });
    expect(memberEffort({ model: 'openai/luna', defaultVariant: 'high' })).toEqual({ mode: 'default', variant: 'high' });
    expect(resolved(withMemberEffort('openai/luna#high', { mode: 'provider' }))).toBeUndefined();
    expect(resolved({ model: 'openai/luna', defaultVariant: 'high' }, 'low')).toBe('low');
    expect(resolved('openai/luna#high', 'low')).toBe('high');
  });
  test('round-trips all stored fields and converts locks equivalently at every listed level', () => {
    const target = { model: 'openai/luna#high', defaultVariant: 'low', variants: { max: false },
      until: 2_000_000_000_000, limit: { context: 100_000 }, window: 'off-peak', cache_format: 'anthropic' } satisfies ModelRouteTarget;
    const parsed = modelRouteSchema.parse({ targets: [target], levels: [] });
    expect(parsed.targets?.[0]).toEqual(target);
    expect(withMemberEffort(target, memberEffort(target))).toBe(target);
    const unlocked = unlockMemberWithRemaps(target, ['none', 'low', 'medium', 'high', 'max']);
    for (const level of [undefined, 'none', 'low', 'medium', 'high', 'max']) expect(resolved(unlocked, level)).toBe(resolved(target, level));
    expect(unlocked).toMatchObject({ limit: target.limit, window: target.window, cache_format: target.cache_format });
  });
  test('preserves untouched entries through 3,000 generated load/save and effort changes', () => {
    let state = 123;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
    for (let run = 0; run < 3_000; run++) {
      const variant = ['low', 'high', 'max'][random() % 3];
      const target: ModelRouteTarget = { model: `p/family/model-${run}${random() % 2 ? `#${variant}` : ''}`,
        defaultVariant: variant, variants: { low: variant, max: random() % 2 ? false : variant },
        limit: { context: (random() % 100_000) + 1 } };
      const parsed = modelRouteSchema.parse({ targets: [target] }).targets?.[0];
      expect(parsed).toEqual(target);
      expect(withMemberEffort(target, memberEffort(target))).toBe(target);
      const pin = withMemberEffort(target, { mode: 'locked', variant });
      const unlocked = unlockMemberWithRemaps(pin, ['none', 'low', 'medium', 'high', 'max']);
      for (const level of [undefined, 'none', 'low', 'medium', 'high', 'max']) expect(resolved(unlocked, level)).toBe(resolved(pin, level));
    }
  });
});
