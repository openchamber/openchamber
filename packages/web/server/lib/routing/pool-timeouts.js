import { expressionTerms, parseMatchExpression } from './route-match.js';

// The user-approved default for pools edited in OpenChamber. OpenCode's built-in
// default is 10 seconds; writing the value explicitly also works on older builds.
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 30_000;
// What OpenCode waits when a pool names no first-output timeout of its own.
const OPENCODE_FIRST_OUTPUT_TIMEOUT_MS = 10_000;
const ROUTE_PREFIX = 'opencode-route/';

/** References that contribute members; excluded pools do not contribute waits. */
const nestedPoolIds = (routes, id) => {
  const route = routes[id];
  if (!route) return [];
  const names = (route.targets ?? []).flatMap((target) => {
    // Validated targets: a `provider/model` string, or an object whose model is one.
    const model = target.model ?? target;
    return model.toLowerCase().startsWith(ROUTE_PREFIX) ? [model.split('#')[0].slice(ROUTE_PREFIX.length)] : [];
  });
  names.push(...(route.include ?? []));
  if (route.match !== undefined) {
    const parsed = parseMatchExpression(route.match);
    if (parsed.expression) names.push(...expressionTerms(parsed.expression).filter((term) => !term.negated).map((term) => term.text));
  }
  const ids = Object.keys(routes);
  return [...new Set(names.map((name) => {
    const raw = name.toLowerCase().startsWith(ROUTE_PREFIX) ? name.slice(ROUTE_PREFIX.length) : name;
    return Object.hasOwn(routes, raw) ? raw : ids.find((candidate) => candidate.toLowerCase() === raw.toLowerCase());
  }).filter((candidate) => candidate !== undefined && candidate !== id))];
};

/**
 * The wait a pool applies to the models it does not hand to a nested pool: its
 * own value, kept under `own`; for a pool that nests pools, the longest of their
 * waits (also when the pool names none) or the shortest; else 30 seconds. The
 * same rules as OpenCode's `firstTokenTimeout` (config/plugin/model-routes.ts),
 * which applies them itself from developing-today-forks/opencode#2674 on.
 * A pool met again on its own way in contributes the default.
 */
export const resolvePoolTimeout = (routes, id, mode, trail = new Set()) => {
  if (trail.has(id)) return DEFAULT_FIRST_OUTPUT_TIMEOUT_MS;
  const route = routes[id];
  if (!route) return DEFAULT_FIRST_OUTPUT_TIMEOUT_MS;
  const own = route.health?.firstTokenTimeoutMs;
  const policy = mode ?? route.nestedTimeout;
  if (policy === 'own') return own ?? DEFAULT_FIRST_OUTPUT_TIMEOUT_MS;
  if (own !== undefined && policy === undefined) return own;
  const nested = nestedPoolIds(routes, id);
  if (nested.length === 0) return own ?? DEFAULT_FIRST_OUTPUT_TIMEOUT_MS;
  const nextTrail = new Set([...trail, id]);
  const values = nested.flatMap((child) => waitsOf(routes, child, nextTrail));
  const rank = (value) => value === false ? Number.POSITIVE_INFINITY : value;
  return values.reduce((best, value) => ((policy ?? 'longest') === 'shortest'
    ? rank(value) < rank(best)
    : rank(value) > rank(best)) ? value : best);
};

/** Every wait a pool applies to the models it reaches: one, or under `own` its own and each nested pool's. */
const waitsOf = (routes, id, trail) => {
  const wait = resolvePoolTimeout(routes, id, undefined, trail);
  if (routes[id]?.nestedTimeout !== 'own' || trail.has(id)) return [wait];
  const next = new Set([...trail, id]);
  return [wait, ...nestedPoolIds(routes, id).flatMap((child) => waitsOf(routes, child, next))];
};

/** Keep the policy after materializing its value so a later child edit updates the parent. */
export const normalizePoolTimeouts = (routes) => Object.fromEntries(Object.entries(routes).map(([id, route]) => {
  const next = { ...route, health: { ...route.health, firstTokenTimeoutMs: resolvePoolTimeout(routes, id) } };
  if (nestedPoolIds(routes, id).length === 0) delete next.nestedTimeout;
  else if (route.health?.firstTokenTimeoutMs === undefined) next.nestedTimeout = route.nestedTimeout ?? 'longest';
  return [id, next];
}));

/** The wait OpenCode applies now, and what longest or shortest would pick, for each pool. */
export const poolTimeoutSummaries = (routes) => Object.fromEntries(Object.entries(routes).map(([id, route]) => [id, {
  applied: route.health?.firstTokenTimeoutMs ?? OPENCODE_FIRST_OUTPUT_TIMEOUT_MS,
  longest: resolvePoolTimeout(routes, id, 'longest'),
  shortest: resolvePoolTimeout(routes, id, 'shortest'),
  nested: nestedPoolIds(routes, id),
}]));
