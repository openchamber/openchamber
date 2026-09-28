/**
 * OpenCode v2 wire events -> the vocabulary the server's own consumers speak.
 *
 * The browser gets raw wire payloads (the UI translates them itself in
 * `packages/ui/src/lib/opencode/events.ts`). Everything that reacts on the
 * server — notifications, the message queue, session activity, goal mode,
 * permission auto-accept, Linear status — was written against OpenCode v1
 * event names, so this module is the single place that maps v2 onto them.
 * Keeping one translator means a consumer never has to know which OpenCode
 * shape produced its event.
 *
 * Two differences from v1 are load-bearing and cannot be papered over:
 *
 * - v2 emits no `session.status` and no `session.idle` of its own. Live status
 *   comes from `session.execution.started|succeeded|interrupted|failed`, so
 *   those are what synthesize the status vocabulary here.
 * - a v2 turn is a sequence of steps. Each `session.step.ended` becomes an
 *   assistant `message.updated`; only the last one carries `finish: "stop"`,
 *   which is the same signal v1 gave once per turn.
 */

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

const compact = (value) => {
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
};

/** Directory an event belongs to. Execution events carry no location. */
export const wireEventDirectory = (payload) => {
  if (!isRecord(payload)) return '';
  return trimmed(payload.location?.directory);
};

/** Structured errors travel as `{ type, message }`; consumers still read `name`. */
const toServerError = (error) => {
  if (!isRecord(error)) return { name: 'Error', type: 'Error', message: typeof error === 'string' ? error : '' };
  const type = trimmed(error.type) || 'Error';
  return compact({ name: type, type, message: trimmed(error.message), status: error.status });
};

const ABORTED_ERROR = {
  name: 'MessageAbortedError',
  type: 'MessageAbortedError',
  message: 'The running turn was interrupted.',
};

/**
 * Translates one v2 wire payload into zero or more server-vocabulary events.
 *
 * Every returned event carries the source event id and the directory, because
 * consumers deduplicate on the id and route their own OpenCode calls by
 * directory.
 */
export function translateWireEvent(payload) {
  if (!isRecord(payload)) return [];
  const type = trimmed(payload.type);
  if (!type) return [];
  const data = isRecord(payload.data) ? payload.data : {};
  const directory = wireEventDirectory(payload);
  const created = Number.isFinite(payload.created) ? payload.created : Date.now();

  const event = (outType, properties) => ({
    type: outType,
    id: typeof payload.id === 'string' ? payload.id : '',
    created,
    properties: compact({ ...properties, directory: directory || undefined }),
  });

  const sessionID = trimmed(data.sessionID);

  const status = (statusValue) => event('session.status', { sessionID, status: statusValue });

  switch (type) {
    case 'server.connected':
      return [event('server.connected', {})];

    case 'installation.update-available':
      return [event('installation.update-available', { version: trimmed(data.version) })];

    // --- session lifecycle --------------------------------------------------

    case 'session.created': {
      if (!sessionID) return [];
      const location = isRecord(data.location) ? data.location : {};
      return [event('session.created', {
        sessionID,
        info: compact({
          id: sessionID,
          parentID: trimmed(data.parentID) || undefined,
          projectID: trimmed(data.projectID) || undefined,
          directory: trimmed(location.directory) || directory || undefined,
          title: typeof data.title === 'string' ? data.title : undefined,
          agent: trimmed(data.agent) || undefined,
          model: data.model,
          metadata: data.metadata,
          permissions: data.permissions,
          time: { created, updated: created },
        }),
      })];
    }

    case 'session.renamed':
      if (!sessionID) return [];
      return [event('session.updated', {
        sessionID,
        info: compact({ id: sessionID, title: typeof data.title === 'string' ? data.title : undefined, directory: directory || undefined, time: { updated: created } }),
      })];

    case 'session.moved': {
      if (!sessionID) return [];
      const location = isRecord(data.location) ? data.location : {};
      return [event('session.updated', {
        sessionID,
        info: compact({ id: sessionID, directory: trimmed(location.directory) || undefined, projectID: trimmed(data.projectID) || undefined, time: { updated: created } }),
      })];
    }

    case 'session.usage.updated':
      if (!sessionID) return [];
      return [event('session.updated', {
        sessionID,
        info: compact({ id: sessionID, directory: directory || undefined, cost: data.cost, tokens: data.tokens, time: { updated: created } }),
      })];

    case 'session.deleted':
      if (!sessionID) return [];
      return [event('session.deleted', { sessionID, info: { id: sessionID } })];

    // --- live status --------------------------------------------------------

    // v2 still declares `session.status` and `session.idle`; a 2.0.2 server was
    // observed never to emit them, so the execution events below are what
    // actually drive status. Both paths are translated so a server that does
    // emit them stays correct.
    case 'session.status':
      if (!sessionID || !isRecord(data.status)) return [];
      return [status(data.status)];

    case 'session.idle':
      if (!sessionID) return [];
      return [status({ type: 'idle' }), event('session.idle', { sessionID })];

    case 'session.execution.started':
      if (!sessionID) return [];
      return [status({ type: 'busy' })];

    case 'session.execution.succeeded':
      if (!sessionID) return [];
      return [status({ type: 'idle' }), event('session.idle', { sessionID })];

    case 'session.execution.interrupted': {
      if (!sessionID) return [];
      const reason = trimmed(data.reason) || 'user';
      // A shutdown is not the end of the turn: OpenCode keeps the execution
      // claim and the resumed drain continues the same turn after restart
      // (v2.0.14 `session/execution.ts` settled(), `projector.ts` projectIdle,
      // `message-updater.ts`), and none of its own projections mark the
      // session idle. Reporting it as an abort would make the goal runtime
      // pause the goal as a user stop and the queue hold the next prompt, so
      // it produces nothing: the session stays busy until OpenCode resumes it
      // and reports the real terminal outcome.
      if (reason === 'shutdown') return [];
      // Every other interruption ends the turn without failing it: consumers
      // that treat `session.error` as a failure must not fire, but the queue
      // and goal runtimes still have to know the turn was aborted.
      return [
        status({ type: 'idle' }),
        event('session.idle', { sessionID, aborted: true, reason, error: ABORTED_ERROR }),
      ];
    }

    case 'session.execution.failed':
      if (!sessionID) return [];
      return [status({ type: 'idle' }), event('session.error', { sessionID, error: toServerError(data.error) })];

    // --- messages -----------------------------------------------------------

    case 'session.inbox.enqueued': {
      const item = isRecord(data.item) ? data.item : {};
      const messageID = trimmed(data.inboxID);
      if (!sessionID || !messageID) return [];
      const itemPayload = isRecord(item.payload) ? item.payload : {};
      if (item.type === 'user') {
        const text = typeof itemPayload.text === 'string' ? itemPayload.text : '';
        return [event('message.updated', {
          sessionID,
          info: compact({
            id: messageID,
            sessionID,
            role: 'user',
            text,
            parts: text ? [{ type: 'text', text }] : [],
            metadata: itemPayload.metadata,
            time: { created },
          }),
          parts: text ? [{ type: 'text', text }] : [],
        })];
      }
      return [];
    }

    case 'session.step.started': {
      const messageID = trimmed(data.assistantMessageID);
      if (!sessionID || !messageID) return [];
      const model = isRecord(data.model) ? data.model : {};
      return [event('message.updated', {
        sessionID,
        info: compact({
          id: messageID,
          sessionID,
          role: 'assistant',
          agent: trimmed(data.agent) || undefined,
          providerID: trimmed(model.providerID) || undefined,
          modelID: trimmed(model.id) || undefined,
          time: { created },
        }),
      })];
    }

    case 'session.step.ended': {
      const messageID = trimmed(data.assistantMessageID);
      if (!sessionID || !messageID) return [];
      return [event('message.updated', {
        sessionID,
        info: compact({
          id: messageID,
          sessionID,
          role: 'assistant',
          finish: trimmed(data.finish) || undefined,
          cost: data.cost,
          tokens: data.tokens,
          time: { completed: created },
        }),
      })];
    }

    case 'session.step.failed': {
      const messageID = trimmed(data.assistantMessageID);
      if (!sessionID || !messageID) return [];
      return [event('message.updated', {
        sessionID,
        info: compact({
          id: messageID,
          sessionID,
          role: 'assistant',
          finish: trimmed(data.finish) || 'error',
          error: toServerError(data.error),
          cost: data.cost,
          tokens: data.tokens,
          time: { completed: created },
        }),
      })];
    }

    // --- requests to the user -------------------------------------------------

    case 'permission.asked': {
      const requestID = trimmed(data.id);
      if (!requestID || !sessionID) return [];
      return [event('permission.asked', compact({
        id: requestID,
        sessionID,
        action: trimmed(data.action),
        resources: Array.isArray(data.resources) ? data.resources : [],
        save: Array.isArray(data.save) ? data.save : undefined,
        metadata: data.metadata,
        source: data.source,
        message: typeof data.message === 'string' ? data.message : undefined,
      }))];
    }

    case 'permission.replied':
      if (!sessionID) return [];
      return [event('permission.replied', { sessionID, requestID: trimmed(data.requestID) })];

    case 'form.created': {
      const form = isRecord(data.form) ? data.form : null;
      if (!form || !trimmed(form.id)) return [];
      return [event('form.created', { sessionID: trimmed(form.sessionID), form })];
    }

    case 'form.replied':
    case 'form.cancelled':
      if (!sessionID) return [];
      return [event('form.settled', { sessionID, formID: trimmed(data.id) })];

    // --- location-level notices ------------------------------------------------

    case 'vcs.branch.updated':
      return [event('vcs.branch.updated', { branch: typeof data.branch === 'string' ? data.branch : undefined })];

    case 'mcp.status.changed':
      return [event('mcp.status.changed', { server: trimmed(data.server) })];

    default:
      return [];
  }
}

/**
 * Convenience for consumers that hand one payload to one handler: translates
 * and forwards every resulting event in order.
 */
export function forwardTranslatedWireEvent(payload, handle) {
  if (typeof handle !== 'function') return;
  for (const translated of translateWireEvent(payload)) handle(translated);
}
