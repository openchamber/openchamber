import { describe, expect, it, vi, beforeEach } from 'vitest';
import { POOL_DESCRIPTION_MAX_LENGTH, POOL_DETAILS_MAX_LENGTH } from '@/lib/routing/modelRoutesApi';
import {
  AUTONOMY_LEVELS,
  MAX_DESCRIPTION_LENGTH,
  MAX_DETAILS_LENGTH,
  readModelRoutes,
  registerModelRouteRoutes,
  validateModelRoute,
  validateModelRouteSchedules,
  validateModelRouteTuning,
  validateModelRoutes,
} from './model-routes.js';

describe('validateModelRoute', () => {
  it('accepts a minimal ordered route', () => {
    expect(validateModelRoute('cheap-fast', { targets: ['openai/gpt-6-luna'] })).toBeNull();
  });

  it('accepts object targets, autonomy, selection and weights', () => {
    expect(
      validateModelRoute('luna', {
        targets: [{ model: 'openai/gpt-6-luna', defaultVariant: 'max' }, 'opencode-route/other'],
        autonomy: 'predictive',
        selection: 'weighted',
        weights: { 'openai/gpt-6-luna': 3 },
      }),
    ).toBeNull();
  });

  it('rejects bad ids, empty targets and unknown enums', () => {
    expect(validateModelRoute('bad id!', { targets: ['a/b'] })).toMatch(/invalid route id/);
    expect(validateModelRoute('x', { targets: [] })).toMatch(/at least one target/);
    expect(validateModelRoute('x', { targets: ['no-slash'] })).toMatch(/bad target/);
    expect(validateModelRoute('x', { targets: ['a/b'], autonomy: 'sentient' })).toMatch(/unknown autonomy/);
    expect(validateModelRoute('x', { targets: ['a/b'], selection: 'random' })).toMatch(/unknown selection/);
    expect(validateModelRoute('x', { targets: ['a/b'], weights: { 'a/b': 0 } })).toMatch(/positive number/);
  });

  it('rejects a non-object map', () => {
    expect(validateModelRoutes(null)).toMatch(/must be an object/);
    expect(validateModelRoutes({ ok: { targets: ['a/b'] } })).toBeNull();
  });
});

describe('validateModelRoutes route references', () => {
  it('refuses a target referencing a route that is not in the saved set', () => {
    expect(validateModelRoutes({ mine: { targets: ['opencode-route/nope'] } })).toMatch(
      /route "mine" target "opencode-route\/nope" references route "nope", which is not one of the saved routes/,
    );
    expect(validateModelRoutes({ mine: { targets: ['openai/gpt-x', 'opencode-route/nope'] } })).toMatch(/references route "nope"/);
    expect(validateModelRoutes({ mine: { targets: [{ model: 'opencode-route/nope' }] } })).toMatch(/references route "nope"/);
  });

  it('refuses a target that references its own route, even beside a concrete target', () => {
    expect(validateModelRoutes({ mine: { targets: ['openai/gpt-x', 'opencode-route/mine'] } })).toMatch(
      /route "mine" target "opencode-route\/mine" references its own route/,
    );
    expect(validateModelRoutes({ mine: { targets: ['openai/gpt-x', { model: 'opencode-route/mine' }] } })).toMatch(
      /references its own route/,
    );
  });

  it('refuses a route whose only target is itself', () => {
    expect(validateModelRoutes({ mine: { targets: ['opencode-route/mine'] } })).toMatch(/references its own route/);
  });

  it('refuses a reference cycle that reaches no concrete model target', () => {
    expect(
      validateModelRoutes({ a: { targets: ['opencode-route/b'] }, b: { targets: ['opencode-route/a'] } }),
    ).toMatch(/would expand to no models/);
    expect(
      validateModelRoutes({
        a: { targets: ['opencode-route/b'] },
        b: { targets: ['opencode-route/c'] },
        c: { targets: ['opencode-route/b'] },
      }),
    ).toMatch(/would expand to no models/);
  });

  it('accepts references to routes in the set, including a cycle where each reference still reaches a model', () => {
    expect(
      validateModelRoutes({ a: { targets: ['opencode-route/b'] }, b: { targets: ['openai/gpt-x'] } }),
    ).toBeNull();
    expect(
      validateModelRoutes({
        a: { targets: ['opencode-route/b', 'openai/gpt-x'] },
        b: { targets: ['opencode-route/a', 'openai/gpt-y'] },
      }),
    ).toBeNull();
    expect(
      validateModelRoutes({ a: { targets: ['opencode-route/b#high'] }, b: { targets: ['openai/gpt-x'] } }),
    ).toBeNull();
    expect(
      validateModelRoutes({ a: { targets: [{ model: 'opencode-route/b' }] }, b: { targets: ['openai/gpt-x'] } }),
    ).toBeNull();
    // A diamond: both branches reach the same concrete route.
    expect(
      validateModelRoutes({
        a: { targets: ['opencode-route/b', 'opencode-route/c'] },
        b: { targets: ['opencode-route/d'] },
        c: { targets: ['opencode-route/d'] },
        d: { targets: ['openai/gpt-x'] },
      }),
    ).toBeNull();
    // A longer cycle where the closing reference still reaches a model
    // through a route that is not on the trail.
    expect(
      validateModelRoutes({
        a: { targets: ['opencode-route/b'] },
        b: { targets: ['opencode-route/c'] },
        c: { targets: ['opencode-route/d', 'openai/gpt-y'] },
        d: { targets: ['openai/gpt-x'] },
      }),
    ).toBeNull();
  });

  it('refuses a route-reference target that is trail-dead in the referencing route', () => {
    expect(
      validateModelRoutes({
        a: { targets: ['openai/gpt-x', 'opencode-route/b'] },
        b: { targets: ['opencode-route/a'] },
      }),
    ).toMatch(/route "a" target "opencode-route\/b" can never serve a model in this route: route "b" reaches models only through route "a" itself/);
    expect(
      validateModelRoutes({
        a: { targets: ['opencode-route/b'] },
        b: { targets: ['opencode-route/a', 'openai/gpt-y'] },
      }),
    ).toMatch(/route "b" target "opencode-route\/a" can never serve a model in this route/);
    // Object spelling of the same dead reference.
    expect(
      validateModelRoutes({
        a: { targets: [{ model: 'opencode-route/b' }, 'openai/gpt-x'] },
        b: { targets: ['opencode-route/a'] },
      }),
    ).toMatch(/route "a" target "opencode-route\/b" can never serve a model/);
    // A longer cycle: c references a, and a reaches models only back
    // through b and c, both on the trail from c.
    expect(
      validateModelRoutes({
        a: { targets: ['opencode-route/b'] },
        b: { targets: ['opencode-route/c'] },
        c: { targets: ['opencode-route/a', 'openai/gpt-y'] },
      }),
    ).toMatch(/route "c" target "opencode-route\/a" can never serve a model in this route/);
  });

  it('refuses a budget keyed by a route reference, which OpenCode never looks up', () => {
    expect(
      validateModelRoutes({
        child: { targets: ['openai/gpt-6-luna'] },
        parent: { targets: ['opencode-route/child'], budgets: { 'opencode-route/child': { requestsPerDay: 10 } } },
      }),
    ).toMatch(/route "parent" budget for "opencode-route\/child" is keyed by a route reference/);
    expect(
      validateModelRoute('x', { targets: ['opencode-route/other'], budgets: { 'opencode-route/other': { requestsPerDay: 1 } } }),
    ).toMatch(/budget for "opencode-route\/other" is keyed by a route reference/);
  });

  it('accepts a budget keyed by a concrete model the route reaches through references', () => {
    expect(
      validateModelRoutes({
        child: { targets: ['openai/gpt-6-luna'] },
        parent: { targets: ['opencode-route/child'], budgets: { 'openai/gpt-6-luna': { requestsPerDay: 10 } } },
      }),
    ).toBeNull();
    expect(
      validateModelRoutes({
        c: { targets: ['openai/gpt-6-luna'] },
        b: { targets: ['opencode-route/c'] },
        a: { targets: ['opencode-route/b'], budgets: { 'openai/gpt-6-luna': { requestsPerDay: 10 } } },
      }),
    ).toBeNull();
    expect(
      validateModelRoutes({
        child: { targets: ['openai/*'] },
        parent: { targets: ['opencode-route/child'], budgets: { 'openai/gpt-6-luna': { requestsPerDay: 10 } } },
      }),
    ).toBeNull();
    expect(
      validateModelRoutes({
        a: { targets: ['opencode-route/b', 'anthropic/claude-1'], budgets: { 'openai/gpt-x': { requestsPerDay: 1 } } },
        b: { targets: ['opencode-route/a', 'openai/gpt-x'] },
      }),
    ).toBeNull();
  });

  it('still refuses a budget keyed by a model no referenced route reaches', () => {
    expect(
      validateModelRoutes({
        child: { targets: ['openai/gpt-6-luna'] },
        parent: { targets: ['opencode-route/child'], budgets: { 'openai/other': { requestsPerDay: 10 } } },
      }),
    ).toMatch(/route "parent" budget for "openai\/other" matches no target in the route/);
  });

  it('keeps a weights key naming a route reference valid: a nested route attaches under that key', () => {
    expect(
      validateModelRoutes({
        child: { targets: ['openai/gpt-6-luna'] },
        parent: { targets: ['opencode-route/child'], weights: { 'opencode-route/child': 2 } },
      }),
    ).toBeNull();
  });

  it('accepts a schedule entry naming a concrete model the route reaches through references', () => {
    const withEntry = (routes, entry) =>
      validateModelRoutes({
        ...routes,
        a: { targets: ['opencode-route/b'], schedules: [{ when: {}, factor: 2, targets: [entry] }] },
      });
    expect(withEntry({ b: { targets: ['openai/gpt-x'] } }, 'openai/gpt-x')).toBeNull();
    expect(withEntry({ b: { targets: ['openai/gpt-x'] } }, 'openai/*')).toBeNull();
    // Transitive, three levels down.
    expect(
      validateModelRoutes({
        c: { targets: ['openai/gpt-x'] },
        b: { targets: ['opencode-route/c'] },
        a: { targets: ['opencode-route/b'], schedules: [{ when: {}, factor: 2, targets: ['openai/gpt-x'] }] },
      }),
    ).toBeNull();
    // A pattern on the leaf side, and a pair that only partly overlaps.
    expect(withEntry({ b: { targets: ['openai/*'] } }, 'openai/gpt-x')).toBeNull();
    expect(withEntry({ b: { targets: ['openai/*-luna'] } }, 'openai/gpt-*')).toBeNull();
    // A cycle where each reference still reaches a concrete target counts.
    expect(
      validateModelRoutes({
        a: { targets: ['opencode-route/b', 'anthropic/claude-1'], schedules: [{ when: {}, factor: 2, targets: ['openai/gpt-x'] }] },
        b: { targets: ['opencode-route/a', 'openai/gpt-x'] },
      }),
    ).toBeNull();
    // Case judging follows the schedule matcher through references too.
    expect(withEntry({ b: { targets: ['openai/gpt-x'] } }, 'OpenAI/GPT-X')).toBeNull();
  });

  it('refuses a schedule entry naming a route reference, which no leaf can match', () => {
    expect(
      validateModelRoutes({
        b: { targets: ['openai/gpt-x'] },
        a: { targets: ['opencode-route/b'], schedules: [{ when: {}, factor: 2, targets: ['opencode-route/b'] }] },
      }),
    ).toMatch(
      /route "a" schedule 1 target "opencode-route\/b" is a route reference: OpenCode matches schedule targets against concrete provider\/model references/,
    );
    // The single-route validator refuses the same entry: the refusal needs
    // no expansion, only the entry's own shape.
    expect(
      validateModelRoute('x', { targets: ['opencode-route/other'], schedules: [{ when: {}, factor: 2, targets: ['opencode-route/other'] }] }),
    ).toMatch(/schedule 1 target "opencode-route\/other" is a route reference/);
  });

  it('still refuses a schedule entry naming no leaf the route reaches through references', () => {
    expect(
      validateModelRoutes({
        b: { targets: ['openai/gpt-x'] },
        a: { targets: ['opencode-route/b'], schedules: [{ when: {}, factor: 2, targets: ['openai/other'] }] },
      }),
    ).toMatch(/route "a" schedule 1 target "openai\/other" matches no target in the route/);
    expect(
      validateModelRoutes({
        b: { targets: ['openai/gpt-x'] },
        a: { targets: ['opencode-route/b'], schedules: [{ when: {}, factor: 2, targets: ['OpenAI/other'] }] },
      }),
    ).toMatch(/matches no target in the route/);
  });
});

describe('validateModelRoute advanced fields', () => {
  const base = { targets: ['a/b'] };

  it('accepts every field the OpenCode schema defines', () => {
    expect(
      validateModelRoute('full', {
        ...base,
        attempts: 2,
        hedgeAfterMs: 1500,
        selection: 'round-robin',
        health: {
          firstTokenTimeoutMs: false,
          maxResponseTimeMs: 60000,
          minOutputTokensPerSecond: 12.5,
          sampleWindow: 5,
          slowThreshold: 3,
          cooldownMs: 60000,
          quotaCooldownMs: 900000,
        },
        budgets: { 'a/b': { requestsPerMinute: 10, tokensPerDay: 1000000, softLimit: 0.9 } },
        schedules: [{ when: { daysOfWeek: ['mon'], start: '09:00', end: '17:00' }, factor: 0.5 }],
      }),
    ).toBeNull();
  });

  it('rejects out-of-range attempts, hedge and health values', () => {
    expect(validateModelRoute('x', { ...base, attempts: 0 })).toMatch(/attempts/);
    expect(validateModelRoute('x', { ...base, attempts: 51 })).toMatch(/attempts/);
    expect(validateModelRoute('x', { ...base, hedgeAfterMs: 0 })).toMatch(/hedgeAfterMs/);
    expect(validateModelRoute('x', { ...base, health: { cooldownMs: 1.5 } })).toMatch(/health\.cooldownMs/);
    expect(validateModelRoute('x', { ...base, health: { firstTokenTimeoutMs: 0 } })).toMatch(/firstTokenTimeoutMs/);
    expect(validateModelRoute('x', { ...base, health: { minOutputTokensPerSecond: 0 } })).toMatch(/minOutputTokensPerSecond/);
  });

  it('refuses non-finite weights and health rates, which OpenCode requires to be finite', () => {
    expect(validateModelRoute('x', { ...base, weights: { 'a/b': Infinity } })).toMatch(/weight for "a\/b" must be a positive number/);
    // The realistic spelling: an overflowing JSON number parses to Infinity.
    expect(validateModelRoute('x', { ...base, weights: { 'a/b': JSON.parse('1e999') } })).toMatch(/positive number/);
    expect(validateModelRoute('x', { ...base, health: { minOutputTokensPerSecond: Infinity } })).toMatch(/minOutputTokensPerSecond must be a positive number/);
    expect(validateModelRoute('x', { ...base, weights: { 'a/b': 2 }, health: { minOutputTokensPerSecond: 12.5 } })).toBeNull();
  });

  it('rejects malformed budgets', () => {
    expect(validateModelRoute('x', { ...base, budgets: { 'a/b': { requestsPerDay: -5 } } })).toMatch(/requestsPerDay/);
    expect(validateModelRoute('x', { ...base, budgets: { 'a/b': { softLimit: 1.5 } } })).toMatch(/softLimit/);
    expect(validateModelRoute('x', { ...base, budgets: ['a/b'] })).toMatch(/budgets/);
  });
});

describe('validateModelRoute target options and display name', () => {
  it('accepts a display name and target variant defaults and remaps', () => {
    expect(
      validateModelRoute('luna', {
        name: 'Luna pool',
        targets: [{ model: 'openai/gpt-6-luna', defaultVariant: 'max', variants: { low: 'high' }, until: 1893575040000 }],
      }),
    ).toBeNull();
  });

  it('rejects a non-string name, variant default or remap', () => {
    expect(validateModelRoute('luna', { name: 4, targets: ['openai/gpt-6-luna'] })).toMatch(/name must be a string/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', defaultVariant: 2 }] }),
    ).toMatch(/defaultVariant must be a string/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: ['high'] }] }),
    ).toMatch(/variants must map/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: { low: 3 } }] }),
    ).toMatch(/remap "low" must be a string/);
  });

  it('rejects a target listed twice, which OpenCode attaches once and drops silently', () => {
    expect(validateModelRoute('luna', { targets: ['openai/gpt-6-luna', 'openai/gpt-6-luna'] })).toMatch(
      /lists target "openai\/gpt-6-luna" twice/,
    );
    expect(
      validateModelRoute('luna', {
        targets: [
          { model: 'openai/gpt-6-luna', defaultVariant: 'low' },
          { model: 'openai/gpt-6-luna', defaultVariant: 'high' },
        ],
      }),
    ).toMatch(/lists target "openai\/gpt-6-luna" twice/);
    expect(
      validateModelRoute('luna', { targets: ['openai/gpt-6-luna', { model: 'openai/gpt-6-luna' }] }),
    ).toMatch(/lists target "openai\/gpt-6-luna" twice/);
    expect(
      validateModelRoutes({
        luna: { targets: ['opencode-route/sol', 'opencode-route/sol'] },
        sol: { targets: ['openai/gpt-6-sol'] },
      }),
    ).toMatch(/lists target "opencode-route\/sol" twice/);
    // Distinct #variant spellings are distinct leaves, and distinct models are fine.
    expect(validateModelRoute('luna', { targets: ['openai/gpt-6-luna#low', 'openai/gpt-6-luna#high'] })).toBeNull();
    expect(validateModelRoute('luna', { targets: ['openai/gpt-6-luna', 'openai/gpt-6-sol'] })).toBeNull();
  });

  it('refuses a concrete target fully shadowed by an earlier pattern target', () => {
    const future = Date.now() + 3600000;
    expect(
      validateModelRoute('r1', { targets: ['openai/*', { model: 'openai/gpt-5', defaultVariant: 'high' }] }),
    ).toMatch(/target "openai\/gpt-5" is already covered by the earlier pattern target "openai\/\*"/);
    expect(
      validateModelRoute('r1', { targets: ['openai/gpt-*', { model: 'openai/gpt-5', until: future }] }),
    ).toMatch(/already covered by the earlier pattern target "openai\/gpt-\*"/);
    expect(
      validateModelRoute('r1', { targets: ['openai/*#high', { model: 'openai/gpt-5#high', defaultVariant: 'low' }] }),
    ).toMatch(/already covered by the earlier pattern target "openai\/\*#high"/);
    // The #variant is part of the attach key, so a different variant is a distinct leaf.
    expect(validateModelRoute('r1', { targets: ['openai/*#high', 'openai/gpt-5'] })).toBeNull();
    expect(validateModelRoute('r1', { targets: ['openai/*', 'openai/gpt-5#high'] })).toBeNull();
    // Disjoint targets, and a concrete target listed before the pattern, still attach.
    expect(validateModelRoute('r1', { targets: ['openai/gpt-*', 'anthropic/claude-1'] })).toBeNull();
    expect(validateModelRoute('r1', { targets: ['openai/gpt-5', 'openai/*'] })).toBeNull();
    // An earlier pattern with a future until shadows only until it expires;
    // the concrete target applies after that, so the pair stays accepted.
    expect(
      validateModelRoute('r1', { targets: [{ model: 'openai/*', until: future }, 'openai/gpt-5'] }),
    ).toBeNull();
  });

  it('refuses a pattern target fully shadowed by an earlier pattern target', () => {
    const future = Date.now() + 3600000;
    expect(
      validateModelRoute('r1', { targets: ['openai/*', 'openai/gpt-*'] }),
    ).toMatch(/target "openai\/gpt-\*" is already covered by the earlier pattern target "openai\/\*"/);
    expect(
      validateModelRoute('r1', { targets: ['openai/*#high', { model: 'openai/gpt-*#high', defaultVariant: 'low' }] }),
    ).toMatch(/already covered by the earlier pattern target "openai\/\*#high"/);
    expect(
      validateModelRoute('r1', { targets: ['openai/gpt-*', 'openai/gpt-5*'] }),
    ).toMatch(/already covered by the earlier pattern target "openai\/gpt-\*"/);
    // The judgement is about the model sets, not the spellings: a pattern
    // that only adds fixed text inside the earlier pattern is covered too.
    expect(
      validateModelRoute('r1', { targets: ['openai/*-luna', 'openai/gpt-*-luna'] }),
    ).toMatch(/already covered by the earlier pattern target/);
    // A partly overlapping pattern still attaches the models the earlier
    // pattern does not cover, in either order.
    expect(validateModelRoute('r1', { targets: ['openai/gpt-*', 'openai/*'] })).toBeNull();
    expect(validateModelRoute('r1', { targets: ['openai/*-luna', 'openai/*-sol'] })).toBeNull();
    // The #variant is part of the attach key, so a different variant is a distinct leaf.
    expect(validateModelRoute('r1', { targets: ['openai/*', 'openai/gpt-*#high'] })).toBeNull();
    // Disjoint providers, and a pattern listed after a concrete target, still attach.
    expect(validateModelRoute('r1', { targets: ['openai/*', 'anthropic/*'] })).toBeNull();
    expect(validateModelRoute('r1', { targets: ['openai/gpt-5', 'openai/gpt-*'] })).toBeNull();
    // An earlier pattern with a future until shadows only until it expires;
    // the later pattern applies after that, so the pair stays accepted.
    expect(
      validateModelRoute('r1', { targets: [{ model: 'openai/*', until: future }, 'openai/gpt-*'] }),
    ).toBeNull();
  });

  it('refuses a target until that is already past, which OpenCode drops on save', () => {
    const past = Date.now() - 1000;
    expect(validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', until: past }] })).toMatch(
      /until is already past/,
    );
    expect(
      validateModelRoute('luna', {
        targets: ['openai/gpt-6-luna', { model: 'openai/gpt-6-sol', until: past }],
      }),
    ).toMatch(/until is already past/);
    // A route whose concrete targets are all expired expands to no models.
    expect(
      validateModelRoutes({
        luna: {
          targets: [
            { model: 'openai/gpt-6-luna', until: past },
            { model: 'openai/gpt-6-sol', until: past },
          ],
        },
      }),
    ).toMatch(/until is already past/);
    // A future until on a concrete target still validates.
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', until: Date.now() + 60000 }] }),
    ).toBeNull();
  });

  it('refuses an until on a route reference, which OpenCode never reads', () => {
    expect(
      validateModelRoutes({
        child: { targets: ['openai/gpt-6-luna'] },
        parent: { targets: [{ model: 'opencode-route/child', until: Date.now() + 60000 }] },
      }),
    ).toMatch(/until is on a route reference/);
    expect(
      validateModelRoutes({
        child: { targets: ['openai/gpt-6-luna'] },
        parent: { targets: [{ model: 'opencode-route/child', until: Date.now() - 1000 }] },
      }),
    ).toMatch(/until is on a route reference/);
  });

  it('refuses variant settings on a route reference, which OpenCode never reads', () => {
    expect(
      validateModelRoutes({
        child: { targets: ['openai/gpt-6-luna'] },
        parent: { targets: [{ model: 'opencode-route/child', defaultVariant: 'high' }] },
      }),
    ).toMatch(/defaultVariant is on a route reference/);
    expect(
      validateModelRoutes({
        child: { targets: ['openai/gpt-6-luna'] },
        parent: { targets: [{ model: 'opencode-route/child', variants: { low: 'high' } }] },
      }),
    ).toMatch(/variants are on a route reference/);
    // A #variant suffix on the reference is read (it becomes the inherited
    // variant during expansion), and a plain reference stays accepted.
    expect(
      validateModelRoutes({
        child: { targets: ['openai/gpt-6-luna'] },
        parent: { targets: [{ model: 'opencode-route/child#high' }, 'opencode-route/child'] },
      }),
    ).toBeNull();
    // Variant settings on a concrete target still validate.
    expect(
      validateModelRoute('luna', {
        targets: [{ model: 'openai/gpt-6-luna', defaultVariant: 'high', variants: { low: 'high' } }],
      }),
    ).toBeNull();
  });

  it('rejects empty variant settings, which OpenCode drops without a word', () => {
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', defaultVariant: '' }] }),
    ).toMatch(/defaultVariant must be a string and not empty/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: { low: '' } }] }),
    ).toMatch(/remap "low" must be a string and not empty/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: { '': 'high' } }] }),
    ).toMatch(/must not use an empty route variant as a key/);
  });

  it('rejects padded and empty-segment target references, which can never match a model', () => {
    for (const padded of [' openai/gpt-6-luna', 'openai/gpt-6-luna ', 'openai/gpt-6-luna# high']) {
      expect(validateModelRoute('luna', { targets: [padded] })).toMatch(/padded/);
      expect(validateModelRoute('luna', { targets: [{ model: padded }] })).toMatch(/padded/);
    }
    expect(validateModelRoute('luna', { targets: ['openai/ gpt-6-luna'] })).toMatch(/padded model segment/);
    expect(validateModelRoute('luna', { targets: ['openai//gpt-6-luna'] })).toMatch(/empty model segment/);
    expect(validateModelRoute('luna', { targets: [{ model: 'openai//gpt-6-luna' }] })).toMatch(/empty model segment/);
    // Model IDs containing `/` still validate, in both target forms.
    expect(validateModelRoute('luna', { targets: ['openrouter/anthropic/claude-sonnet-4'] })).toBeNull();
    expect(validateModelRoute('luna', { targets: [{ model: 'openrouter/anthropic/claude-sonnet-4' }] })).toBeNull();
  });

  it('rejects target references with whitespace inside a segment or variant, which can never match a model', () => {
    for (const spaced of ['open ai/gpt-6-luna', 'openai/gpt 6-luna', 'openai/gpt-6-luna#hi there', 'openai/gpt\t6-luna']) {
      expect(validateModelRoute('luna', { targets: [spaced] })).toMatch(/containing whitespace/);
      expect(validateModelRoute('luna', { targets: [{ model: spaced }] })).toMatch(/containing whitespace/);
    }
    expect(validateModelRoute('luna', { targets: ['open ai/gpt-6-luna'] })).toMatch(/provider segment containing whitespace/);
    expect(validateModelRoute('luna', { targets: ['openai/gpt 6-luna'] })).toMatch(/model segment containing whitespace/);
    expect(validateModelRoute('luna', { targets: ['openai/gpt-6-luna#hi there'] })).toMatch(/variant containing whitespace/);
    // Whitespace-free references still validate, including `/`-containing model IDs and variants.
    expect(validateModelRoute('luna', { targets: ['openrouter/anthropic/claude-sonnet-4'] })).toBeNull();
    expect(validateModelRoute('luna', { targets: ['openai/gpt-6-luna#high'] })).toBeNull();
  });

  it('rejects padded variant settings, which OpenCode never trims or applies', () => {
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', defaultVariant: ' high' }] }),
    ).toMatch(/defaultVariant is padded/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: { ' high': 'low' } }] }),
    ).toMatch(/must not use a padded route variant as a key/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: { high: ' low' } }] }),
    ).toMatch(/remap "high" is padded/);
    // Unpadded variant settings still validate, including on pattern targets.
    expect(
      validateModelRoute('luna', {
        targets: [{ model: 'openai/*', defaultVariant: 'high', variants: { low: 'high' } }],
      }),
    ).toBeNull();
  });

  it('rejects variant settings containing whitespace, which no variant name ever has', () => {
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', defaultVariant: 'hi there' }] }),
    ).toMatch(/defaultVariant contains whitespace/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: { 'hi there': 'low' } }] }),
    ).toMatch(/must not use a route variant containing whitespace as a key/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: { high: 'lo w' } }] }),
    ).toMatch(/remap "high" contains whitespace/);
  });
});

describe('validateModelRoute schedules', () => {
  const base = { targets: ['deepseek/v4', 'openai/x'] };

  it('accepts the reported hand-written schedule beside a pool without one', () => {
    expect(
      validateModelRoutes({
        other: { targets: ['openai/x'] },
        peak: {
          targets: ['deepseek/v4'],
          schedules: [{ when: { daysOfWeek: ['mon'], start: '09:00', end: '17:00' }, factor: 0.5 }],
        },
      }),
    ).toBeNull();
  });

  it('accepts a full schedule: id, target patterns, a weight, a note and every window field', () => {
    expect(
      validateModelRoute('peak', {
        ...base,
        schedules: [
          {
            id: 'weekday-peak',
            targets: ['deepseek/*'],
            when: {
              daysOfWeek: ['monday', 2, 'tues'],
              daysOfMonth: [1, -1],
              start: '9:00',
              end: '17:00:30',
              timezone: 'America/Chicago',
              from: 1893456000000,
              until: 1896134400000,
            },
            weight: 2.5,
            note: 'deepseek is busy in the morning',
          },
          { when: {}, factor: 1 },
        ],
      }),
    ).toBeNull();
  });

  it('refuses a schedule that is not a list of objects, or carries an unknown key', () => {
    expect(validateModelRoute('x', { ...base, schedules: { when: {} } })).toMatch(/schedules must be a list/);
    expect(validateModelRoute('x', { ...base, schedules: ['peak'] })).toMatch(/schedule 1 must be an object/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, factr: 2 }] })).toMatch(
      /schedule 1 has unknown key "factr" \(expected id, targets, when, factor, weight, note\)/,
    );
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, id: 3 }] })).toMatch(/schedule 1 id must be a string/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, note: 3 }] })).toMatch(/schedule 1 note must be a string/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, targets: 'deepseek/*' }] })).toMatch(/targets must be a list/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, targets: ['  '] }] })).toMatch(/non-empty target references/);
  });

  it('refuses a schedule target that matches no target in the route, and an empty targets list', () => {
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: ['anthropic/claude-sonnet-4-6'] }] })).toMatch(
      /schedule 1 target "anthropic\/claude-sonnet-4-6" matches no target in the route/,
    );
    expect(
      validateModelRoute('x', {
        ...base,
        schedules: [
          { when: {}, factor: 2, targets: ['deepseek/v4'] },
          { when: {}, factor: 2, targets: ['openai/y'] },
        ],
      }),
    ).toMatch(/schedule 2 target "openai\/y" matches no target in the route/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: [] }] })).toMatch(
      /targets must not be empty: OpenCode applies a schedule with an empty targets list to every target/,
    );
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: ['deepseek/v4'] }] })).toBeNull();
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: ['deepseek/*'] }] })).toBeNull();
    expect(
      validateModelRoute('x', { targets: ['openai/gpt-*'], schedules: [{ when: {}, factor: 2, targets: ['openai/gpt-6-luna'] }] }),
    ).toBeNull();
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2 }] })).toBeNull();
  });

  it('judges a padded schedule target by its trimmed spelling, the way OpenCode trims before matching', () => {
    // A padded entry that names a route target applies in OpenCode, plain or pattern.
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: [' deepseek/v4 '] }] })).toBeNull();
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: ['\tdeepseek/* '] }] })).toBeNull();
    // Padded entries get the same specific verdicts as their unpadded spellings.
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: [' deepseek/v4#high '] }] })).toMatch(
      /schedule 1 target "deepseek\/v4#high" carries a "#variant" suffix/,
    );
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: [' opencode-route/b '] }] })).toMatch(
      /schedule 1 target "opencode-route\/b" is a route reference/,
    );
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: [' anthropic/claude-sonnet-4-6 '] }] })).toMatch(
      /schedule 1 target "anthropic\/claude-sonnet-4-6" matches no target in the route/,
    );
  });

  it('accepts a schedule target pattern that partly overlaps a route target pattern, and refuses disjoint patterns', () => {
    const withTargets = (targets, entry) =>
      validateModelRoute('x', { targets, schedules: [{ when: {}, factor: 2, targets: [entry] }] });
    // openai/gpt-6-luna matches both patterns, so the schedule can apply.
    expect(withTargets(['openai/*-luna'], 'openai/gpt-*')).toBeNull();
    expect(withTargets(['openai/gpt-*'], 'openai/*-luna')).toBeNull();
    expect(withTargets([{ model: 'openai/*-luna' }], 'openai/gpt-*')).toBeNull();
    expect(withTargets(['openai/gpt-*-luna'], 'openai/*-6-*')).toBeNull();
    expect(withTargets(['anthropic/*'], 'openai/gpt-*')).toMatch(/schedule 1 target "openai\/gpt-\*" matches no target in the route/);
    expect(withTargets(['openai/claude-*'], 'openai/gpt-*')).toMatch(/matches no target in the route/);
    expect(withTargets(['openai/*-luna'], 'openai/*-sol')).toMatch(/matches no target in the route/);
  });

  it('refuses a schedule target carrying a #variant, and judges letter case the way OpenCode does', () => {
    const withEntry = (targets, entry) =>
      validateModelRoute('x', { targets, schedules: [{ when: {}, factor: 2, targets: [entry] }] });
    const route = ['openai/gpt-6-luna', 'anthropic/claude-1'];
    // A variant-suffixed entry is refused even when its model is in the route:
    // OpenCode's schedule reference has no variant, so it could never match.
    expect(withEntry(route, 'openai/gpt-6-luna#high')).toMatch(
      /schedule 1 target "openai\/gpt-6-luna#high" carries a "#variant" suffix: OpenCode matches schedule targets against provider\/model references without a variant/,
    );
    expect(withEntry(route, 'openai/*#high')).toMatch(/carries a "#variant" suffix/);
    expect(withEntry(route, 'anthropic/claude-1#x')).toMatch(/carries a "#variant" suffix/);
    expect(withEntry(['openai/*-luna'], 'openai/gpt-*#high')).toMatch(/carries a "#variant" suffix/);
    // OpenCode's schedule matcher is case-insensitive, so a case-only
    // difference validates: exact, pattern-over-concrete, and overlapping
    // patterns in either direction.
    expect(withEntry(route, 'OpenAI/gpt-6-luna')).toBeNull();
    expect(withEntry(route, 'OPENAI/*')).toBeNull();
    expect(withEntry(route, 'OPENAI/GPT-*')).toBeNull();
    expect(withEntry(['OpenAI/*-LUNA'], 'openai/gpt-*')).toBeNull();
    expect(withEntry(['openai/*-luna'], 'OPENAI/GPT-*')).toBeNull();
    // Case-insensitivity does not rescue an entry that names nothing.
    expect(withEntry(route, 'OpenAI/claude-1')).toMatch(/schedule 1 target "OpenAI\/claude-1" matches no target in the route/);
    expect(withEntry(['openai/*-luna'], 'OPENAI/*-SOL')).toMatch(/matches no target in the route/);
  });

  it('refuses a schedule with no window, no change, or both changes', () => {
    expect(validateModelRoute('x', { ...base, schedules: [{ factor: 0.5 }] })).toMatch(/needs a when window/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: 'weekdays' }] })).toMatch(/needs a when window/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {} }] })).toMatch(/needs a factor or a weight/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 0.5, weight: 2 }] })).toMatch(/both factor and weight/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 0 }] })).toMatch(/factor must be a positive number/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, weight: -1 }] })).toMatch(/weight must be a positive number/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: '0.5' }] })).toMatch(/factor must be a positive number/);
  });

  it('refuses window values OpenCode cannot read, because its parser drops the whole schedule', () => {
    const withWindow = (when) => validateModelRoute('x', { ...base, schedules: [{ when, factor: 0.5 }] });
    expect(withWindow({ daysOfWeek: ['funday'] })).toMatch(/daysOfWeek entry "funday"/);
    expect(withWindow({ daysOfWeek: ['Mon'] })).toMatch(/daysOfWeek entry "Mon"/);
    expect(withWindow({ daysOfWeek: [7] })).toMatch(/daysOfWeek entry "7"/);
    expect(withWindow({ daysOfWeek: 'mon' })).toMatch(/daysOfWeek must be a list/);
    expect(withWindow({ daysOfWeek: [] })).toMatch(/daysOfWeek must not be empty/);
    expect(withWindow({ daysOfMonth: [0] })).toMatch(/daysOfMonth entry "0"/);
    expect(withWindow({ daysOfMonth: [32] })).toMatch(/daysOfMonth entry "32"/);
    expect(withWindow({ daysOfMonth: [] })).toMatch(/daysOfMonth must not be empty/);
    expect(withWindow({ start: '9am' })).toMatch(/window\.start must be a local time/);
    expect(withWindow({ start: '24:00' })).toMatch(/window\.start/);
    expect(withWindow({ end: '17:60' })).toMatch(/window\.end/);
    // Seconds past 59 are out of range and OpenCode refuses the whole schedule.
    expect(withWindow({ start: '09:30:60' })).toMatch(/window\.start must be a local time/);
    expect(withWindow({ end: '09:30:99' })).toMatch(/window\.end must be a local time/);
    expect(withWindow({ timezone: 'Nowhere/Special' })).toMatch(/window\.timezone/);
    expect(withWindow({ from: 0 })).toMatch(/window\.from must be a positive/);
    expect(withWindow({ from: 2000, until: 1000 })).toMatch(/from must be before window\.until/);
    expect(withWindow({ zone: 'UTC' })).toMatch(/window has unknown key "zone"/);
  });

  it('refuses a window whose start and end are the same time, which OpenCode treats as an empty window', () => {
    const withWindow = (when) => validateModelRoute('x', { ...base, schedules: [{ when, factor: 0.5 }] });
    expect(withWindow({ start: '09:00', end: '09:00' })).toMatch(/window\.start and window\.end must not be the same time/);
    expect(withWindow({ start: '00:00', end: '00:00' })).toMatch(/empty window that can never apply/);
    expect(withWindow({ start: '9:00', end: '09:00' })).toMatch(/must not be the same time/);
    expect(withWindow({ start: '09:00:15', end: '09:00:45' })).toMatch(/must not be the same time/);
    // Seconds round down, so these are one minute to OpenCode.
    expect(withWindow({ start: '09:30:5', end: '09:30' })).toMatch(/must not be the same time/);
  });

  it('accepts day numbers, single-digit times and a start past its end, which OpenCode runs past midnight', () => {
    const withWindow = (when) => validateModelRoute('x', { ...base, schedules: [{ when, factor: 0.5 }] });
    expect(withWindow({ daysOfWeek: [0, 6], daysOfMonth: [-1] })).toBeNull();
    expect(withWindow({ start: '22:00', end: '06:00' })).toBeNull();
    expect(withWindow({ start: '09:00' })).toBeNull();
    expect(withWindow({ end: '17:00' })).toBeNull();
    expect(withWindow({ start: '09:00', end: '09:01' })).toBeNull();
    // Seconds are read the way OpenCode reads them: one or two digits, to 59.
    expect(withWindow({ start: '09:30:5', end: '09:31' })).toBeNull();
    expect(withWindow({ start: '9:30', end: '9:31' })).toBeNull();
    expect(withWindow({ timezone: 'UTC', from: 1000, until: 4102444800000 })).toBeNull();
  });

  it('refuses a window that has already ended, which OpenCode can never apply again', () => {
    const withWindow = (when) => validateModelRoute('x', { ...base, schedules: [{ when, factor: 0.5 }] });
    expect(withWindow({ until: 1000 })).toMatch(/window\.until is in the past/);
    expect(withWindow({ from: 1000, until: 2000 })).toMatch(/window\.until is in the past/);
    expect(withWindow({ until: Date.now() + 60000 })).toBeNull();
    expect(withWindow({ from: 1000 })).toBeNull();
  });
});

describe('validateModelRoute description and details', () => {
  const base = { targets: ['openai/gpt-6-luna'] };

  it('accepts a one-line description and a paragraph of details', () => {
    expect(
      validateModelRoute('strong', {
        ...base,
        description: 'Long refactors across many files; slow; costs the most.',
        details: 'Use for work that spans packages.\nAvoid for one-line fixes.',
      }),
    ).toBeNull();
  });

  // The UI reads a value over its own copy of these limits as absent, so a
  // drift would either drop text the server accepts or let through text it refuses.
  it('uses the same limits as the UI', () => {
    expect(MAX_DESCRIPTION_LENGTH).toBe(POOL_DESCRIPTION_MAX_LENGTH);
    expect(MAX_DETAILS_LENGTH).toBe(POOL_DETAILS_MAX_LENGTH);
  });

  it('rejects a multi-line or non-string description, non-string details and text over the caps', () => {
    expect(validateModelRoute('x', { ...base, description: 'one\ntwo' })).toMatch(/description must be one line/);
    expect(validateModelRoute('x', { ...base, description: 4 })).toMatch(/description must be one line/);
    expect(validateModelRoute('x', { ...base, description: 'a'.repeat(201) })).toMatch(/at most 200/);
    expect(validateModelRoute('x', { ...base, details: ['a'] })).toMatch(/details must be text/);
    expect(validateModelRoute('x', { ...base, details: 'a'.repeat(2001) })).toMatch(/at most 2000/);
  });
});

describe('validateModelRouteTuning', () => {
  it('accepts partial tuning and rejects out-of-range values', () => {
    expect(validateModelRouteTuning({})).toBeNull();
    expect(validateModelRouteTuning({ enabled: true, intervalMinutes: 1440, windowHours: 336 })).toBeNull();
    expect(validateModelRouteTuning({ enabled: 'yes' })).toMatch(/enabled/);
    expect(validateModelRouteTuning({ intervalMinutes: 1441 })).toMatch(/intervalMinutes/);
    expect(validateModelRouteTuning({ windowHours: 0 })).toMatch(/windowHours/);
    expect(validateModelRouteTuning(null)).toMatch(/must be an object/);
  });
});

describe('readModelRoutes', () => {
  it('returns {} when experimental.model_routes is missing or not a map', () => {
    expect(readModelRoutes(null)).toEqual({});
    expect(readModelRoutes({})).toEqual({});
    expect(readModelRoutes({ experimental: { model_routes: ['x'] } })).toEqual({});
    expect(readModelRoutes({ experimental: { model_routes: { a: { targets: [] } } } })).toEqual({
      a: { targets: [] },
    });
  });

  it('returns the nested experimental.routes.models map for a nested-only config', () => {
    expect(readModelRoutes({ experimental: { routes: { models: { a: { targets: ['x/y'] } } } } })).toEqual({
      a: { targets: ['x/y'] },
    });
    expect(readModelRoutes({ experimental: { routes: { models: ['x'] } } })).toEqual({});
    expect(readModelRoutes({ experimental: { routes: 'nope' } })).toEqual({});
  });

  it('folds a mixed config with the nested pool winning over the flat pool of the same id', () => {
    const config = {
      experimental: {
        model_routes: { shared: { targets: ['flat/a'] }, flatOnly: { targets: ['flat/b'] } },
        routes: { models: { shared: { targets: ['nested/a'] }, nestedOnly: { targets: ['nested/b'] } } },
      },
    };
    expect(readModelRoutes(config)).toEqual({
      shared: { targets: ['nested/a'] },
      flatOnly: { targets: ['flat/b'] },
      nestedOnly: { targets: ['nested/b'] },
    });
    // The folded map is what validateModelRoutes judges, so a bad nested
    // pool is refused and a good nested pool passes.
    expect(validateModelRoutes(readModelRoutes(config))).toBeNull();
    const bad = { experimental: { routes: { models: { bad: { targets: [] } } } } };
    expect(validateModelRoutes(readModelRoutes(bad))).toMatch(/route "bad" needs at least one target/);
  });
});

const makeApp = () => {
  const routes = { get: [], put: [] };
  return {
    routes,
    app: {
      get: (path, handler) => void routes.get.push([path, handler]),
      put: (...args) => void routes.put.push(args),
    },
  };
};

const res = () => {
  const out = {};
  return {
    out,
    status: (code) => {
      out.status = code;
      return { json: (body) => void (out.body = body) };
    },
    json: (body) => void (out.body = body),
  };
};

describe('registerModelRouteRoutes', () => {
  let targetConfig;
  let deps;

  beforeEach(() => {
    targetConfig = { experimental: { model_routes: { old: { targets: ['a/b'] } } } };
    deps = {
      readConfigLayers: vi.fn(() => ({ mergedConfig: targetConfig, userConfig: targetConfig, paths: { userPath: '/u/opencode.json' } })),
      getConfigForPath: vi.fn(() => targetConfig),
      writeConfig: vi.fn(),
      CONFIG_FILE: '/u/opencode.json',
      isEnterpriseMode: () => false,
      refreshOpenCodeAfterConfigChange: vi.fn(async () => undefined),
    };
  });

  it('GET returns the user file\'s routes and path', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.get[0][1]({}, response);
    expect(response.out.body).toEqual({ routes: { old: { targets: ['a/b'] } }, tuning: null, schedules: null, otherRoutes: [], otherSchedules: [], path: '/u/opencode.json' });
  });

  it('GET returns nested routes, tuning, and schedules for a nested-only config', async () => {
    const schedules = [{ providers: ['deepseek'], when: { start: '09:00', end: '17:00' }, factor: 0.5 }];
    const tuning = { enabled: true, intervalMinutes: 30 };
    targetConfig = {
      experimental: {
        routes: { models: { nested: { targets: ['a/b'] } }, tuning, schedules },
      },
    };
    deps.readConfigLayers = vi.fn(() => ({ mergedConfig: targetConfig, userConfig: targetConfig, paths: { userPath: '/u/opencode.json' } }));
    deps.getConfigForPath = vi.fn(() => targetConfig);
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.get[0][1]({}, response);
    expect(response.out.body.routes).toEqual({ nested: { targets: ['a/b'] } });
    expect(response.out.body.tuning).toEqual(tuning);
    expect(response.out.body.schedules).toEqual(schedules);
  });

  it('GET folds a mixed config with nested tuning and schedules winning', async () => {
    const nestedSchedules = [{ models: ['*flash*'], when: {}, weight: 2 }];
    targetConfig = {
      experimental: {
        model_routes: { shared: { targets: ['flat/a'] } },
        model_route_tuning: { enabled: false },
        model_route_schedules: [{ providers: ['deepseek'], when: {}, factor: 0.5 }],
        routes: {
          models: { shared: { targets: ['nested/a'] } },
          tuning: { enabled: true },
          schedules: nestedSchedules,
        },
      },
    };
    deps.readConfigLayers = vi.fn(() => ({ mergedConfig: targetConfig, userConfig: targetConfig, paths: { userPath: '/u/opencode.json' } }));
    deps.getConfigForPath = vi.fn(() => targetConfig);
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.get[0][1]({}, response);
    expect(response.out.body.routes).toEqual({ shared: { targets: ['nested/a'] } });
    expect(response.out.body.tuning).toEqual({ enabled: true });
    expect(response.out.body.schedules).toEqual(nestedSchedules);
  });

  it('GET lets a higher-priority flat tuning override a lower-priority nested one', async () => {
    const userConfig = { experimental: { routes: { tuning: { enabled: true, intervalMinutes: 30 } } } };
    const projectConfig = { experimental: { model_route_tuning: { enabled: false } } };
    deps.readConfigLayers = vi.fn(() => ({
      userConfig,
      userOverrideConfig: {},
      customConfig: {},
      projectConfig,
      // What shared.js mergeConfigs produces: both files' shapes side by side.
      mergedConfig: {
        experimental: {
          routes: { tuning: { enabled: true, intervalMinutes: 30 } },
          model_route_tuning: { enabled: false },
        },
      },
      paths: { userPath: '/u/opencode.json', userOverridePath: null, customPath: null, projectPath: '/p/opencode.json' },
    }));
    deps.getConfigForPath = vi.fn(() => userConfig);
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.get[0][1]({}, response);
    // The project file outranks the user file, so its flat `enabled: false`
    // wins over the user file's nested `enabled: true`; the key only the
    // lower file sets still applies.
    expect(response.out.body.tuning).toEqual({ enabled: false, intervalMinutes: 30 });
  });

  it('PUT writes edited values into the nested shape and removes the flat keys', async () => {
    targetConfig = {
      experimental: {
        model_routes: { old: { targets: ['a/b'] } },
        model_route_schedules: [{ providers: ['deepseek'], when: {}, factor: 0.5 }],
        routes: { models: { old: { targets: ['a/b'] } } },
      },
    };
    deps.readConfigLayers = vi.fn(() => ({ mergedConfig: targetConfig, userConfig: targetConfig, paths: { userPath: '/u/opencode.json' } }));
    deps.getConfigForPath = vi.fn(() => targetConfig);
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const pools = { fresh: { targets: ['c/d'] } };
    const schedules = [{ routes: ['fresh'], when: {}, weight: 3 }];
    const saved = res();
    await handler({ body: { routes: pools, schedules } }, saved);
    expect(targetConfig.experimental.routes.models).toEqual(pools);
    expect(targetConfig.experimental.routes.schedules).toEqual(schedules);
    expect(targetConfig.experimental.model_routes).toBeUndefined();
    expect(targetConfig.experimental.model_route_schedules).toBeUndefined();
    expect(saved.out.body.routes).toEqual(pools);
    expect(saved.out.body.schedules).toEqual(schedules);
    const removed = res();
    await handler({ body: { schedules: null } }, removed);
    expect(targetConfig.experimental.routes.schedules).toBeUndefined();
    expect(removed.out.body.schedules).toBeNull();
  });

  it('GET lists another file\'s nested schedules as otherSchedules', async () => {
    const nestedSchedules = [{ targets: ['openai/*'], when: {}, weight: 3 }];
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, {
      ...deps,
      resolveOptionalProjectDirectory: vi.fn(async () => ({ directory: '/p' })),
      readConfigSources: vi.fn(() => [
        { path: '/u/opencode.json', config: targetConfig },
        { path: '/p/opencode.json', config: { experimental: { routes: { schedules: nestedSchedules } } } },
      ]),
    });
    const response = res();
    await routes.get[0][1]({}, response);
    expect(response.out.body.otherSchedules).toEqual([{ path: '/p/opencode.json', schedules: nestedSchedules }]);
  });

  it('GET returns the cross-pool schedules', async () => {
    const schedules = [{ providers: ['deepseek'], when: { start: '09:00', end: '17:00' }, factor: 0.5 }];
    targetConfig.experimental.model_route_schedules = schedules;
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.get[0][1]({}, response);
    expect(response.out.body.schedules).toEqual(schedules);
  });

  // #298: `schedules` was not a known route key, so a single pool with a
  // schedule made every save of the whole map fail with a 400.
  it('PUT saves a map in which a pool has schedules', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const pools = {
      peak: {
        targets: ['deepseek/v4', 'openai/gpt-6-luna'],
        schedules: [{ id: 'peak', targets: ['deepseek/*'], when: { daysOfWeek: ['mon', 'fri'], start: '09:00', end: '17:00', timezone: 'America/Chicago' }, factor: 0.5 }],
      },
      other: { targets: ['a/b'] },
    };
    const response = res();
    await handler({ body: { routes: pools } }, response);
    expect(response.out.status).toBeUndefined();
    expect(targetConfig.experimental.model_routes).toEqual(pools);
    expect(deps.writeConfig).toHaveBeenCalledTimes(1);
  });

  it('PUT writes cross-pool schedules alone and removes them when null', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const schedules = [{ routes: ['old'], models: ['*flash*'], when: { daysOfMonth: [1, -1] }, weight: 3, note: 'month ends' }];
    const saved = res();
    await handler({ body: { schedules } }, saved);
    expect(targetConfig.experimental.model_routes).toEqual({ old: { targets: ['a/b'] } });
    expect(targetConfig.experimental.model_route_schedules).toEqual(schedules);
    expect(saved.out.body.schedules).toEqual(schedules);
    const removed = res();
    await handler({ body: { schedules: null } }, removed);
    expect(targetConfig.experimental.model_route_schedules).toBeUndefined();
    expect(removed.out.body.schedules).toBeNull();
  });

  // OpenCode adds up model_route_schedules from every config file, while the
  // merged config keeps only the last file's list. Editing the merged list and
  // writing it to the user file made schedules apply twice.
  describe('with schedules in two config files', () => {
    const userSchedules = [{ providers: ['deepseek'], when: {}, factor: 0.5 }];
    const projectSchedules = [{ models: ['*flash*'], when: { daysOfWeek: ['sat'] }, weight: 2 }];
    let userConfig;
    let projectConfig;
    let layered;

    beforeEach(() => {
      userConfig = { experimental: { model_routes: { old: { targets: ['a/b'] } }, model_route_schedules: userSchedules } };
      projectConfig = { experimental: { model_route_schedules: projectSchedules } };
      const withProject = {
        userConfig,
        userOverrideConfig: {},
        customConfig: {},
        projectConfig,
        // What shared.js mergeConfigs produces: the later file's list replaces the earlier one.
        mergedConfig: { experimental: { ...userConfig.experimental, model_route_schedules: projectSchedules } },
        paths: { userPath: '/u/opencode.json', userOverridePath: null, customPath: null, projectPath: '/p/opencode.json' },
      };
      // Like shared.js readConfigLayers: without a working directory there is no project layer.
      const withoutProject = {
        ...withProject,
        projectConfig: {},
        mergedConfig: { experimental: { ...userConfig.experimental } },
        paths: { ...withProject.paths, projectPath: null },
      };
      layered = {
        ...deps,
        readConfigLayers: vi.fn((directory) => (directory === '/p' ? withProject : withoutProject)),
        getConfigForPath: vi.fn((given, path) => (path === '/p/opencode.json' ? given.projectConfig : given.userConfig)),
        resolveOptionalProjectDirectory: vi.fn(async (req) => ({ directory: req.query?.directory ?? null })),
      };
    });

    it('GET returns the user file\'s list to edit and the other file\'s list apart', async () => {
      const { app, routes } = makeApp();
      registerModelRouteRoutes(app, layered);
      const response = res();
      await routes.get[0][1]({ query: { directory: '/p' } }, response);
      expect(response.out.body.schedules).toEqual(userSchedules);
      expect(response.out.body.otherSchedules).toEqual([{ path: '/p/opencode.json', schedules: projectSchedules }]);
    });

    it('GET without a project directory lists no project schedules', async () => {
      const { app, routes } = makeApp();
      registerModelRouteRoutes(app, layered);
      const response = res();
      await routes.get[0][1]({ query: {} }, response);
      expect(response.out.body.schedules).toEqual(userSchedules);
      expect(response.out.body.otherSchedules).toEqual([]);
    });

    it('GET lists every folder file OpenCode reads, in its order, and never the user file', async () => {
      const ancestorSchedules = [{ providers: ['groq'], when: {}, factor: 0.8 }];
      const dotSchedules = [{ targets: ['openai/*'], when: {}, weight: 3 }];
      const { app, routes } = makeApp();
      registerModelRouteRoutes(app, {
        ...layered,
        readConfigSources: vi.fn((directory) => (directory === '/p'
          ? [
              { path: '/u/opencode.json', config: userConfig },
              { path: '/opencode.json', config: { experimental: { model_route_schedules: ancestorSchedules } } },
              { path: '/p/opencode.json', config: projectConfig },
              { path: '/p/.opencode/opencode.json', config: { experimental: { model_route_schedules: dotSchedules } } },
            ]
          : [{ path: '/u/opencode.json', config: userConfig }])),
      });
      const response = res();
      await routes.get[0][1]({ query: { directory: '/p' } }, response);
      expect(response.out.body.otherSchedules).toEqual([
        { path: '/opencode.json', schedules: ancestorSchedules },
        { path: '/p/opencode.json', schedules: projectSchedules },
        { path: '/p/.opencode/opencode.json', schedules: dotSchedules },
      ]);
    });

    it('PUT writes only the user file\'s list, and a save of routes alone leaves it as it was', async () => {
      const { app, routes } = makeApp();
      registerModelRouteRoutes(app, layered);
      const [, , , handler] = routes.put[0];
      const edited = [{ ...userSchedules[0], factor: 0.25 }];
      const saved = res();
      await handler({ body: { schedules: edited }, query: { directory: '/p' } }, saved);
      expect(userConfig.experimental.model_route_schedules).toEqual(edited);
      expect(projectConfig.experimental.model_route_schedules).toEqual(projectSchedules);
      expect(saved.out.body.schedules).toEqual(edited);
      expect(saved.out.body.otherSchedules).toEqual([{ path: '/p/opencode.json', schedules: projectSchedules }]);

      const routesOnly = res();
      await handler({ body: { routes: { old: { targets: ['a/c'] } } }, query: { directory: '/p' } }, routesOnly);
      expect(userConfig.experimental.model_route_schedules).toEqual(edited);
      expect(routesOnly.out.body.schedules).toEqual(edited);
    });
  });

  // #324: GET returned the merged pool map and every save wrote the whole map
  // to the user file, so a pool defined only in a project file was copied
  // into the user file and kept applying to every project.
  describe('with pools in two config files', () => {
    const userRoutes = { own: { targets: ['a/b'] } };
    const projectRoutes = { projectonly: { targets: ['p/m'] } };
    let userConfig;
    let projectConfig;
    let layered;

    beforeEach(() => {
      userConfig = { experimental: { model_routes: userRoutes } };
      projectConfig = { experimental: { model_routes: projectRoutes } };
      const withProject = {
        userConfig,
        userOverrideConfig: {},
        customConfig: {},
        projectConfig,
        mergedConfig: { experimental: { model_routes: { ...userRoutes, ...projectRoutes } } },
        paths: { userPath: '/u/opencode.json', userOverridePath: null, customPath: null, projectPath: '/p/opencode.json' },
      };
      const withoutProject = {
        ...withProject,
        projectConfig: {},
        mergedConfig: { experimental: { model_routes: userRoutes } },
        paths: { ...withProject.paths, projectPath: null },
      };
      layered = {
        ...deps,
        readConfigLayers: vi.fn((directory) => (directory === '/p' ? withProject : withoutProject)),
        getConfigForPath: vi.fn((given, path) => (path === '/p/opencode.json' ? given.projectConfig : given.userConfig)),
        resolveOptionalProjectDirectory: vi.fn(async (req) => ({ directory: req.query?.directory ?? null })),
      };
    });

    it('GET returns the user file\'s pools to edit and the other file\'s pools apart', async () => {
      const { app, routes } = makeApp();
      registerModelRouteRoutes(app, layered);
      const response = res();
      await routes.get[0][1]({ query: { directory: '/p' } }, response);
      expect(response.out.body.routes).toEqual(userRoutes);
      expect(response.out.body.otherRoutes).toEqual([{ path: '/p/opencode.json', routes: projectRoutes }]);
    });

    it('GET without a project directory lists no project pools', async () => {
      const { app, routes } = makeApp();
      registerModelRouteRoutes(app, layered);
      const response = res();
      await routes.get[0][1]({ query: {} }, response);
      expect(response.out.body.routes).toEqual(userRoutes);
      expect(response.out.body.otherRoutes).toEqual([]);
    });

    it('a save performed while a project-defined pool is present does not copy it into the user file', async () => {
      const { app, routes } = makeApp();
      registerModelRouteRoutes(app, layered);
      const [, , , handler] = routes.put[0];
      // The client edits only the user file's pools, as GET now returns them.
      const edited = { own: { targets: ['a/c'] } };
      const saved = res();
      await handler({ body: { routes: edited }, query: { directory: '/p' } }, saved);
      expect(userConfig.experimental.model_routes).toEqual(edited);
      expect(projectConfig.experimental.model_routes).toEqual(projectRoutes);
      expect(saved.out.body.routes).toEqual(edited);
      expect(saved.out.body.otherRoutes).toEqual([{ path: '/p/opencode.json', routes: projectRoutes }]);
    });

    it('a tuning save alone returns the user file\'s pools, not the merged map', async () => {
      const { app, routes } = makeApp();
      registerModelRouteRoutes(app, layered);
      const [, , , handler] = routes.put[0];
      const saved = res();
      await handler({ body: { tuning: { enabled: true } }, query: { directory: '/p' } }, saved);
      expect(saved.out.body.routes).toEqual(userRoutes);
      expect(userConfig.experimental.model_routes).toEqual(userRoutes);
    });
  });

  it('GET returns a stored list it cannot read as stored, so the editor can show it', async () => {
    targetConfig.experimental.model_route_schedules = { start: 900 };
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.get[0][1]({}, response);
    expect(response.out.body.schedules).toEqual({ start: 900 });
  });

  it('PUT rejects a bad cross-pool schedule and writes nothing', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.put[0][3]({ body: { schedules: [{ when: { start: '25:00' }, factor: 2 }] } }, response);
    expect(response.out.status).toBe(400);
    expect(response.out.body.error).toMatch(/schedule 1 window\.start/);
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it('PUT writes tuning alone and removes it when null', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const saved = res();
    await handler({ body: { tuning: { enabled: true, intervalMinutes: 30 } } }, saved);
    expect(targetConfig.experimental.model_routes).toEqual({ old: { targets: ['a/b'] } });
    expect(targetConfig.experimental.model_route_tuning).toEqual({ enabled: true, intervalMinutes: 30 });
    expect(saved.out.body.tuning).toEqual({ enabled: true, intervalMinutes: 30 });
    const removed = res();
    await handler({ body: { tuning: null } }, removed);
    expect(targetConfig.experimental.model_route_tuning).toBeUndefined();
    expect(removed.out.body.tuning).toBeNull();
  });

  it('PUT with neither routes nor tuning is a 400', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.put[0][3]({ body: {} }, response);
    expect(response.out.status).toBe(400);
  });

  it('PUT rejects out-of-range tuning', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.put[0][3]({ body: { tuning: { intervalMinutes: 0 } } }, response);
    expect(response.out.status).toBe(400);
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it('PUT validates, writes and refreshes', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    // [path, jsonParser, enterprise guard, handler]
    const [, , , handler] = routes.put[0];
    const response = res();
    await handler({ body: { routes: { luna: { targets: ['openai/x'], autonomy: 'agent' } } } }, response);
    expect(response.out.body.routes).toEqual({ luna: { targets: ['openai/x'], autonomy: 'agent' } });
    expect(targetConfig.experimental.model_routes).toEqual({ luna: { targets: ['openai/x'], autonomy: 'agent' } });
    expect(deps.writeConfig).toHaveBeenCalledWith(targetConfig, '/u/opencode.json');
    expect(deps.refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('model-routes');
  });

  it('PUT rejects invalid routes with 400 and writes nothing', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const response = res();
    await handler({ body: { routes: { x: { targets: [] } } } }, response);
    expect(response.out.status).toBe(400);
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it('PUT parses its own body so saves never see undefined', () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    // Without a parser on this route the handler saw `req.body === undefined`
    // and every save failed while the UI showed an optimistic pool.
    expect(routes.put[0][1]?.name).toBe('jsonParser');
  });

  it('refuses writes in enterprise mode', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, { ...deps, isEnterpriseMode: () => true });
    const [, , guard] = routes.put[0];
    const response = res();
    let nextCalled = false;
    guard({}, response, () => void (nextCalled = true));
    expect(nextCalled).toBe(false);
    expect(response.out.status).toBe(403);
  });

  it('exposes every autonomy level the OpenCode schema accepts', () => {
    expect(AUTONOMY_LEVELS).toEqual(['fixed', 'rules', 'adaptive', 'predictive', 'agent']);
  });

  it('names an unknown key in a PUT and writes nothing', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const response = res();
    await handler({ body: { routes: { x: { targets: ['a/b'], attmepts: 2 } } } }, response);
    expect(response.out.status).toBe(400);
    expect(response.out.body.error).toMatch(/unknown key "attmepts"/);
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it('PUT saves a pool with schedules as sent, beside a pool without one', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const sent = {
      other: { targets: ['openai/x'] },
      peak: {
        targets: ['deepseek/v4'],
        schedules: [{ when: { daysOfWeek: ['mon'], start: '09:00', end: '17:00' }, factor: 0.5 }],
      },
    };
    const response = res();
    await handler({ body: { routes: sent } }, response);
    expect(response.out.status).toBeUndefined();
    expect(targetConfig.experimental.model_routes).toEqual(sent);
    expect(response.out.body.routes).toEqual(sent);
  });

  it('saves tuning notes as sent', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const notes = ['openai/gpt-6: reset at 2026-01-01T06:00:00Z'];
    const saved = res();
    await handler({ body: { tuning: { enabled: true, notes } } }, saved);
    expect(targetConfig.experimental.model_route_tuning).toEqual({ enabled: true, notes });
    expect(saved.out.body.tuning).toEqual({ enabled: true, notes });
  });
});

describe('validateModelRoute strictness', () => {
  const base = { targets: ['a/b'] };

  it('names an unknown key on the route, a target, a health block and a budget', () => {
    expect(validateModelRoute('x', { ...base, attmepts: 2 })).toMatch(/route "x" has unknown key "attmepts" \(expected name, targets/);
    expect(validateModelRoute('x', { targets: [{ model: 'a/b', defualtVariant: 'max' }] })).toMatch(/unknown key "defualtVariant"/);
    expect(validateModelRoute('x', { ...base, health: { sampleWindo: 5 } })).toMatch(/health has unknown key "sampleWindo"/);
    expect(validateModelRoute('x', { ...base, budgets: { 'a/b': { requestsPerDayy: 5 } } })).toMatch(/budget for "a\/b" has unknown key "requestsPerDayy"/);
  });

  it('refuses a budget for a target the route does not have', () => {
    expect(validateModelRoute('x', { targets: ['a/b', 'c/d'], budgets: { 'a/b': { requestsPerDay: 5 }, 'c/d': { tokensPerDay: 5 } } })).toBeNull();
    expect(validateModelRoute('x', { ...base, budgets: { 'c/d': { requestsPerDay: 5 } } })).toMatch(/budget for "c\/d" matches no target/);
    expect(validateModelRoute('x', { targets: ['a/b#high'], budgets: { 'a/b': { requestsPerDay: 5 } } })).toBeNull();
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], budgets: { 'openai/gpt-6-luna': { requestsPerDay: 5 } } })).toBeNull();
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], budgets: { 'anthropic/gpt-6-luna': { requestsPerDay: 5 } } })).toMatch(/budget for "anthropic\/gpt-6-luna" matches no target/);
  });

  it('refuses a budget keyed by a pattern, which OpenCode never reads', () => {
    expect(validateModelRoute('x', { targets: ['openai/*'], budgets: { 'openai/*': { requestsPerDay: 5 } } })).toMatch(/budget for "openai\/\*" is keyed by a pattern/);
    expect(validateModelRoute('x', { targets: ['openai/*'], budgets: { 'openai/gpt-*': { requestsPerDay: 5 } } })).toMatch(/budget for "openai\/gpt-\*" is keyed by a pattern/);
    expect(validateModelRoute('x', { targets: ['openai/*'], budgets: { 'openai/gpt-6-luna': { requestsPerDay: 5 } } })).toBeNull();
  });

  it('refuses a weight keyed by a pattern, which OpenCode never reads', () => {
    expect(validateModelRoute('x', { targets: ['openai/*'], weights: { 'openai/*': 2 } })).toMatch(/weight for "openai\/\*" is keyed by a pattern/);
    expect(validateModelRoute('x', { targets: ['openai/*'], weights: { 'openai/gpt-*': 2 } })).toMatch(/weight for "openai\/gpt-\*" is keyed by a pattern/);
    expect(validateModelRoute('x', { targets: ['openai/*'], weights: { 'openai/gpt-6-luna': 2 } })).toBeNull();
    expect(validateModelRoute('x', { targets: ['opencode-route/other'], weights: { 'opencode-route/other': 2 } })).toBeNull();
  });

  it('refuses a weight for a target the route does not have', () => {
    expect(validateModelRoute('x', { targets: ['a/b', 'c/d'], weights: { 'a/b': 2, 'c/d': 1 } })).toBeNull();
    expect(validateModelRoute('x', { ...base, weights: { 'c/d': 2 } })).toMatch(/weight for "c\/d" matches no target/);
  });

  it('keys weights by the model without its variant, and does not accept a variant in the key', () => {
    expect(validateModelRoute('x', { targets: ['a/b#high'], weights: { 'a/b': 2 } })).toBeNull();
    expect(validateModelRoute('x', { targets: ['a/b#high'], weights: { 'a/b#high': 2 } })).toMatch(/matches no target/);
  });

  it('accepts a weight for a model a wildcard target matches, and refuses one it does not', () => {
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], weights: { 'openai/gpt-6-luna': 3 } })).toBeNull();
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], weights: { 'anthropic/gpt-6-luna': 3 } })).toMatch(/matches no target/);
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], weights: { 'openai/claude-5': 3 } })).toMatch(/matches no target/);
  });

  it('refuses selection modes that a fixed route would ignore', () => {
    expect(validateModelRoute('x', { ...base, autonomy: 'fixed', selection: 'weighted' })).toMatch(/is fixed.*"weighted" needs autonomy rules/);
    expect(validateModelRoute('x', { ...base, autonomy: 'fixed', selection: 'round-robin' })).toMatch(/"round-robin" needs autonomy rules/);
    expect(validateModelRoute('x', { ...base, autonomy: 'fixed', selection: 'ordered' })).toBeNull();
    expect(validateModelRoute('x', { ...base, autonomy: 'rules', selection: 'weighted' })).toBeNull();
    expect(validateModelRoute('x', { ...base, selection: 'weighted', weights: { 'a/b': 2 } })).toBeNull();
  });

  it('refuses weights and budgets that a fixed route would ignore', () => {
    expect(validateModelRoute('x', { ...base, autonomy: 'fixed', weights: { 'a/b': 2 } })).toMatch(/is fixed.*weights need autonomy rules/);
    expect(validateModelRoute('x', { ...base, autonomy: 'fixed', budgets: { 'a/b': { requestsPerDay: 10 } } })).toMatch(/is fixed.*budgets need autonomy rules/);
    expect(validateModelRoute('x', { ...base, autonomy: 'rules', weights: { 'a/b': 2 } })).toBeNull();
    expect(validateModelRoute('x', { ...base, autonomy: 'rules', budgets: { 'a/b': { requestsPerDay: 10 } } })).toBeNull();
    expect(validateModelRoute('x', { ...base, weights: { 'a/b': 2 }, budgets: { 'a/b': { requestsPerDay: 10 } } })).toBeNull();
  });

  it('refuses a slow threshold larger than the window, using OpenCode defaults for unset values', () => {
    expect(validateModelRoute('x', { ...base, health: { sampleWindow: 2, slowThreshold: 3 } })).toMatch(/slowThreshold \(3\) cannot exceed health\.sampleWindow \(2\)/);
    expect(validateModelRoute('x', { ...base, health: { sampleWindow: 2 } })).toMatch(/slowThreshold \(3\) cannot exceed/);
    expect(validateModelRoute('x', { ...base, health: { sampleWindow: 3, slowThreshold: 3 } })).toBeNull();
    expect(validateModelRoute('x', { ...base, health: { slowThreshold: 6 } })).toMatch(/cannot exceed health\.sampleWindow \(5\)/);
    expect(validateModelRoute('x', { ...base, health: { slowThreshold: 5 } })).toBeNull();
    expect(validateModelRoute('x', { ...base, health: { slowThreshold: 4 } })).toBeNull();
  });
});

describe('validateModelRouteTuning strictness', () => {
  it('names an unknown tuning key', () => {
    expect(validateModelRouteTuning({ enabled: true, intervalMinute: 5 })).toMatch(/tuning has unknown key "intervalMinute"/);
  });

  it('accepts notes written as `match: text` lines', () => {
    expect(
      validateModelRouteTuning({
        enabled: true,
        notes: ['openai/gpt-6: reset at 2026-01-01T06:00:00Z', 'anthropic: back in 3 hours'],
      }),
    ).toBeNull();
  });

  it('accepts a later colon in the text, and refuses a line with nothing before its colon or nothing after it', () => {
    expect(validateModelRouteTuning({ notes: ['match: text'] })).toBeNull();
    expect(validateModelRouteTuning({ notes: ['x::y'] })).toBeNull();
    expect(validateModelRouteTuning({ notes: [':x:y'] })).toMatch(/line 1 must read "match: text"/);
    expect(validateModelRouteTuning({ notes: ['x:'] })).toMatch(/line 1 must read "match: text"/);
  });

  it('refuses notes that are not a list of strings, or whose lines OpenCode would drop', () => {
    expect(validateModelRouteTuning({ notes: 'openai: back in 3 hours' })).toMatch(/notes must be a list of strings/);
    expect(validateModelRouteTuning({ notes: [3] })).toMatch(/notes must be a list of strings/);
    expect(validateModelRouteTuning({ notes: ['openai back in 3 hours'] })).toMatch(/line 1 must read "match: text"/);
    expect(validateModelRouteTuning({ notes: ['ok: fine', ': no match'] })).toMatch(/line 2 must read/);
    expect(validateModelRouteTuning({ notes: ['openai:   '] })).toMatch(/line 1 must read/);
    expect(validateModelRouteTuning({ notes: ['openai: back\nin 3 hours'] })).toMatch(/line 1 must read "match: text" on one line/);
    expect(validateModelRouteTuning({ notes: [{ match: 'openai', text: 'back' }] })).toMatch(/notes must be a list of strings/);
  });
});

describe('validateModelRouteSchedules', () => {
  it('accepts every field the OpenCode GlobalSchedule schema defines', () => {
    expect(
      validateModelRouteSchedules([
        { id: 'g', providers: ['deepseek'], models: ['*flash*'], targets: ['openai/gpt-6-*'], routes: ['cheap'], when: { daysOfWeek: ['sat', 'sun'] }, weight: 0.5, note: 'weekends' },
      ]),
    ).toBeNull();
    expect(validateModelRouteSchedules([])).toBeNull();
  });

  it('refuses a non-list, an unknown key and a bad window', () => {
    expect(validateModelRouteSchedules({})).toMatch(/schedules must be a list/);
    expect(validateModelRouteSchedules([{ provider: ['x'], when: {}, factor: 2 }])).toMatch(/schedule 1 has unknown key "provider"/);
    expect(validateModelRouteSchedules([{ when: {}, factor: 2 }, { routes: 'cheap', when: {}, factor: 2 }])).toMatch(/schedule 2 routes must be a list/);
    expect(validateModelRouteSchedules([{ when: { start: '24:00' }, factor: 2 }])).toMatch(/^schedule 1 window\.start must be a local time/);
    // The same seconds handling on the cross-pool surface: out of range is
    // refused, one digit is accepted, as OpenCode's `minutesOf` reads them.
    expect(validateModelRouteSchedules([{ when: { start: '09:30:60' }, factor: 2 }])).toMatch(/^schedule 1 window\.start must be a local time/);
    expect(validateModelRouteSchedules([{ when: { end: '09:30:99' }, factor: 2 }])).toMatch(/^schedule 1 window\.end must be a local time/);
    expect(validateModelRouteSchedules([{ when: { start: '09:30:5', end: '09:31:59' }, factor: 2 }])).toBeNull();
  });

  // The same list rules a route's own schedules follow: OpenCode reads an empty
  // matcher as "everything", so a blank entry or an empty list is refused.
  it('refuses a blank entry and an empty matcher list', () => {
    expect(validateModelRouteSchedules([{ providers: ['deepseek', ''], when: {}, factor: 2 }])).toMatch(/providers must be a list of non-blank strings/);
    expect(validateModelRouteSchedules([{ models: [], when: {}, factor: 2 }])).toMatch(/models must not be empty/);
  });

  it('refuses a schedule with no change or with both changes', () => {
    expect(validateModelRouteSchedules([{ when: {} }])).toMatch(/needs a factor or a weight/);
    expect(validateModelRouteSchedules([{ when: {}, factor: 2, weight: 3 }])).toMatch(/both factor and weight/);
    expect(validateModelRouteSchedules([{ when: {}, weight: -1 }])).toMatch(/weight must be a positive number/);
  });
});
