/**
 * Per-assistant-message model attribution, read from OpenCode's own
 * `route_attempt` and `route_decision` tables: which pool (if any) answered a
 * message, which selection picked that target, and whether it got there only
 * after an earlier attempt in the same message failed over.
 *
 * Every request OpenCode runs writes a `route_attempt` row, routed or not
 * (`route_id` is `""` for a direct model), so this works for pool and
 * non-pool models alike. Nothing here invents data: a message with no attempt
 * rows (an OpenCode build without the routing tables, or history older than
 * the table) simply has no entry in `messages`.
 */
import { openRouteDb, resolveOpenCodeDbPath } from './model-route-stats.js';

const FAILOVER_OUTCOMES = new Set(['failure', 'timeout']);

const sameTarget = (a, b) => a.provider_id === b.provider_id && a.model_id === b.model_id && (a.variant ?? null) === (b.variant ?? null);

/** Groups ascending-time attempt rows by assistant message id, dropping rows without one. */
const groupAttemptsByMessage = (rows) => {
  const byMessage = new Map();
  for (const row of rows) {
    if (!row.assistant_message_id) continue;
    const group = byMessage.get(row.assistant_message_id);
    if (group) group.push(row);
    else byMessage.set(row.assistant_message_id, [row]);
  }
  return byMessage;
};

/** Ascending-time decision rows, grouped by route id, for the nearest-preceding lookup below. */
const groupDecisionsByRoute = (rows) => {
  const byRoute = new Map();
  for (const row of rows) {
    const group = byRoute.get(row.route_id);
    if (group) group.push(row);
    else byRoute.set(row.route_id, [row]);
  }
  return byRoute;
};

/** The latest decision at or before `time` for `routeID`, or null. Rows are ascending, so this is the last match. */
const decisionBefore = (decisionsByRoute, routeID, time) => {
  const candidates = decisionsByRoute.get(routeID);
  if (!candidates) return null;
  let found = null;
  for (const decision of candidates) {
    if (decision.time > time) break;
    found = decision;
  }
  return found;
};

const attributeMessage = (rows, decisionsByRoute) => {
  const successIndex = rows.map((row) => row.outcome).lastIndexOf('success');
  const current = successIndex >= 0 ? rows[successIndex] : rows[rows.length - 1];
  const boundary = successIndex >= 0 ? successIndex : rows.length - 1;
  const priorFailure = rows
    .slice(0, boundary)
    .filter((row) => FAILOVER_OUTCOMES.has(row.outcome) && !sameTarget(row, current))
    .at(-1);
  const routeID = current.route_id || null;
  const decision = routeID ? decisionBefore(decisionsByRoute, routeID, current.time_started) : null;
  return {
    providerID: current.provider_id,
    modelID: current.model_id,
    variant: current.variant ?? null,
    routeID,
    selection: decision ? { mode: decision.selection, reason: decision.reason } : null,
    failover: priorFailure
      ? {
          providerID: priorFailure.provider_id,
          modelID: priorFailure.model_id,
          variant: priorFailure.variant ?? null,
          errorTag: priorFailure.error_tag ?? null,
          errorMessage: priorFailure.error_message ?? null,
        }
      : null,
  };
};

/**
 * Attributes every assistant message in `sessionID` that has at least one
 * recorded attempt. Throws the same typed errors as `openRouteDb`
 * (`no-database`, `no-tables`, `no-sqlite`) for a missing or stock database.
 */
export const queryMessageModelAttribution = async (dbPath, { sessionID } = {}) => {
  if (!sessionID) throw Object.assign(new Error('sessionID is required'), { code: 'invalid-session', status: 400 });
  const db = await openRouteDb(dbPath);
  try {
    const attempts = db
      .prepare(
        `select time_started, assistant_message_id, route_id, provider_id, model_id, variant,
          outcome, error_tag, error_message
        from route_attempt
        where session_id = ? and assistant_message_id is not null
        order by time_started asc`,
      )
      .all(sessionID);
    const decisions = db
      .prepare(
        `select time, route_id, selection, reason
        from route_decision
        where session_id = ?
        order by time asc`,
      )
      .all(sessionID);
    const decisionsByRoute = groupDecisionsByRoute(decisions);
    const messages = {};
    for (const [assistantMessageID, rows] of groupAttemptsByMessage(attempts)) {
      messages[assistantMessageID] = attributeMessage(rows, decisionsByRoute);
    }
    return { available: true, messages };
  } finally {
    db.close();
  }
};

export const registerMessageModelAttributionRoutes = (app, dependencies = {}) => {
  const { resolveDbPath = resolveOpenCodeDbPath, isOpenCodeLocal = () => true } = dependencies;

  app.get('/api/model-routes/turns', async (req, res) => {
    const sessionID = req.query?.sessionID;
    if (!sessionID) return res.status(400).json({ error: 'sessionID is required' });
    // A remote OpenCode keeps its telemetry in its own database; a local file
    // here could be a stale one from another install, so read nothing.
    if (!isOpenCodeLocal()) return res.json({ available: false, reason: 'remote-opencode' });
    try {
      res.json(await queryMessageModelAttribution(resolveDbPath(), { sessionID }));
    } catch (error) {
      if (error?.code === 'no-database' || error?.code === 'no-tables' || error?.code === 'no-sqlite') {
        return res.json({ available: false, reason: error.code });
      }
      res.status(500).json({ error: error?.message ?? 'Failed to read routing telemetry' });
    }
  });
};
