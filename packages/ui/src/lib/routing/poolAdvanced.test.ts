import { describe, expect, test } from 'bun:test';
import type { ModelRoute } from './modelRoutesApi';
import {
  epochToLocalInput,
  isConcreteTarget,
  parseFormNumber,
  pickedAutonomy,
  pickedValue,
  pruneEmpty,
  routeReference,
  routeReferenceID,
  setRouteField,
  setTargetEntry,
  targetEntry,
  targetReference,
  weightNamesTarget,
  withoutAbsentWeights,
  targetUntil,
  tuningToSave,
  withOptional,
} from './poolAdvanced';
import { withMemberField } from './poolMembers';

// The member editor's field writer replaced the old per-target options form;
// these are the guarantees that form gave and the config still relies on.
describe('target entries', () => {
  test('a target without options stays a plain string', () => {
    expect(withMemberField('openai/gpt-6-luna', 'defaultVariant', undefined)).toBe('openai/gpt-6-luna');
    expect(withMemberField({ model: 'openai/gpt-6-luna', defaultVariant: 'max' }, 'defaultVariant', undefined)).toBe(
      'openai/gpt-6-luna',
    );
  });

  test('options are written onto the object form and read back', () => {
    const saved = withMemberField(
      withMemberField(withMemberField('openai/gpt-6-luna', 'defaultVariant', 'max'), 'variants', { low: 'high' }),
      'until',
      1893575040000,
    );
    expect(saved).toEqual({
      model: 'openai/gpt-6-luna',
      defaultVariant: 'max',
      variants: { low: 'high' },
      until: 1893575040000,
    });
    expect(targetEntry(saved)).toBe(saved);
    expect(targetEntry('openai/gpt-6-luna')).toEqual({ model: 'openai/gpt-6-luna' });
    expect(targetUntil(saved)).toBe(1893575040000);
    expect(targetUntil('openai/gpt-6-luna')).toBeUndefined();
  });

  test('clearing every option returns the short form', () => {
    const object = { model: 'openai/gpt-6-luna', defaultVariant: 'max' };
    expect(withMemberField(object, 'defaultVariant', undefined)).toBe('openai/gpt-6-luna');
  });
});

describe('pool references', () => {
  test('a route reference names another pool by id', () => {
    expect(routeReference('cheap')).toBe('opencode-route/cheap');
    expect(routeReferenceID('opencode-route/cheap')).toBe('cheap');
    expect(routeReferenceID({ model: 'opencode-route/cheap', until: 1893575040000 })).toBe('cheap');
    expect(routeReferenceID('openai/gpt-6-luna')).toBeNull();
  });
});

describe('epoch to local input', () => {
  test('formats an instant for a datetime-local input in local time', () => {
    const epoch = new Date(2030, 0, 2, 9, 5).getTime();
    expect(epochToLocalInput(epoch)).toBe('2030-01-02T09:05');
    expect(epochToLocalInput(undefined)).toBe('');
  });
});

describe('target references', () => {
  test('keys budgets and weights by the model without its variant', () => {
    expect(targetReference('openai/gpt-6-luna#max')).toBe('openai/gpt-6-luna');
    expect(targetReference({ model: 'anthropic/claude-sonnet', defaultVariant: 'high' })).toBe('anthropic/claude-sonnet');
  });

  test('patterns are not concrete targets', () => {
    expect(isConcreteTarget('openai/gpt-6-luna')).toBe(true);
    expect(isConcreteTarget({ model: 'anthropic/*', until: 1893575040000 })).toBe(false);
  });
});

describe('form numbers', () => {
  test('blank input is unset and text is not a number', () => {
    expect(parseFormNumber('')).toBeUndefined();
    expect(parseFormNumber('   ')).toBeUndefined();
    expect(parseFormNumber('abc')).toBeUndefined();
    expect(parseFormNumber('12.5')).toBe(12.5);
    expect(parseFormNumber('0')).toBe(0);
  });
});

describe('optional keys', () => {
  test('setting undefined removes the key rather than writing null', () => {
    expect(withOptional({ attempts: 2, cooldownMs: 5 }, 'cooldownMs', undefined)).toEqual({ attempts: 2 });
    expect(withOptional(undefined, 'sampleWindow', 4)).toEqual({ sampleWindow: 4 });
  });

  test('an emptied health object is removed from the route', () => {
    const route = setRouteField({ targets: ['a/b'], health: { cooldownMs: 5 } }, 'health', pruneEmpty(withOptional({ cooldownMs: 5 }, 'cooldownMs', undefined)));
    expect(route).toEqual({ targets: ['a/b'] });
    expect('health' in route).toBe(false);
  });

  test('other route fields and unknown keys survive an edit', () => {
    const route = setRouteField({ targets: ['a/b'], autonomy: 'agent', futureKey: { on: true } } as never, 'attempts', 3);
    expect(route).toEqual({ targets: ['a/b'], autonomy: 'agent', futureKey: { on: true }, attempts: 3 });
  });
});

describe('per-target maps', () => {
  test('writes an entry and drops the map when its last entry empties', () => {
    const one = setTargetEntry(undefined, 'a/b', { requestsPerDay: 500 });
    expect(one).toEqual({ 'a/b': { requestsPerDay: 500 } });
    expect(setTargetEntry(one, 'a/b', undefined)).toBeUndefined();
  });

  test('keeps other targets when one changes', () => {
    const map = { 'a/b': { requestsPerDay: 500 }, 'c/d': { tokensPerMinute: 900 } };
    expect(setTargetEntry(map, 'a/b', { requestsPerDay: 10 })).toEqual({
      'a/b': { requestsPerDay: 10 },
      'c/d': { tokensPerMinute: 900 },
    });
  });
});

describe('automatic review settings', () => {
  test('an all-default tuning is saved as null so OpenCode defaults apply', () => {
    expect(tuningToSave({})).toBeNull();
    expect(tuningToSave({ enabled: false })).toEqual({ enabled: false });
  });
});

describe('weightNamesTarget', () => {
  test('names a target by its reference, without the variant', () => {
    expect(weightNamesTarget('openai/gpt-6-luna', 'openai/gpt-6-luna#high')).toBe(true);
    expect(weightNamesTarget('openai/gpt-6-luna#high', 'openai/gpt-6-luna#high')).toBe(false);
    expect(weightNamesTarget('opencode-route/cheap', 'opencode-route/cheap')).toBe(true);
  });

  test('names a concrete model that a wildcard target matches, and no other', () => {
    expect(weightNamesTarget('openai/gpt-6-luna', 'openai/gpt-*')).toBe(true);
    expect(weightNamesTarget('anthropic/gpt-6-luna', 'openai/gpt-*')).toBe(false);
    expect(weightNamesTarget('openai/claude-5', 'openai/gpt-*')).toBe(false);
  });
});

describe('withoutAbsentWeights', () => {
  test('drops the weights of targets the route no longer has', () => {
    const route: ModelRoute = { targets: ['a/b', 'c/d'], selection: 'weighted', weights: { 'a/b': 3, 'x/y': 1 } };
    expect(withoutAbsentWeights(route).weights).toEqual({ 'a/b': 3 });
  });

  test('removes the weights map when nothing is left, and returns a route without weights unchanged', () => {
    const stale: ModelRoute = { targets: ['c/d'], weights: { 'a/b': 3 } };
    expect(withoutAbsentWeights(stale)).toEqual({ targets: ['c/d'] });
    const plain: ModelRoute = { targets: ['a/b'] };
    expect(withoutAbsentWeights(plain)).toBe(plain);
  });
});

describe('pickedValue', () => {
  test('the select default clears the field and every other entry is the value', () => {
    expect(pickedValue('__unset__')).toBeUndefined();
    expect(pickedValue('weighted')).toBe('weighted');
    expect(pickedValue('round-robin')).toBe('round-robin');
  });
});

describe('pickedAutonomy', () => {
  test('the autonomy default clears the level and each listed level is itself', () => {
    expect(pickedAutonomy('__unset__')).toBeUndefined();
    expect(pickedAutonomy('fixed')).toBe('fixed');
    expect(pickedAutonomy('predictive')).toBe('predictive');
    expect(pickedAutonomy('agent')).toBe('agent');
  });
});
