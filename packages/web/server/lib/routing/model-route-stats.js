/**
 * Read-only telemetry for OpenCode model pools, straight from OpenCode's own
 * `route_attempt` table. No prompts or responses are stored there (only exact
 * error tags, codes, statuses, truncated messages, timings and token counts),
 * so reading it needs no enterprise gate — though bodies are only present when
 * a request opted in, and messages are truncated at the source.
 *
 * Anything missing (no database file, a stock OpenCode without the routing
 * tables) reads as `{ available: false }`, never as an empty report.
 */
import fs from 'node:fs';
import path from 'node:path';

import { keyNamesTarget } from './model-routes.js';
import { resolveOpenCodeDataDir } from './route-overrides-store.js';

// The driver is imported lazily: a static import of `node:sqlite` would keep
// the whole server from booting on a runtime that lacks it, and only this
// endpoint needs SQLite. Node and bun >= 1.2 expose `node:sqlite`; older bun
// releases only have `bun:sqlite`, so that is the fallback.
const loadSqlite = async () => {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return (dbPath) => new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // fall through to bun:sqlite
  }
  try {
    const { Database } = await import('bun:sqlite');
    return (dbPath) => new Database(dbPath, { readonly: true });
  } catch {
    throw Object.assign(new Error('Routing telemetry needs a runtime with node:sqlite or bun:sqlite'), {
      code: 'no-sqlite',
      status: 503,
    });
  }
};

/**
 * Where OpenCode keeps its database: `OPENCODE_DB` when set, else `opencode.db`,
 * both in OpenCode's data directory, which follows `XDG_DATA_HOME` as OpenCode does.
 */
export const resolveOpenCodeDbPath = (env = process.env) => {
  const dataDir = resolveOpenCodeDataDir(env);
  const configured = (env.OPENCODE_DB ?? '').trim();
  if (configured && configured !== ':memory:') return path.resolve(dataDir, configured);
  return path.join(dataDir, 'opencode.db');
};

const hasRouteTables = (db) => {
  const rows = db
    .prepare("select name from sqlite_master where type = 'table' and name in ('route_attempt', 'route_decision')")
    .all();
  return rows.some((row) => row.name === 'route_attempt');
};

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Aggregates over the last `hours` of attempts: per-target counts and
 * latencies, failures grouped by exact error, and hedge win rates from the
 * pairs of `hedged` rows that share an assistant message. Throws with
 * `status`/`code` for missing database (`no-database`) or stock OpenCode
 * without the routing tables (`no-tables`).
 */
/** A read-only handle on OpenCode's database with the routing tables; the caller closes it. */
export const openRouteDb = async (dbPath) => {
  if (!fs.existsSync(dbPath)) {
    throw Object.assign(new Error(`OpenCode database not found at ${dbPath}`), { code: 'no-database', status: 404 });
  }
  const openDatabase = await loadSqlite();
  const db = openDatabase(dbPath);
  if (!hasRouteTables(db)) {
    db.close();
    throw Object.assign(new Error('This OpenCode build does not record routing telemetry'), {
      code: 'no-tables',
      status: 404,
    });
  }
  return db;
};

export const queryRouteStats = async (dbPath, { hours = 24, now = Date.now() } = {}) => {
  const windowHours = Math.min(336, Math.max(0.1, Number(hours) || 24));
  if (!fs.existsSync(dbPath)) {
    throw Object.assign(new Error(`OpenCode database not found at ${dbPath}`), { code: 'no-database', status: 404 });
  }
  const openDatabase = await loadSqlite();
  const db = openDatabase(dbPath);
  try {
    if (!hasRouteTables(db)) {
      throw Object.assign(new Error('This OpenCode build does not record routing telemetry'), {
        code: 'no-tables',
        status: 404,
      });
    }
    const since = now - windowHours * 3_600_000;
    const targets = db
      .prepare(
        `select provider_id as providerID, model_id as modelID,
          count(*) as attempts,
          sum(case when outcome in ('failure','timeout') then 1 else 0 end) as failures,
          sum(case when outcome = 'timeout' then 1 else 0 end) as timeouts,
          avg(first_token_ms) as avgFirstTokenMs,
          avg(tokens_per_second) as avgTokensPerSecond,
          max(time_started) as lastAttempt
        from route_attempt where time_started >= ? group by provider_id, model_id order by attempts desc`,
      )
      .all(since);
    const errors = db
      .prepare(
        `select provider_id as providerID, model_id as modelID,
          error_tag as tag, error_code as code, error_status as status,
          count(*) as count, max(time_started) as lastTime,
          (select e.error_message from route_attempt e
            where e.provider_id = route_attempt.provider_id and e.model_id = route_attempt.model_id
              and e.error_tag is route_attempt.error_tag
              and e.error_code is route_attempt.error_code
              and e.error_status is route_attempt.error_status
            order by e.time_started desc limit 1) as lastMessage
        from route_attempt
        where time_started >= ? and outcome != 'success'
        group by provider_id, model_id, error_tag, error_code, error_status
        order by count desc limit 50`,
      )
      .all(since);
    const hedges = db
      .prepare(
        `select provider_id as providerID, model_id as modelID,
          count(*) as hedges,
          sum(case when outcome = 'success' then 1 else 0 end) as wins
        from route_attempt
        where time_started >= ? and hedged is true and assistant_message_id is not null
          and exists (select 1 from route_attempt rival
            where rival.assistant_message_id = route_attempt.assistant_message_id
              and rival.hedged is true
              and (rival.provider_id != route_attempt.provider_id or rival.model_id != route_attempt.model_id))
        group by provider_id, model_id`,
      )
      .all(since);
    return {
      available: true,
      windowHours,
      targets: targets.map((row) => ({
        ...row,
        avgFirstTokenMs: num(row.avgFirstTokenMs) === null ? null : Math.round(num(row.avgFirstTokenMs)),
        avgTokensPerSecond: num(row.avgTokensPerSecond),
      })),
      errors: errors.map((row) => ({
        ...row,
        lastMessage: typeof row.lastMessage === 'string' ? row.lastMessage.slice(0, 300) : null,
      })),
      hedges,
    };
  } finally {
    db.close();
  }
};

/**
 * Each session with an attempt in the last `minutes`, on the target of its
 * latest attempt: a session that failed over or was moved since counts on
 * where it is now. Counting is left to the caller, because a pattern target
 * (`openai/*`) covers several concrete models.
 */
export const queryActiveSessionsPerTarget = async (dbPath, { minutes = 15, now = Date.now() } = {}) => {
  const db = await openRouteDb(dbPath);
  try {
    const since = now - Math.max(1, Number(minutes) || 15) * 60_000;
    // SQLite returns the other columns from the row that holds max(time_started).
    const sessions = db
      .prepare(
        `select provider_id as providerID, model_id as modelID, session_id as sessionID, max(time_started) as lastAttempt
        from route_attempt
        where time_started >= ? and session_id is not null
        group by session_id`,
      )
      .all(since)
      .map(({ providerID, modelID, sessionID }) => ({ providerID, modelID, sessionID }));
    return { available: true, minutes, sessions };
  } finally {
    db.close();
  }
};

/** Attempts and tokens per target over `hours`, for a simple recent-burn-rate estimate. */
export const queryAttemptCountsPerTarget = async (dbPath, { hours = 24, now = Date.now() } = {}) => {
  const db = await openRouteDb(dbPath);
  try {
    const since = now - Math.max(0.1, Number(hours) || 24) * 3_600_000;
    const rows = db
      .prepare(
        `select provider_id as providerID, model_id as modelID, count(*) as attempts,
          coalesce(sum(coalesce(tokens_input, 0) + coalesce(tokens_output, 0) + coalesce(tokens_reasoning, 0)), 0) as tokens
        from route_attempt where time_started >= ? group by provider_id, model_id`,
      )
      .all(since);
    return { available: true, hours, targets: rows };
  } finally {
    db.close();
  }
};

/**
 * Per target over the last `minutes`: attempts, failures, and when it last
 * succeeded and last failed. Rotation uses it to keep sessions off a target
 * that is failing right now.
 */
export const queryTargetReliability = async (dbPath, { minutes = 15, now = Date.now() } = {}) => {
  const db = await openRouteDb(dbPath);
  try {
    const since = now - Math.max(1, Number(minutes) || 15) * 60_000;
    return db
      .prepare(
        `select provider_id as providerID, model_id as modelID, count(*) as attempts,
          sum(case when outcome in ('failure','timeout') then 1 else 0 end) as failures,
          max(case when outcome = 'success' then time_started end) as lastSuccess,
          max(case when outcome in ('failure','timeout') then time_started end) as lastFailure
        from route_attempt where time_started >= ? group by provider_id, model_id`,
      )
      .all(since);
  } finally {
    db.close();
  }
};

/**
 * The sessions whose latest attempt in `routeID` within the last `minutes`
 * went to `providerID/modelID`, with that attempt's time. A session that has
 * since moved to another target of the route is left out.
 */
export const querySessionsOnTarget = async (dbPath, { routeID, ref, minutes = 15, now = Date.now() }) => {
  const db = await openRouteDb(dbPath);
  try {
    const since = now - Math.max(1, Number(minutes) || 15) * 60_000;
    const rows = db
      .prepare(
        `select session_id as sessionID, provider_id as providerID, model_id as modelID, time_started as time
        from route_attempt
        where route_id = ? and time_started >= ? and session_id is not null
        order by time_started desc`,
      )
      .all(routeID, since);
    const latest = new Map();
    for (const row of rows) if (!latest.has(row.sessionID)) latest.set(row.sessionID, row);
    return [...latest.values()]
      // A pattern target (`openai/*`) covers every concrete model OpenCode recorded under it.
      .filter((row) => keyNamesTarget(`${row.providerID}/${row.modelID}`, ref))
      .map((row) => ({ sessionID: row.sessionID, lastAttempt: row.time }));
  } finally {
    db.close();
  }
};

// A stats window is judged by its spelling as written, like every other
// numeric query parameter in this server (#463-#592, #604): only a canonical
// decimal is honoured. Exponent (1e3), radix-prefixed (0x10, 0b101), signed
// (+2, -5), whitespace-padded (' 2 '), leading-zero (01) and non-canonical
// fraction (2.0, 2.50) spellings fall back to queryRouteStats' 24h default
// instead of being reinterpreted by its loose Number(...). A canonical
// fraction (1.5, 0.5) stays valid: the query layer supports sub-hour
// windows down to 0.1h. Same shape as pool-health.js's parser; the two
// modules import from each other, so the helper is not shared across them.
const CANONICAL_DECIMAL_QUERY = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

const parseCanonicalDecimalQuery = (value) => {
  if (Object.prototype.toString.call(value) !== '[object String]' || !CANONICAL_DECIMAL_QUERY.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export const registerModelRouteStatsRoutes = (app, dependencies = {}) => {
  const { resolveDbPath = resolveOpenCodeDbPath, isOpenCodeLocal = () => true } = dependencies;

  app.get('/api/model-routes/stats', async (req, res) => {
    // A remote OpenCode keeps its telemetry in its own database; a local file
    // here could be a stale one from another install, so read nothing.
    if (!isOpenCodeLocal()) return res.json({ available: false, reason: 'remote-opencode' });
    try {
      res.json(await queryRouteStats(resolveDbPath(), { hours: parseCanonicalDecimalQuery(req.query?.hours) }));
    } catch (error) {
      if (error?.code === 'no-database' || error?.code === 'no-tables' || error?.code === 'no-sqlite') {
        return res.json({ available: false, reason: error.code });
      }
      res.status(500).json({ error: error?.message ?? 'Failed to read routing telemetry' });
    }
  });
};
