import { isRecord } from '../shared/guards.js';
import { sessionParentId } from '../session-lineage.js';

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

const compact = (value) => {
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
};

export const wireEventDirectory = (payload) => {
  if (!isRecord(payload)) return '';
  return trimmed(payload.location?.directory);
};

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

  const status = (statusValue, extra = {}) => event('session.status', { sessionID, status: statusValue, ...extra });

  switch (type) {
    case 'server.connected':
      return [event('server.connected', {})];

    case 'installation.update-available':
      return [event('installation.update-available', { version: trimmed(data.version) })];

    case 'session.created': {
      if (!sessionID) return [];
      const location = isRecord(data.location) ? data.location : {};
      return [event('session.created', {
        sessionID,
        info: compact({
          id: sessionID,
          parentID: sessionParentId(data) || undefined,
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

    case 'session.forked': {
      const parentID = trimmed(data.parentID);
      if (!sessionID || !parentID) return [];
      return [event('session.forked', { sessionID, parentID })];
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

    case 'session.archived':
      if (!sessionID) return [];
      return [event('session.archived', { sessionID })];

    case 'session.unarchived':
      if (!sessionID) return [];
      return [event('session.unarchived', { sessionID })];

    case 'session.status':
      if (!sessionID || !isRecord(data.status)) return [];
      return [status(data.status)];

    case 'session.idle':
      if (!sessionID) return [];
      return [status({ type: 'idle' }), event('session.idle', { sessionID })];

    case 'session.execution.started':
      if (!sessionID) return [];
      return [status({ type: 'busy' }, { turnStartedAt: created })];

    case 'session.retry.scheduled': {
      if (!sessionID) return [];
      const error = isRecord(data.error) ? data.error : {};
      return [status(compact({
        type: 'retry',
        attempt: typeof data.attempt === 'number' ? data.attempt : undefined,
        message: typeof error.message === 'string' ? error.message : undefined,
        next: typeof data.at === 'number' ? data.at : undefined,
      }))];
    }

    case 'session.execution.succeeded':
      if (!sessionID) return [];
      return [status({ type: 'idle' }), event('session.idle', { sessionID })];

    case 'session.execution.interrupted': {
      if (!sessionID) return [];
      const reason = trimmed(data.reason) || 'user';
      if (reason === 'shutdown') return [];
      return [
        status({ type: 'idle' }),
        event('session.idle', { sessionID, aborted: true, reason, error: ABORTED_ERROR }),
      ];
    }

    case 'session.execution.failed':
      if (!sessionID) return [];
      return [status({ type: 'idle' }), event('session.error', { sessionID, error: toServerError(data.error) })];

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

    case 'session.shell.started':
      if (!sessionID) return [];
      return [event('session.shell.started', { sessionID })];

    case 'session.step.started': {
      const messageID = trimmed(data.assistantMessageID);
      if (!sessionID || !messageID) return [];
      const model = isRecord(data.model) ? data.model : {};
      return [
        event('message.updated', {
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
        }),
        status({ type: 'busy' }),
      ];
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

    case 'session.compaction.ended':
      if (!sessionID) return [];
      return [event('session.compacted', { sessionID })];

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

    case 'vcs.branch.updated':
      return [event('vcs.branch.updated', { branch: typeof data.branch === 'string' ? data.branch : undefined })];

    case 'mcp.status.changed':
      return [event('mcp.status.changed', { server: trimmed(data.server) })];

    default:
      return [];
  }
}

export function forwardTranslatedWireEvent(payload, handle) {
  if (typeof handle !== 'function') return;
  for (const translated of translateWireEvent(payload)) handle(translated);
}
