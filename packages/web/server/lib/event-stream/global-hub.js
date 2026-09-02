import { createUpstreamSseReader } from './upstream-reader.js';

// Raised from 512 → 2048 to improve recovery after brief disconnects during
// long-running agent sessions where many events accumulate quickly.
const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;
const EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const eventData = (payload) => {
  if (isObject(payload?.data)) {
    return payload.data;
  }
  if (isObject(payload?.properties)) {
    return payload.properties;
  }
  return {};
};

const eventDirectory = (envelope, payload, data) => {
  if (typeof payload?.location?.directory === 'string' && payload.location.directory.length > 0) {
    return payload.location.directory;
  }
  if (typeof envelope?.directory === 'string' && envelope.directory.length > 0) {
    return envelope.directory;
  }
  if (typeof data?.location?.directory === 'string' && data.location.directory.length > 0) {
    return data.location.directory;
  }
  return 'global';
};

const addDirectory = (properties, directory) => {
  if (directory === 'global' || !isObject(properties) || properties.directory) {
    return properties;
  }
  return { ...properties, directory };
};

const normalizeModel = (model) => {
  if (!isObject(model) || typeof model.id !== 'string' || typeof model.providerID !== 'string') {
    return undefined;
  }
  return {
    id: model.id,
    providerID: model.providerID,
    ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
  };
};

const fallbackSession = (sessionID, directory, created) => ({
  id: sessionID,
  slug: sessionID,
  projectID: '',
  directory: directory === 'global' ? '' : directory,
  cost: 0,
  tokens: EMPTY_TOKENS,
  title: sessionID,
  version: '2',
  time: { created, updated: created },
});

const sessionInfoFromCreatedEvent = (payload, data, directory) => {
  const location = isObject(data.location) ? data.location : {};
  const created = typeof payload.created === 'number' ? payload.created : 0;
  const sessionDirectory = typeof location.directory === 'string' && location.directory.length > 0
    ? location.directory
    : directory;
  const info = {
    id: data.sessionID,
    slug: typeof data.slug === 'string' ? data.slug : data.sessionID,
    projectID: typeof data.projectID === 'string' ? data.projectID : '',
    directory: sessionDirectory,
    cost: 0,
    tokens: EMPTY_TOKENS,
    title: typeof data.title === 'string' ? data.title : (data.slug || data.sessionID),
    version: typeof data.version === 'string' ? data.version : '2',
    time: { created, updated: created },
  };
  if (typeof location.workspaceID === 'string') info.workspaceID = location.workspaceID;
  if (typeof data.subpath === 'string' && data.subpath.length > 0) info.path = data.subpath;
  if (typeof data.parentID === 'string' && data.parentID.length > 0) info.parentID = data.parentID;
  if (typeof data.agent === 'string') info.agent = data.agent;
  const model = normalizeModel(data.model);
  if (model) info.model = model;
  return info;
};

const sessionInfoFromUpdateEvent = (payload, data, directory, type, sessions) => {
  const sessionID = typeof data.sessionID === 'string' ? data.sessionID : '';
  if (!sessionID) return null;

  const created = typeof payload.created === 'number' ? payload.created : undefined;
  const previous = sessions.get(sessionID);
  const info = {
    ...(previous ?? fallbackSession(sessionID, directory, created ?? 0)),
    time: {
      ...(previous?.time ?? { created: created ?? 0 }),
      ...(created === undefined ? {} : { updated: created }),
    },
  };

  if (type === 'session.renamed' && typeof data.title === 'string') {
    info.title = data.title;
  }
  if (type === 'session.agent.selected' && typeof data.agent === 'string') {
    info.agent = data.agent;
  }
  if (type === 'session.model.selected') {
    const model = normalizeModel(data.model);
    if (model) info.model = model;
  }
  if (type === 'session.moved') {
    const location = isObject(data.location) ? data.location : {};
    if (typeof location.directory === 'string' && location.directory.length > 0) info.directory = location.directory;
    if (typeof location.workspaceID === 'string') info.workspaceID = location.workspaceID;
    if (typeof data.projectID === 'string') info.projectID = data.projectID;
    if (typeof data.subpath === 'string') info.path = data.subpath;
  }
  if (typeof info.directory !== 'string' || !info.directory) info.directory = directory === 'global' ? '' : directory;
  sessions.set(sessionID, info);
  return info;
};

const normalizeQuestion = (form) => ({
  id: form.id,
  sessionID: form.sessionID,
  questions: Array.isArray(form.fields)
    ? form.fields.filter(isObject).map((field) => {
      const options = (field.type === 'string' || field.type === 'multiselect') && Array.isArray(field.options)
        ? field.options.filter(isObject).map((option) => ({
          label: option.label,
          description: option.description ?? '',
        }))
        : [];
      return {
        question: field.description ?? field.title ?? field.key ?? '',
        header: field.title ?? form.title ?? '',
        options,
        ...(field.type === 'multiselect' ? { multiple: true } : {}),
      };
    })
    : [],
});

const normalizePermission = (data) => ({
  id: data.id,
  sessionID: data.sessionID,
  permission: data.action ?? data.permission,
  patterns: data.resources ?? data.patterns ?? [],
  metadata: data.metadata ?? {},
  always: data.save ?? data.always ?? [],
  ...(isObject(data.source)
    ? { tool: { messageID: data.source.messageID, callID: data.source.id } }
    : isObject(data.tool) ? { tool: data.tool } : {}),
});

const normalizeOpenCode2Event = ({ envelope, payload, sessions }) => {
  const data = eventData(payload);
  const directory = eventDirectory(envelope, payload, data);
  const eventId = typeof payload?.id === 'string' && payload.id.length > 0
    ? payload.id
    : typeof envelope?.eventId === 'string' && envelope.eventId.length > 0
      ? envelope.eventId
      : undefined;
  const withDirectory = (properties) => addDirectory(properties, directory);
  const sessionID = data.sessionID;
  let normalizedPayload;

  switch (payload?.type) {
    case 'session.created': {
      if (typeof sessionID !== 'string') break;
      const info = sessionInfoFromCreatedEvent(payload, data, directory);
      sessions.set(sessionID, info);
      normalizedPayload = {
        type: 'session.created',
        properties: withDirectory({ sessionID, info }),
      };
      break;
    }
    case 'session.renamed':
    case 'session.agent.selected':
    case 'session.model.selected':
    case 'session.moved': {
      const info = sessionInfoFromUpdateEvent(payload, data, directory, payload.type, sessions);
      if (!info) break;
      normalizedPayload = { type: 'session.updated', properties: withDirectory({ sessionID: info.id, info }) };
      break;
    }
    case 'session.deleted':
      if (typeof sessionID === 'string') {
        const info = sessions.get(sessionID) ?? fallbackSession(sessionID, directory, typeof payload.created === 'number' ? payload.created : 0);
        normalizedPayload = {
          type: 'session.deleted',
          properties: withDirectory({ sessionID, info }),
        };
        sessions.delete(sessionID);
      }
      break;
    case 'session.status':
      if (typeof sessionID === 'string') {
        normalizedPayload = { type: 'session.status', properties: withDirectory({ sessionID, status: data.status }) };
      }
      break;
    case 'session.idle':
    case 'session.execution.succeeded':
      if (typeof sessionID === 'string') {
        normalizedPayload = { type: 'session.idle', properties: withDirectory({ sessionID }) };
      }
      break;
    case 'session.execution.started':
      if (typeof sessionID === 'string') {
        normalizedPayload = { type: 'session.status', properties: withDirectory({ sessionID, status: { type: 'busy' } }) };
      }
      break;
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      if (typeof sessionID === 'string') {
        const message = payload.type === 'session.execution.failed'
          ? data.error?.message
          : data.reason;
        normalizedPayload = {
          type: 'session.error',
          properties: withDirectory({
            sessionID,
            error: {
              name: payload.type === 'session.execution.failed' ? 'UnknownError' : 'MessageAbortedError',
              data: { message: typeof message === 'string' ? message : '' },
            },
          }),
        };
      }
      break;
    case 'permission.asked': {
      if (typeof data.id !== 'string' || typeof sessionID !== 'string') break;
      normalizedPayload = {
        type: 'permission.asked',
        properties: withDirectory(normalizePermission(data)),
      };
      break;
    }
    case 'permission.replied':
      if (typeof sessionID === 'string') {
        normalizedPayload = {
          type: 'permission.replied',
          properties: withDirectory({ sessionID, requestID: data.requestID, reply: data.reply }),
        };
      }
      break;
    case 'form.created': {
      const form = isObject(data.form) ? data.form : null;
      if (form && typeof form.id === 'string' && typeof form.sessionID === 'string') {
        normalizedPayload = { type: 'question.asked', properties: withDirectory(normalizeQuestion(form)) };
      }
      break;
    }
    case 'form.replied':
      if (typeof sessionID === 'string') {
        normalizedPayload = {
          type: 'question.replied',
          properties: withDirectory({ sessionID, requestID: data.id, answers: [] }),
        };
      }
      break;
    case 'form.cancelled':
      if (typeof sessionID === 'string') {
        normalizedPayload = {
          type: 'question.rejected',
          properties: withDirectory({ sessionID, requestID: data.id }),
        };
      }
      break;
    default:
      break;
  }

  normalizedPayload ??= { type: payload?.type, properties: withDirectory(data) };
  return {
    envelope: { eventId, directory, payload: normalizedPayload },
    payload: normalizedPayload,
    directory,
    eventId,
  };
};

export function createGlobalMessageStreamHub({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  upstreamStallTimeoutMs,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
  getOpenCodeProtocol = () => 'legacy',
}) {
  const eventSubscribers = new Set();
  const statusSubscribers = new Set();
  const replay = [];
  const sessions = new Map();

  let controller = null;
  let reader = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;

  const notifySubscriber = (kind, subscriber, payload) => {
    try {
      const result = subscriber(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn(`Global message stream ${kind} subscriber failed:`, error);
        });
      }
    } catch (error) {
      console.warn(`Global message stream ${kind} subscriber failed:`, error);
    }
  };

  const notifyStatus = (status) => {
    for (const subscriber of Array.from(statusSubscribers)) {
      notifySubscriber('status', subscriber, status);
    }
  };

  const normalizeEvent = ({ envelope, payload }) => {
    if (getOpenCodeProtocol() === 'opencode2' && payload) {
      return normalizeOpenCode2Event({ envelope, payload, sessions });
    }

    const directory =
      typeof envelope?.directory === 'string' && envelope.directory.length > 0 ? envelope.directory : 'global';
    const eventId = typeof envelope?.eventId === 'string' && envelope.eventId.length > 0 ? envelope.eventId : undefined;
    return {
      envelope,
      payload,
      directory,
      eventId,
    };
  };

  const start = () => {
    if (reader) {
      return;
    }

    controller = new AbortController();
    reader = createUpstreamSseReader({
      signal: controller.signal,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      fetchImpl,
      buildUrl: () => {
        buildUrlFailed = false;
        try {
          const eventPath = getOpenCodeProtocol() === 'opencode2' ? '/api/event' : '/global/event';
          return new URL(buildOpenCodeUrl(eventPath, ''));
        } catch {
          buildUrlFailed = true;
          throw new Error('OpenCode service unavailable');
        }
      },
      getHeaders: getOpenCodeAuthHeaders,
      onConnect() {
        connected = true;
        const wasReady = everConnected;
        everConnected = true;
        notifyStatus({ type: 'connect', wasReady });
      },
      onDisconnect({ reason }) {
        connected = false;
        notifyStatus({ type: 'disconnect', reason });
      },
      onEvent(event) {
        const normalized = normalizeEvent(event);
        if (normalized.eventId) {
          replay.push(normalized);
          if (replay.length > replayLimit) {
            replay.splice(0, replay.length - replayLimit);
          }
        }

        for (const subscriber of Array.from(eventSubscribers)) {
          notifySubscriber('event', subscriber, normalized);
        }
      },
      onError(error) {
        if (controller?.signal.aborted) {
          return;
        }

        notifyStatus({
          type: everConnected ? 'error' : 'initial-error',
          error,
          buildUrlFailed,
        });
      },
    });

    void reader.start();
  };

  const stop = () => {
    connected = false;
    reader?.stop();
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    reader = null;
    controller = null;
    everConnected = false;
    buildUrlFailed = false;
    sessions.clear();
  };

  return {
    start,
    stop,
    isConnected() {
      return connected;
    },
    hasConnected() {
      return everConnected;
    },
    subscribeEvent(subscriber) {
      eventSubscribers.add(subscriber);
      return () => {
        eventSubscribers.delete(subscriber);
      };
    },
    subscribeStatus(subscriber) {
      statusSubscribers.add(subscriber);
      return () => {
        statusSubscribers.delete(subscriber);
      };
    },
    replayAfter(eventId) {
      if (!eventId) {
        return [];
      }

      const index = replay.findIndex((entry) => entry.eventId === eventId);
      return index === -1 ? [] : replay.slice(index + 1);
    },
  };
}
