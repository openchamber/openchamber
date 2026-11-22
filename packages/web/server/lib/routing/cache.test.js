import { describe, expect, it } from 'vitest';
import { PROMPT_CACHE_TTL_MS, cacheHoldCategory, warmWindowMs } from './cache.js';


const SONNET = { providerID: 'anthropic', modelID: 'sonnet' };
const OPUS = { providerID: 'anthropic', modelID: 'opus' };
const FALLBACK = { model: SONNET, variant: 'medium' };
const MINUTE = 60_000;

const category = (id, { builtin = true, model = null, agent = null } = {}) => ({
  id, builtin, enabled: true, name: id, description: id, model, variant: null, agent,
});

describe('cacheHoldCategory', () => {
  it('holds a lower built-in category on the model that wrote the last answer', () => {
    const trivial = category('trivial', { model: OPUS });
    const hard = category('hard');
    expect(cacheHoldCategory({ categories: [trivial, hard], fallback: FALLBACK, composerAgent: null, chosen: trivial, current: SONNET })).toBe(hard);
  });

  it('switches as Jev said when the chosen category already runs the model that wrote the last answer', () => {
    const trivial = category('trivial');
    const hard = category('hard', { model: OPUS });
    expect(cacheHoldCategory({ categories: [trivial, hard], fallback: FALLBACK, composerAgent: null, chosen: hard, current: OPUS })).toBeNull();
  });

  it('never holds a move up', () => {
    const trivial = category('trivial');
    const hard = category('hard', { model: OPUS });
    expect(cacheHoldCategory({ categories: [trivial, hard], fallback: FALLBACK, composerAgent: null, chosen: hard, current: SONNET })).toBeNull();
  });

  it('does not hold when there is no last answer, no chosen category, or the chosen one is user-defined', () => {
    const trivial = category('trivial', { model: OPUS });
    const hard = category('hard');
    expect(cacheHoldCategory({ categories: [trivial, hard], fallback: FALLBACK, composerAgent: null, chosen: trivial, current: null })).toBeNull();
    expect(cacheHoldCategory({ categories: [trivial, hard], fallback: FALLBACK, composerAgent: null, chosen: null, current: SONNET })).toBeNull();
    const mine = category('mine', { builtin: false, model: OPUS });
    expect(cacheHoldCategory({ categories: [mine, hard], fallback: FALLBACK, composerAgent: null, chosen: mine, current: SONNET })).toBeNull();
  });

  it('does not hold on a higher category the user added, which has no place in the built-in order', () => {
    const trivial = category('trivial', { model: OPUS });
    const mine = category('mine', { builtin: false, model: SONNET });
    expect(cacheHoldCategory({ categories: [trivial, mine], fallback: FALLBACK, composerAgent: null, chosen: trivial, current: SONNET })).toBeNull();
  });

  it('reads a category without its own model as the fallback model', () => {
    const trivial = category('trivial', { model: OPUS });
    const hard = category('hard');
    expect(cacheHoldCategory({ categories: [trivial, hard], fallback: { model: SONNET }, composerAgent: null, chosen: trivial, current: SONNET })).toBe(hard);
  });

  it('holds only a category that runs the same agent as the chosen one', () => {
    const otherAgent = category('hard', { model: null, agent: 'plan' });
    const sameAgent = category('review', { agent: 'build' });
    const trivial = category('trivial', { model: OPUS, agent: 'build' });
    expect(cacheHoldCategory({ categories: [trivial, otherAgent], fallback: FALLBACK, composerAgent: null, chosen: trivial, current: SONNET })).toBeNull();
    expect(cacheHoldCategory({ categories: [trivial, sameAgent], fallback: FALLBACK, composerAgent: null, chosen: trivial, current: SONNET })).toBe(sameAgent);
  });

  it('takes the highest category on the model that wrote the last answer', () => {
    const trivial = category('trivial', { model: OPUS });
    const review = category('review');
    const hard = category('hard');
    expect(cacheHoldCategory({ categories: [trivial, review, hard], fallback: FALLBACK, composerAgent: null, chosen: trivial, current: SONNET })).toBe(hard);
  });
});

describe('warmWindowMs', () => {
  it('is the plain prompt cache lifetime when warming is absent, off, or unreadable', () => {
    expect(warmWindowMs(undefined)).toBe(PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: {} }])).toBe(PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: { warming: false } }])).toBe(PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: { warming: 'yes' } }])).toBe(PROMPT_CACHE_TTL_MS);
  });

  it('adds OpenCode\'s 30 minute default warming window to the cache lifetime for `warming: true`', () => {
    expect(warmWindowMs([{ info: { warming: true } }])).toBe(30 * MINUTE + PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: { warming: {} } }])).toBe(30 * MINUTE + PROMPT_CACHE_TTL_MS);
  });

  it('reads OpenCode\'s millisecond duration and a hand-written one', () => {
    expect(warmWindowMs([{ info: { warming: { duration: '1800000 millis' } } }])).toBe(30 * MINUTE + PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: { warming: { duration: '45 minutes' } } }])).toBe(45 * MINUTE + PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: { warming: { duration: '1.5 hours' } } }])).toBe(90 * MINUTE + PROMPT_CACHE_TTL_MS);
  });

  it('falls back to the default window for a duration it cannot read or a zero one', () => {
    expect(warmWindowMs([{ info: { warming: { duration: 'soon' } } }])).toBe(30 * MINUTE + PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: { warming: { duration: '0 minutes' } } }])).toBe(30 * MINUTE + PROMPT_CACHE_TTL_MS);
  });

  it('lets the last entry that sets warming win, as OpenCode reads them', () => {
    expect(warmWindowMs([{ info: { warming: true } }, { info: { warming: false } }])).toBe(PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: { warming: false } }, { info: { warming: { duration: '10 minutes' } } }])).toBe(10 * MINUTE + PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: null }, { info: { warming: true } }])).toBe(30 * MINUTE + PROMPT_CACHE_TTL_MS);
  });
});

// ---- upstream tests ----

describe('routing warm window', () => {
  it('accepts entries without info and keeps the last warming value', () => {
    expect(warmWindowMs([{ path: '/repo' }])).toBe(PROMPT_CACHE_TTL_MS);
    expect(warmWindowMs([{ info: { warming: true } }, { path: '/repo' }]))
      .toBe(30 * 60_000 + PROMPT_CACHE_TTL_MS);
  });

  it('treats a malformed response as a cold cache', () => {
    expect(warmWindowMs([{ info: { warming: true } }, { info: { warming: 'yes' } }]))
      .toBe(PROMPT_CACHE_TTL_MS);
  });

  it('ignores absent warming fields after the last explicit value', () => {
    expect(warmWindowMs([{ info: { warming: true } }, { info: null }, {}]))
      .toBe(30 * 60_000 + PROMPT_CACHE_TTL_MS);
  });

  it('keeps the default duration for inherited dictionary names and unknown units', () => {
    for (const duration of ['1 constructor', '1 toString', '1 unknown']) {
      expect(warmWindowMs([{ info: { warming: { duration } } }]))
        .toBe(30 * 60_000 + PROMPT_CACHE_TTL_MS);
    }
  });

  it('parses each supported duration scale', () => {
    for (const [duration, ms] of [['1 millis', 1], ['2 seconds', 2000], ['1.5 minutes', 90_000], ['2 hours', 7_200_000]]) {
      expect(warmWindowMs([{ info: { warming: { duration } } }])).toBe(ms + PROMPT_CACHE_TTL_MS);
    }
  });
});
