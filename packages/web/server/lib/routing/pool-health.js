/**
 * Pool health: for every target in every `experimental.model_routes` pool, how
 * many sessions are on it right now and, when it is linked to a plan
 * (`pool-plan-links.js`), how close that plan looks to its quota window.
 *
 * The point is blast radius: a target with several active sessions busts all
 * of their caches at once if its plan runs out, where a target with one does
 * not touch the others. This view is read-only and advisory — it never moves
 * a session or changes a weight by itself, only computes what a human (or a
 * later automatic step) would need to decide that.
 *
 * The quota projection is an estimate from recent traffic, not an
 * authoritative count: OpenCode and the provider are the only ones who know
 * the plan's actual remaining quota. Read as "at this rate", not as a meter.
 */
import { z } from 'zod';

import { keyNamesTarget, readLayeredModelRoutes, sourcesFromLayers } from './model-routes.js';
import { readPlanStore } from './plans.js';
import { readPoolPlanLinks } from './pool-plan-links.js';
import {
  queryActiveSessionsPerTarget,
  queryAttemptCountsPerTarget,
  resolveOpenCodeDbPath,
} from './model-route-stats.js';

const STATS_ERROR_CODES = new Set(['no-database', 'no-tables', 'no-sqlite']);
const ROUTE_PROVIDER_ID = 'opencode-route';

// A pool target is `provider/model[#variant]` or `{ model, ... }`; the reference drops the variant.
const targetRefSchema = z.union([z.string(), z.object({ model: z.string() }).transform((target) => target.model)]);

/** The target's `provider/model` reference, with any pattern wildcard left as-is, or '' for a malformed entry. */
const targetRef = (target) => (targetRefSchema.safeParse(target).data ?? '').split('#')[0];

const WARN_RATIO = 0.7;

/** The lowest weight the Lower weight button halves a target to (`ModelPoolsSection`). */
const MIN_WEIGHT = 0.1;

// Which recent-usage figure a quota unit is measured in. `tokens` is input,
// output and reasoning together, the figure OpenCode meters plans by
// (`packages/core/src/model-usage.ts`). Cost and percent windows need prices
// or the provider's own meter, so they get no projection.
const USAGE_BY_UNIT = { requests: 'attempts', messages: 'attempts', tokens: 'tokens' };

// Why a quota window gets no projection, by unit: the panel renders this
// reason instead of leaving the window unexplained. There is no pricing or
// provider-meter source in this codebase today, so no window resolves to a
// projection through these units; inventing one is a separate feature.
const NO_PROJECTION_REASON_BY_UNIT = { usd: 'needs-pricing', percent: 'needs-provider-meter', other: 'unsupported-unit' };

const projectionFor = (quota, usage, hours) => {
  const measure = USAGE_BY_UNIT[quota?.unit];
  if (!measure || !(quota.limit > 0) || !(quota.windowHours > 0)) return null;
  const projected = (usage[measure] / hours) * quota.windowHours;
  const ratio = projected / quota.limit;
  return {
    quotaName: quota.name,
    unit: quota.unit,
    limit: quota.limit,
    windowHours: quota.windowHours,
    projected: Math.round(projected * 10) / 10,
    source: 'traffic-estimate',
    ratio,
    status: ratio >= 1 ? 'over' : ratio >= WARN_RATIO ? 'warn' : 'ok',
  };
};

/** The plan's quota windows that traffic cannot project, each with the reason the panel shows. */
const unprojectedQuotas = (quotas) => quotas
  .filter((quota) => NO_PROJECTION_REASON_BY_UNIT[quota?.unit] && quota.limit > 0 && quota.windowHours > 0)
  .map((quota) => ({ quotaName: quota.name, unit: quota.unit, reason: NO_PROJECTION_REASON_BY_UNIT[quota.unit] }));

/** The plan's tightest window: the projection closest to (or furthest past) its limit. */
const tightestProjection = (quotas, usage, hours) =>
  quotas
    .map((quota) => projectionFor(quota, usage, hours))
    .filter(Boolean)
    .reduce((worst, next) => (worst === null || next.ratio > worst.ratio ? next : worst), null);

const positiveOr = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

export const computePoolHealth = async ({
  readConfigLayers,
  openchamberDataDir,
  resolveDbPath = resolveOpenCodeDbPath,
  loadPlanStore = readPlanStore,
  loadPoolPlanLinks = readPoolPlanLinks,
  telemetryLocal = true,
  hours: requestedHours,
  activeMinutes: requestedActiveMinutes,
  now = Date.now(),
} = {}) => {
  // The same bounds the attempt query samples with, so the rate divides by the hours it read.
  const hours = Math.min(336, Math.max(0.1, positiveOr(requestedHours, 24)));
  const activeMinutes = Math.min(1440, positiveOr(requestedActiveMinutes, 15));
  const layers = readConfigLayers(null);
  // Layered, not the deep-merged config: the merged config keeps a lower
  // file's nested routes beside a higher file's flat ones, and folding the
  // merged shapes would let the lower file's pool win. Folding each file
  // first (readLayeredModelRoutes) keeps the higher file's pool, as the
  // runtime's own pool reader does.
  const routes = readLayeredModelRoutes(sourcesFromLayers(layers));
  // A damaged plans.json or links file costs the plan columns only: the
  // session counts come from OpenCode's database and still show.
  let plans = [];
  let planError = null;
  try {
    plans = loadPlanStore().plans;
  } catch (error) {
    planError = error?.message ?? String(error);
  }
  let links = {};
  let linksError = null;
  try {
    links = loadPoolPlanLinks(openchamberDataDir).links;
  } catch (error) {
    linksError = error?.message ?? String(error);
  }
  const planByID = new Map(plans.map((plan) => [plan.id, plan]));

  // Each query settles on its own: a failed one costs only its own columns.
  let sessionRows = null;
  let usageRows = null;
  let statsReason;
  if (!telemetryLocal) {
    statsReason = 'remote-opencode';
  } else {
    const dbPath = resolveDbPath();
    const [active, usage] = await Promise.allSettled([
      queryActiveSessionsPerTarget(dbPath, { minutes: activeMinutes, now }),
      queryAttemptCountsPerTarget(dbPath, { hours, now }),
    ]);
    if (active.status === 'fulfilled') sessionRows = active.value.sessions;
    if (usage.status === 'fulfilled') usageRows = usage.value.targets;
    const failure = [active, usage].find((result) => result.status === 'rejected');
    if (failure) statsReason = STATS_ERROR_CODES.has(failure.reason?.code) ? failure.reason.code : 'unknown';
  }
  const sessionsAvailable = sessionRows !== null;
  const usageAvailable = usageRows !== null;
  const statsAvailable = sessionsAvailable && usageAvailable;

  // A target may be a pattern (`openai/*`); OpenCode records the concrete
  // model it called, so a target covers every row its pattern names.
  const covers = (ref, row) => ref !== '' && keyNamesTarget(`${row.providerID}/${row.modelID}`, ref);
  const activeSessionsOf = (ref) => new Set(sessionRows.filter((row) => covers(ref, row)).map((row) => row.sessionID)).size;

  // A telemetry row belongs to the most specific link that covers it: an exact
  // reference beats a pattern, a longer pattern a shorter one. So a row counts
  // once, toward one plan, even when `openai/*` and `openai/gpt-x` are linked
  // to the same plan or to different ones.
  const specificity = (ref) => (ref.includes('*') ? ref.replace(/\*/g, '').length : Number.MAX_SAFE_INTEGER);
  const owningPlan = (row) => {
    let best = null;
    for (const [ref, planID] of Object.entries(links)) {
      if (!covers(ref, row)) continue;
      if (best === null || specificity(ref) > specificity(best.ref)) best = { ref, planID };
    }
    return best?.planID ?? null;
  };
  // Targets sharing one plan id pool their recent usage, so a quota ratio
  // reflects the plan's combined traffic, not one target's slice of it.
  const usageForPlan = (planID) => usageRows
    .filter((row) => owningPlan(row) === planID)
    .reduce((total, row) => ({ attempts: total.attempts + row.attempts, tokens: total.tokens + row.tokens }), { attempts: 0, tokens: 0 });

  const pools = {};
  for (const [poolID, route] of Object.entries(routes)) {
    const selection = route.selection ?? 'ordered';
    // A nested pool (`opencode-route/<id>`) is listed as its own pool with its
    // real targets; as a target here it matches no telemetry row.
    const refs = (route.targets ?? []).map(targetRef).filter((ref) => ref !== '' && !ref.startsWith(`${ROUTE_PROVIDER_ID}/`));
    const targets = refs.map((ref) => {
      const activeSessions = sessionsAvailable ? activeSessionsOf(ref) : null;
      const planID = links[ref];
      const plan = planID ? planByID.get(planID) : undefined;
      const projection = usageAvailable && plan ? tightestProjection(plan.quotas, usageForPlan(planID), hours) : null;
      const planInfo = plan
        ? {
            id: plan.id,
            label: plan.label,
            providerID: plan.providerID,
            siblingRefs: Object.entries(links).filter(([, id]) => id === planID).map(([key]) => key).filter((key) => key !== ref),
            projection,
            unprojectedQuotas: unprojectedQuotas(plan.quotas),
          }
        : null;
      // A link to a plan that is gone (or unreadable) is reported so it can be cleared.
      const missingPlanID = planID && !plan && planError === null ? planID : null;
      const blastRadius = activeSessions !== null && activeSessions >= 2;
      // Both selections draw by weight (OpenCode's round-robin is smooth weighted round
      // robin). A weight already at the floor the button halves to has nothing left to give.
      const weight = route.weights?.[ref] ?? 1;
      // Shifting weight only helps when traffic can go to a target on another quota.
      const elsewhere = refs.some((other) => other !== ref && links[other] !== planID);
      // A pattern target (`openai/*`) can never carry a weight: OpenCode expands
      // it to concrete leaves and reads each leaf's weight by its concrete key,
      // so a saved `weights['openai/*']` would match nothing (and pool
      // validation refuses pattern keys). Never suggest lowering it.
      const suggestion = projection && ['weighted', 'round-robin'].includes(selection) && elsewhere
        && projection.status !== 'ok' && weight > MIN_WEIGHT && !ref.includes('*')
        ? 'lower-weight'
        : null;
      return { ref, activeSessions, plan: planInfo, missingPlanID, blastRadius, suggestion };
    });
    pools[poolID] = { selection, targets };
  }

  return { available: true, statsAvailable, sessionsAvailable, usageAvailable, statsReason, planError, linksError, generatedAt: now, pools };
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Whether OpenCode runs on this machine, so its database here is the one it
 * writes. An OpenCode on another host (`OPENCODE_HOST`) keeps its telemetry
 * there; a local file could be a stale one from another install.
 */
export const isLocalOpenCode = (buildOpenCodeUrl) => {
  try {
    return LOOPBACK_HOSTS.has(new URL(buildOpenCodeUrl('/', '')).hostname);
  } catch {
    return false;
  }
};

// A pool-health window is judged by its spelling as written, like every
// other numeric query parameter in this server (#463-#592): only a canonical
// decimal is honoured. Exponent (1e3), radix-prefixed (0x10, 0b101), signed
// (+2), whitespace-padded (' 2 '), leading-zero (01), trailing-junk (2junk)
// and non-canonical fraction (2.0, 2.50) spellings fall back to the defaults
// in computePoolHealth instead of being reinterpreted by a loose Number(...).
// A canonical fraction (1.5, 0.5) stays valid: the compute layer supports
// sub-hour windows down to 0.1h.
const CANONICAL_DECIMAL_QUERY = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

const parseCanonicalDecimalQuery = (value) => {
  if (Object.prototype.toString.call(value) !== '[object String]' || !CANONICAL_DECIMAL_QUERY.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export const registerPoolHealthRoutes = (app, dependencies) => {
  const { readConfigLayers, openchamberDataDir, isOpenCodeLocal = () => true } = dependencies;

  app.get('/api/model-routes/health', async (req, res) => {
    try {
      res.json(
        await computePoolHealth({
          readConfigLayers,
          openchamberDataDir,
          telemetryLocal: isOpenCodeLocal(),
          hours: parseCanonicalDecimalQuery(req.query?.hours),
          activeMinutes: parseCanonicalDecimalQuery(req.query?.activeMinutes),
        }),
      );
    } catch (error) {
      res.status(error?.status ?? 500).json({ error: error?.message ?? 'Failed to compute pool health' });
    }
  });
};
