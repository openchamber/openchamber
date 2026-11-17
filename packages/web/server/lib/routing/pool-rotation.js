/**
 * Staggered rotation: moves sessions off a pool target one at a time before
 * the target's plan runs dry, so they do not all lose their prompt cache in
 * the same moment when it does.
 *
 * OpenCode keeps each session's pool target in memory and has no route to
 * move one session; route overrides apply to every session at once. The one
 * per-session control OpenChamber has is the session's model, so a move sets
 * the session's model to a sibling target. The session leaves the pool and no
 * longer fails over inside it. Off by default for that reason.
 *
 * Each tick (once a minute while on), per pool:
 * - a source is a target whose linked plan projects to `warn` or `over`;
 * - a destination is another concrete target of the pool that is not linked
 *   to the source's plan, is not itself near its limit, and whose latest
 *   request did not fail; one with a recent success wins over one with no
 *   recent traffic, then the most plan headroom;
 * - only sessions still on the pool count, and the target must have two or
 *   more of them: the last one stays;
 * - one session moves: running subagents (a `parentID` and a request in the
 *   last two minutes) first, then the session whose last request is oldest,
 *   whose cache is the coldest; finished subagents are not moved;
 * - sessions on Auto, and sessions whose model is no longer the pool, stay;
 * - a session whose switch fails is skipped for 30 minutes and the next one
 *   is tried.
 * A pool moves at most one session per `intervalMinutes`. The pace, the
 * failed sessions and the recent moves are kept in memory; a restart forgets
 * them.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { z } from 'zod';

import { querySessionsOnTarget, queryTargetReliability, resolveOpenCodeDbPath } from './model-route-stats.js';
import { readLayeredModelRoutes } from './model-routes.js';
import { computePoolHealth } from './pool-health.js';

const FILE_NAME = 'pool-rotation.json';
const TICK_MS = 60_000;
const MOVE_LOG_LIMIT = 20;
const ROUTE_PROVIDER_ID = 'opencode-route';

export const DEFAULT_ROTATION_SETTINGS = Object.freeze({ enabled: false, intervalMinutes: 5 });

const settingsSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(60),
});

const settingsPatchSchema = settingsSchema.partial().strict();

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** The rotation settings. A missing file is the defaults; a malformed one throws, so a save never replaces it blind. */
export const readRotationSettings = (dataDir) => {
  const file = path.join(dataDir, FILE_NAME);
  if (!fs.existsSync(file)) return { ...DEFAULT_ROTATION_SETTINGS };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw httpError(409, `${file} is not valid JSON. Fix or move it before changing rotation settings.`, 'ROTATION_SETTINGS_MALFORMED');
  }
  // A root that is not an object (null, a list) is malformed, not "the defaults".
  const result = z.record(z.string(), z.unknown()).safeParse(parsed).success
    ? settingsSchema.safeParse({ ...DEFAULT_ROTATION_SETTINGS, ...parsed })
    : { success: false };
  if (!result.success) throw httpError(409, `${file} does not match the rotation settings format.`, 'ROTATION_SETTINGS_MALFORMED');
  return result.data;
};

const writeRotationSettings = (dataDir, settings) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, FILE_NAME);
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return settings;
};

// A pool target is `provider/model[#variant]` or `{ model, defaultVariant }`.
const rawTargetSchema = z.union([
  z.string().transform((model) => ({ model, defaultVariant: undefined, until: undefined })),
  z.object({ model: z.string(), defaultVariant: z.string().optional(), until: z.number().optional() }),
]);

/** `provider/model[#variant]` as a session model, or null for a pattern, a nested pool or a malformed entry. */
const concreteModel = (rawTarget) => {
  const parsed = rawTargetSchema.safeParse(rawTarget);
  if (!parsed.success) return null;
  const [reference, inlineVariant] = parsed.data.model.split('#');
  const slash = reference.indexOf('/');
  if (slash <= 0) return null;
  const providerID = reference.slice(0, slash);
  const id = reference.slice(slash + 1);
  if (providerID === ROUTE_PROVIDER_ID || id === '' || id.includes('*')) return null;
  const model = { providerID, id };
  const variant = inlineVariant ?? parsed.data.defaultVariant;
  if (variant) model.variant = variant;
  return { ref: reference, model, until: parsed.data.until ?? null };
};

const NEAR_LIMIT = new Set(['warn', 'over']);

// A session whose switch failed (deleted directory, OpenCode refusing) is left
// alone this long, so it does not block its pool every minute.
const FAILED_SESSION_BACKOFF_MS = 30 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;

/** Whether the target's latest recorded request in the window failed: it is failing right now. */
const failingNow = (reliability) => reliability !== undefined && reliability.failures > 0
  && (reliability.lastSuccess === null || reliability.lastFailure > reliability.lastSuccess);

/**
 * The best destination for sessions leaving `source`, or null when no target
 * has headroom. A moved session has no failover, so a target whose latest
 * request failed is never chosen, and one with a recent success ranks before
 * one with no recent traffic; then the most plan headroom wins.
 */
const rankDestinations = (poolHealth, rawTargets, source, reliabilityByRef = new Map(), now = Date.now()) => {
  const sourcePlanID = source.plan?.id ?? null;
  const candidates = rawTargets
    .map(concreteModel)
    // A target past its `until` has left the pool in OpenCode; moving a session onto it would bypass that cutoff.
    .filter((candidate) => candidate !== null && candidate.ref !== source.ref && (candidate.until === null || candidate.until > now))
    .map((candidate) => ({
      ...candidate,
      health: poolHealth.targets.find((target) => target.ref === candidate.ref),
      reliability: reliabilityByRef.get(candidate.ref),
    }))
    .filter(({ health, reliability }) => {
      if (!health || failingNow(reliability)) return false;
      if (sourcePlanID !== null && health.plan?.id === sourcePlanID) return false;
      return !NEAR_LIMIT.has(health.plan?.projection?.status ?? 'ok');
    });
  const proven = ({ reliability }) => (reliability?.lastSuccess ? 0 : 1);
  const headroom = ({ health }) => (health.plan?.projection ? health.plan.projection.ratio : Number.POSITIVE_INFINITY);
  return candidates.toSorted((left, right) => proven(left) - proven(right) || headroom(left) - headroom(right));
};

/** The best destination for sessions leaving `source`, or null when no target has headroom. */
export const pickDestination = (...args) => rankDestinations(...args)[0] ?? null;

/** Subagents first, then the session idle longest. */
export const orderForMove = (sessions) =>
  sessions.toSorted((left, right) => {
    if (left.subagent !== right.subagent) return left.subagent ? -1 : 1;
    return left.lastAttempt - right.lastAttempt;
  });

/** Thrown to end a tick when rotation was turned off while it ran. */
class RotationTurnedOff extends Error {}

const withTimeout = (promise, ms, what) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * The rotation job. Every dependency is injected:
 * - `computeHealth()` resolves to the pool health report;
 * - `readRoutes(directory)` returns the `model_routes` map, with a project's
 *   overrides when given its directory;
 * - `sessionsOnTarget({ routeID, ref })` resolves to `[{ sessionID, lastAttempt }]`;
 * - `activeSessionIDs()` resolves to the set of sessions with a running loop (OpenCode's `session.active`);
 * - `targetReliability()` resolves to `[{ providerID, modelID, failures, lastSuccess, lastFailure }]`;
 * - `getSession(sessionID)` resolves to `{ parentID?, model?, location? }` (OpenCode's `Session.Info`);
 * - `switchModel(sessionID, model)` sets the session's model;
 * - `isAutoSession(sessionID)` says whether Auto picks its model per send.
 * OpenCode calls are bounded by `callTimeoutMs`, so a call that never answers
 * cannot stop the job.
 */
export const createPoolRotation = ({
  dataDir,
  computeHealth,
  readRoutes,
  sessionsOnTarget,
  activeSessionIDs = async () => new Set(),
  targetReliability = async () => [],
  getSession,
  switchModel,
  isAutoSession = () => false,
  now = () => Date.now(),
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  log = console,
}) => {
  const lastMoveByPool = new Map();
  const failedUntil = new Map();
  const moves = [];
  let running = false;

  const settings = () => readRotationSettings(dataDir);

  const updateSettings = (patch) => {
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw httpError(400, 'enabled must be true or false and intervalMinutes a whole number from 1 to 60', 'INVALID_ROTATION_SETTINGS');
    return writeRotationSettings(dataDir, { ...settings(), ...parsed.data });
  };

  const readSession = (sessionID) => withTimeout(getSession(sessionID), callTimeoutMs, 'Reading the session').catch(() => null);

  /** Whether the session is still on the pool and not on Auto: the user's own choice since then stands. */
  const stillOnPool = (session, sessionID, poolID) => !isAutoSession(sessionID)
    && session?.model?.providerID === ROUTE_PROVIDER_ID && session.model.id === poolID;

  /**
   * The live sessions on `source` in `poolID`: those still on the pool and not
   * finished subagents. A session on Auto counts here, because it loses its
   * cache in the same bust, but never moves: Auto picks its model again on
   * every send. `movable` leaves out Auto sessions and the ones in back-off
   * after a failed switch, in the order they would move. A subagent
   * counts as running only when OpenCode lists it as active; when that list
   * cannot be read, subagents are not moved at all.
   */
  const sessionsOn = async (poolID, source, tickStart, active) => {
    const onTarget = await sessionsOnTarget({ routeID: poolID, ref: source.ref });
    const live = [];
    for (const { sessionID, lastAttempt } of onTarget) {
      const session = await readSession(sessionID);
      const auto = isAutoSession(sessionID);
      if (!auto && !stillOnPool(session, sessionID, poolID)) continue;
      const subagent = Boolean(session?.parentID);
      // A finished subagent will not send again, so moving it would spend a move on nothing.
      if (subagent && !active?.has(sessionID)) continue;
      live.push({ sessionID, lastAttempt, subagent, auto, directory: session?.location?.directory ?? null });
    }
    const movable = orderForMove(live.filter(({ sessionID, auto }) => !auto && (failedUntil.get(sessionID) ?? 0) <= tickStart));
    return { live, movable };
  };

  /**
   * Whether `destination` belongs to the pool as this session's project
   * defines it: a project can override a pool with the same id.
   */
  /**
   * The model to switch to when `destination` belongs to the pool as this
   * session's project defines it (a project can override a pool with the same
   * id) and has not passed that project's own `until`, or null. The model,
   * variant included, is the project's entry, so the session runs what its
   * own pool lists.
   */
  const destinationModelForSession = (poolID, destination, directory, now) => {
    if (!directory) return destination.model;
    const targets = readRoutes(directory)[poolID]?.targets ?? [];
    const entry = targets.map(concreteModel).find((candidate) => candidate?.ref === destination.ref
      && (candidate.until === null || candidate.until > now));
    return entry?.model ?? null;
  };

  /** Whether a session other than `sessionID` from `live` is still on the pool now (Auto ones count). */
  const anotherStillOn = async (live, sessionID, poolID) => {
    for (const other of live) {
      if (other.sessionID === sessionID) continue;
      if (other.auto) return true;
      if (stillOnPool(await readSession(other.sessionID), other.sessionID, poolID)) return true;
    }
    return false;
  };

  /** Picks and moves at most one session in `poolID`; resolves to the move or null. */
  const rotatePool = async (poolID, poolHealth, rawTargets, reliabilityByRef, tickStart, active) => {
    const sources = poolHealth.targets
      .filter((target) => NEAR_LIMIT.has(target.plan?.projection?.status))
      .toSorted((left, right) => right.plan.projection.ratio - left.plan.projection.ratio);
    for (const source of sources) {
      const destinations = rankDestinations(poolHealth, rawTargets, source, reliabilityByRef, tickStart);
      if (destinations.length === 0) continue;
      const { live, movable } = await sessionsOn(poolID, source, tickStart, active);
      // The last session on a target stays: moving it saves no cache from a shared bust.
      if (live.length < 2) continue;
      for (const chosen of movable) {
        // The best destination this session's own project keeps in the pool.
        let destination = null;
        let model = null;
        for (const candidate of destinations) {
          model = destinationModelForSession(poolID, candidate, chosen.directory, tickStart);
          if (model) { destination = candidate; break; }
        }
        if (!destination) continue;
        // The others may have left meanwhile: move only while another session is still on the target.
        if (!(await anotherStillOn(live, chosen.sessionID, poolID))) continue;
        // Reading the sessions takes time; the user may have picked a model or
        // Auto for this one since, and that choice stands. Read last, right
        // before the switch.
        if (!stillOnPool(await readSession(chosen.sessionID), chosen.sessionID, poolID)) continue;
        // Reads can take seconds each; turning rotation off meanwhile stops the tick before any move.
        if (!settings().enabled) throw new RotationTurnedOff();
        try {
          await withTimeout(switchModel(chosen.sessionID, model), callTimeoutMs, 'Switching the session model');
        } catch (error) {
          failedUntil.set(chosen.sessionID, tickStart + FAILED_SESSION_BACKOFF_MS);
          log.warn?.(`[pool-rotation] ${poolID}: could not move ${chosen.sessionID}: ${error?.message ?? error}`);
          continue;
        }
        const move = { at: tickStart, poolID, sessionID: chosen.sessionID, subagent: chosen.subagent, from: source.ref, to: destination.ref };
        moves.unshift(move);
        moves.length = Math.min(moves.length, MOVE_LOG_LIMIT);
        return move;
      }
    }
    return null;
  };

  /** One pass over every pool. Never throws: a failed pool is logged and the rest still run. */
  const tick = async () => {
    if (running) return [];
    running = true;
    // Moves and the pace are stamped with the tick's start, so a 5-minute pace
    // moves on the fifth tick, not the sixth.
    const tickStart = now();
    try {
      const current = settings();
      if (!current.enabled) return [];
      const health = await computeHealth();
      if (!health.statsAvailable) return [];
      const routes = readRoutes(null);
      // null when the list cannot be read: then no subagent is moved.
      const active = await withTimeout(activeSessionIDs(), callTimeoutMs, 'Reading active sessions').catch(() => null);
      const reliabilityByRef = new Map((await targetReliability()).map((row) => [`${row.providerID}/${row.modelID}`, row]));
      const made = [];
      for (const [poolID, poolHealth] of Object.entries(health.pools)) {
        const last = lastMoveByPool.get(poolID);
        if (last !== undefined && tickStart - last < current.intervalMinutes * 60_000) continue;
        try {
          const move = await rotatePool(poolID, poolHealth, routes[poolID]?.targets ?? [], reliabilityByRef, tickStart, active);
          if (move) {
            lastMoveByPool.set(poolID, move.at);
            made.push(move);
          }
        } catch (error) {
          if (error instanceof RotationTurnedOff) return made;
          log.warn?.(`[pool-rotation] ${poolID}: ${error?.message ?? error}`);
        }
      }
      return made;
    } catch (error) {
      log.warn?.(`[pool-rotation] tick failed: ${error?.message ?? error}`);
      return [];
    } finally {
      running = false;
    }
  };

  let timer = null;
  const start = () => {
    if (timer) return;
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref?.();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { settings, updateSettings, tick, start, stop, recentMoves: () => [...moves] };
};

// `session.active`: running sessions keyed by session id; anything else is a failed read.
const activeSessionsSchema = z.record(z.string(), z.unknown());

/**
 * The OpenCode session calls rotation needs. Session routes resolve the
 * session's own location, so no directory header is sent. `session.get` reads
 * the record only; `session.switchModel` goes through OpenCode's session
 * location middleware, which starts the session's location (its plugins and
 * MCP servers) when it is not running.
 */
const createOpenCodeSessionAccess = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const client = () => OpenCode.make({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: { ...getOpenCodeAuthHeaders() },
  });
  return {
    getSession: (sessionID) => client().session.get({ sessionID }, { signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) }),
    switchModel: (sessionID, model) => client().session.switchModel({ sessionID, model }, { signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) }),
    // `session.active` is global (no location starts) and lists only sessions with a running loop.
    activeSessionIDs: async () => {
      const statuses = activeSessionsSchema.parse(await client().session.active({ signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) }));
      return new Set(Object.keys(statuses));
    },
  };
};

export const registerPoolRotationRoutes = (app, rotation) => {
  app.get('/api/model-routes/rotation', (_req, res) => {
    try {
      res.json({ settings: rotation.settings(), moves: rotation.recentMoves() });
    } catch (error) {
      res.status(error?.status ?? 500).json({ error: error?.message ?? 'Failed to read rotation settings', code: error?.code });
    }
  });

  app.put('/api/model-routes/rotation', express.json({ limit: '4kb' }), (req, res) => {
    try {
      res.json({ settings: rotation.updateSettings(req.body), moves: rotation.recentMoves() });
    } catch (error) {
      res.status(error?.status ?? 500).json({ error: error?.message ?? 'Failed to save rotation settings', code: error?.code });
    }
  });
};

/** Builds the rotation job from the server's dependencies, registers its routes and starts its timer. */
export const registerPoolRotation = (app, { readConfigLayers, readConfigSources, openchamberDataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders, isAutoSession, isOpenCodeLocal = () => true }) => {
  const sessions = createOpenCodeSessionAccess({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const rotation = createPoolRotation({
    dataDir: openchamberDataDir,
    // A remote OpenCode's telemetry is not on this machine; health then reports it unavailable and nothing moves.
    computeHealth: () => computePoolHealth({ readConfigLayers, openchamberDataDir, telemetryLocal: isOpenCodeLocal() }),
    // The same layered read as pool health: a later file's pool replaces an
    // earlier one whole, never a deep merge (with the project's folder files
    // when given a directory).
    readRoutes: (directory) => readLayeredModelRoutes(readConfigSources(directory ?? null)),
    sessionsOnTarget: (target) => querySessionsOnTarget(resolveOpenCodeDbPath(), target),
    targetReliability: () => queryTargetReliability(resolveOpenCodeDbPath()),
    getSession: sessions.getSession,
    activeSessionIDs: sessions.activeSessionIDs,
    switchModel: sessions.switchModel,
    isAutoSession,
  });
  registerPoolRotationRoutes(app, rotation);
  rotation.start();
  return rotation;
};
