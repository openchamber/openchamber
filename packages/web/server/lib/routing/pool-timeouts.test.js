import { describe, expect, it } from 'vitest';
import { validateModelRoute, validateModelRoutes } from './model-routes.js';
import { normalizePoolTimeouts, resolvePoolTimeout } from './pool-timeouts.js';

// Oracle: selected-pool health is the runtime policy. Defaults are 30 seconds,
// custom limits stay, and a derived parent is the min/max of its children.
describe('pool effort schema and first-output limits', () => {
  it('accepts every extended member field without losing false sit-outs', () => {
    expect(validateModelRoute('mixed', {
      targets: [{ model: '*/luna#high', exclude: ['other'], defaultVariant: 'low', variants: { max: false },
        limit: { context: 100_000 }, cache_format: 'anthropic', window: { name: 'off-peak', invert: true } }],
      include: ['*haiku*'], exclude: ['*-mini'], contains: ['sonnet'], notContains: ['old'],
      match: '(*luna* or fast) and not *mini*', levels: [], system: 'Review carefully.',
      variantRules: [{ match: '*luna*', map: { low: 'high', max: false } }], limit: { context: 100_000 },
    })).toBeNull();
    expect(validateModelRoutes({ base: { include: ['*luna*'] }, top: { targets: [{ model: 'opencode-route/base', variants: { max: false } }] } })).toBeNull();
    expect(validateModelRoute('bad', { targets: ['p/m'], variantRules: [{ match: 'x and', map: {} }] })).toMatch(/match/);
  });
  it('sets bounded defaults and recursively uses longest or shortest', () => {
    const routes = { slow: { targets: ['p/slow'], health: { firstTokenTimeoutMs: 120_000 } },
      fast: { targets: ['p/fast'], health: { firstTokenTimeoutMs: 5_000 } },
      nested: { targets: ['opencode-route/slow', 'opencode-route/fast'] },
      top: { targets: ['opencode-route/nested'] }, basic: { targets: ['p/basic'] } };
    const normalized = normalizePoolTimeouts(routes);
    expect(Object.fromEntries(Object.keys(routes).map((id) => [id, resolvePoolTimeout(routes, id)]))).toEqual({ slow: 120_000, fast: 5_000, nested: 120_000, top: 120_000, basic: 30_000 });
    expect(normalizePoolTimeouts(normalized)).toEqual(normalized);
    expect(normalizePoolTimeouts({ ...routes, nested: { ...routes.nested, nestedTimeout: 'shortest' } }).top.health.firstTokenTimeoutMs).toBe(5_000);
    expect(normalizePoolTimeouts({ ...normalized, slow: { ...routes.slow, health: { firstTokenTimeoutMs: 180_000 } } }).top.health.firstTokenTimeoutMs).toBe(180_000);
  });
  it('preserves custom and disabled values, other health fields and member spellings', () => {
    const route = { targets: ['p/m#high'], health: { firstTokenTimeoutMs: false, cooldownMs: 12_000 }, levels: [] };
    expect(normalizePoolTimeouts({ pool: route }).pool).toEqual(route);
  });
  it('treats no limit as the longest wait and still lets shortest pick a bounded child', () => {
    const routes = { open: { targets: ['p/a'], health: { firstTokenTimeoutMs: false } },
      quick: { targets: ['p/b'], health: { firstTokenTimeoutMs: 8_000 } },
      top: { targets: ['opencode-route/open', 'opencode-route/quick'] } };
    expect(normalizePoolTimeouts(routes).top).toMatchObject({ health: { firstTokenTimeoutMs: false }, nestedTimeout: 'longest' });
    expect(normalizePoolTimeouts({ ...routes, top: { ...routes.top, nestedTimeout: 'shortest' } }).top.health.firstTokenTimeoutMs).toBe(8_000);
  });
  it('cuts a cycle at the bounded default and stays stable', () => {
    const routes = { a: { targets: ['p/a', 'opencode-route/b'] }, b: { targets: ['p/b', 'opencode-route/a'] } };
    const once = normalizePoolTimeouts(routes);
    expect(once.a.health.firstTokenTimeoutMs).toBe(30_000);
    expect(normalizePoolTimeouts(once)).toEqual(once);
  });
  it('checks idempotence and explicit-value preservation on 2,000 generated chains', () => {
    let state = 31;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
    for (let run = 0; run < 2_000; run++) {
      const limit = (random() % 3_600_000) + 1;
      const routes = { leaf: { targets: ['p/m#high'], health: { firstTokenTimeoutMs: limit, cooldownMs: 1_000 } } };
      let previous = 'leaf';
      for (let index = 0, length = random() % 12; index < length; index++) {
        const id = `pool-${index}`;
        routes[id] = { targets: [`opencode-route/${previous}`], nestedTimeout: random() % 2 ? 'longest' : 'shortest' };
        previous = id;
      }
      const normalized = normalizePoolTimeouts(routes);
      expect(normalizePoolTimeouts(normalized)).toEqual(normalized);
      expect(normalized[previous].health.firstTokenTimeoutMs).toBe(limit);
      expect(normalized.leaf).toEqual(routes.leaf);
    }
  });
});
