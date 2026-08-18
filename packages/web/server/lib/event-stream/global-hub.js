import { createUpstreamSseReader } from './upstream-reader.js';

// Raised from 512 → 2048 to improve recovery after brief disconnects during
// long-running agent sessions where many events accumulate quickly.
const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;
const LATEST_SESSION_STATUS_CACHE_MAX_ENTRIES = 200;
const LATEST_SESSION_STATUS_CACHE_MAX_BYTES = 256 * 1024;
const LATEST_SESSION_STATUS_MESSAGE_MAX_BYTES = 4 * 1024;
const LATEST_SESSION_STATUS_ENTRY_OVERHEAD_BYTES = 64;
const STATUS_ACTION_STRING_FIELDS = ['reason', 'provider', 'title', 'message', 'label', 'link'];
const CALLABLE_TAGS = new Set([
  '[object Function]',
  '[object AsyncFunction]',
  '[object GeneratorFunction]',
  '[object AsyncGeneratorFunction]',
]);

function isObject(value) {
  return value !== null && Object.prototype.toString.call(value) === '[object Object]';
}

function isString(value) {
  return Object.prototype.toString.call(value) === '[object String]';
}

function isCallable(value) {
  return CALLABLE_TAGS.has(Object.prototype.toString.call(value));
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function capStatusMessage(message) {
  if (byteLength(message) <= LATEST_SESSION_STATUS_MESSAGE_MAX_BYTES) {
    return message;
  }

  let bytes = 0;
  let end = 0;
  for (const codePoint of message) {
    const codePointBytes = byteLength(codePoint);
    if (bytes + codePointBytes > LATEST_SESSION_STATUS_MESSAGE_MAX_BYTES) {
      break;
    }
    bytes += codePointBytes;
    end += codePoint.length;
  }

  // Copy the bounded string so a substring cannot retain the full upstream
  // payload in the cache. Iterating the string preserves surrogate pairs.
  return Buffer.from(message.slice(0, end), 'utf8').toString('utf8');
}

function normalizeStatusAction(action) {
  if (!isObject(action)) {
    return null;
  }

  const normalized = {};
  for (const field of STATUS_ACTION_STRING_FIELDS) {
    if (isString(action[field])) {
      normalized[field] = capStatusMessage(action[field]);
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeStatusValue(status) {
  if (!isObject(status)) {
    return null;
  }

  if (status.type !== 'busy' && status.type !== 'retry') {
    return null;
  }

  const normalized = { type: status.type };
  if (Number.isFinite(status.attempt)) {
    normalized.attempt = status.attempt;
  }
  if (isString(status.message)) {
    normalized.message = capStatusMessage(status.message);
  }
  if (Number.isFinite(status.next)) {
    normalized.next = status.next;
  }
  const action = status.type === 'retry' ? normalizeStatusAction(status.action) : null;
  if (action) {
    normalized.action = action;
  }
  return normalized;
}

function isRecognizedTerminalStatus(status) {
  return isObject(status) && (
    status.type === 'idle'
    || status.type === 'session.idle'
    || status.type === 'session.error'
    || status.type === 'session.deleted'
  );
}

function isSameStatus(left, right) {
  const leftAction = left.action;
  const rightAction = right.action;
  return left.type === right.type
    && left.attempt === right.attempt
    && left.message === right.message
    && left.next === right.next
    && STATUS_ACTION_STRING_FIELDS.every((field) => leftAction?.[field] === rightAction?.[field]);
}

function getSessionId(properties) {
  if (!isObject(properties)) {
    return '';
  }

  if (isString(properties.sessionID) && properties.sessionID.trim()) {
    return properties.sessionID.trim();
  }

  const info = isObject(properties.info) ? properties.info : null;
  return isString(info?.id) ? info.id.trim() : '';
}

function getStatusCacheEntryBytes(entry) {
  const { status } = entry;
  const actionBytes = STATUS_ACTION_STRING_FIELDS.reduce(
    (total, field) => total + (isString(status.action?.[field]) ? byteLength(status.action[field]) : 0),
    0,
  );
  return LATEST_SESSION_STATUS_ENTRY_OVERHEAD_BYTES
    + byteLength(entry.sessionID)
    + byteLength(entry.directory)
    + byteLength(status.type)
    + (isString(status.message) ? byteLength(status.message) : 0)
    + (Number.isFinite(status.attempt) ? 8 : 0)
    + (Number.isFinite(status.next) ? 8 : 0)
    + actionBytes;
}

function cloneStatusValue(status) {
  const clone = { ...status };
  if (isObject(status.action)) {
    clone.action = { ...status.action };
  }
  return clone;
}

function createLatestSessionStatusCache() {
  return {
    entries: new Map(),
    bytes: 0,
  };
}

function deleteLatestSessionStatus(cache, sessionId) {
  const existing = cache.entries.get(sessionId);
  if (!existing) {
    return;
  }

  cache.entries.delete(sessionId);
  cache.bytes -= existing.bytes;
}

function touchLatestSessionStatus(cache, sessionId, entry) {
  cache.entries.delete(sessionId);
  cache.entries.set(sessionId, entry);
}

function pruneLatestSessionStatusCache(cache) {
  while (
    cache.entries.size > LATEST_SESSION_STATUS_CACHE_MAX_ENTRIES
    || cache.bytes > LATEST_SESSION_STATUS_CACHE_MAX_BYTES
  ) {
    const oldest = cache.entries.entries().next().value;
    if (!oldest) {
      break;
    }

    cache.entries.delete(oldest[0]);
    cache.bytes -= oldest[1].bytes;
  }
}

function clearLatestSessionStatusCache(cache) {
  cache.entries.clear();
  cache.bytes = 0;
}

function updateLatestSessionStatusCache(cache, normalized) {
  const payload = normalized.payload;
  if (!isObject(payload)) {
    return;
  }

  if (
    payload.type !== 'session.status'
    && payload.type !== 'session.idle'
    && payload.type !== 'session.error'
    && payload.type !== 'session.deleted'
  ) {
    return;
  }

  const properties = isObject(payload.properties) ? payload.properties : {};
  const sessionId = getSessionId(properties);
  if (!sessionId) {
    return;
  }

  if (payload.type === 'session.status') {
    const rawStatus = isObject(properties.status) && isString(properties.status.type)
      ? properties.status
      : properties.info;
    const status = normalizeStatusValue(rawStatus);
    const existing = cache.entries.get(sessionId);
    if (status) {
      const directory = normalized.directory !== 'global'
        ? normalized.directory
        : existing?.directory ?? 'global';
      if (existing?.directory === directory && isSameStatus(existing.status, status)) {
        touchLatestSessionStatus(cache, sessionId, existing);
        return;
      }
      deleteLatestSessionStatus(cache, sessionId);
      const entry = {
        sessionID: sessionId,
        status,
        directory,
      };
      entry.bytes = getStatusCacheEntryBytes(entry);
      cache.entries.set(sessionId, entry);
      cache.bytes += entry.bytes;
      pruneLatestSessionStatusCache(cache);
      return;
    }

    if (isRecognizedTerminalStatus(rawStatus)) {
      deleteLatestSessionStatus(cache, sessionId);
    }
    return;
  }

  if (payload.type === 'session.idle' || payload.type === 'session.error' || payload.type === 'session.deleted') {
    deleteLatestSessionStatus(cache, sessionId);
  }
}

export function createGlobalMessageStreamHub({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  upstreamStallTimeoutMs,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
}) {
  const eventSubscribers = new Set();
  const statusSubscribers = new Set();
  const replay = [];
  const latestSessionStatuses = createLatestSessionStatusCache();

  let controller = null;
  let reader = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;

  const notifySubscriber = (kind, subscriber, payload) => {
    try {
      const result = subscriber(payload);
      if (result && isCallable(result.catch)) {
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
    const directory =
      isString(envelope?.directory) && envelope.directory.length > 0 ? envelope.directory : 'global';
    const eventId = isString(envelope?.eventId) && envelope.eventId.length > 0 ? envelope.eventId : undefined;
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
          return new URL(buildOpenCodeUrl('/global/event', ''));
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
        updateLatestSessionStatusCache(latestSessionStatuses, normalized);
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
    clearLatestSessionStatusCache(latestSessionStatuses);
  };

  const getReplayState = (eventId) => {
    if (!eventId) {
      return { cursor: 'none', entries: [] };
    }

    const index = replay.findIndex((entry) => entry.eventId === eventId);
    return {
      cursor: index === -1 ? 'miss' : 'found',
      entries: index === -1 ? [] : replay.slice(index + 1),
    };
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
      return getReplayState(eventId).entries;
    },
    getReplayState,
    getSessionStatusSnapshot() {
      return Array.from(latestSessionStatuses.entries.values(), ({ sessionID, status, directory }) => ({
        sessionID,
        status: cloneStatusValue(status),
        directory,
      }));
    },
  };
}
