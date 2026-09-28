export const MESSAGE_STREAM_GLOBAL_WS_PATH = '/api/global/event/ws';
export const MESSAGE_STREAM_DIRECTORY_WS_PATH = '/api/event/ws';
export const MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;
// Per-client pending outbound WS buffer, not a payload or stream-size limit.
// Healthy clients stay near 0; this only trips when a client is far behind.
// Raised from 4 MB → 16 MB to tolerate bursts during long agent sessions
// (e.g. ultrawork / multi-tool loops) where the browser briefly falls behind.
export const MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

// Threshold at which we emit a backpressure warning frame so the client can
// proactively start shedding low-priority updates before the hard disconnect.
export const MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES = 12 * 1024 * 1024;

/**
 * Parses one SSE block from OpenCode's `/api/event` stream.
 *
 * OpenCode v2 sends no `id:` lines: the event id lives in the JSON payload as
 * `payload.id` and the directory as `payload.location.directory`. Both are read
 * from the payload here so the replay buffer and the per-directory routing keep
 * working unchanged.
 */
export function parseSseEventEnvelope(block) {
  if (!block || typeof block !== 'string') {
    return null;
  }

  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^\s/, ''));

  if (dataLines.length === 0) {
    return null;
  }

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.payload === 'object' &&
      parsed.payload !== null
    ) {
      return {
        eventId: readEventId(parsed.payload) ?? readEventId(parsed),
        directory: typeof parsed.directory === 'string' && parsed.directory.length > 0
          ? parsed.directory
          : readDirectory(parsed.payload),
        payload: parsed.payload,
      };
    }

    return {
      eventId: readEventId(parsed),
      directory: readDirectory(parsed),
      payload: parsed,
    };
  } catch {
    return null;
  }
}

function readEventId(payload) {
  return payload && typeof payload === 'object' && typeof payload.id === 'string' && payload.id.length > 0
    ? payload.id
    : null;
}

function readDirectory(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const directory = payload.location?.directory;
  return typeof directory === 'string' && directory.length > 0 ? directory : null;
}

export function sendMessageStreamWsFrame(socket, payload) {
  try {
    return sendSerializedMessageStreamWsFrame(socket, JSON.stringify(payload));
  } catch {
    return false;
  }
}

export function sendSerializedMessageStreamWsFrame(socket, serializedFrame) {
  if (!socket || socket.readyState !== 1) {
    return false;
  }

  const buffered = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;

  if (buffered > MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES) {
    try {
      socket.close(1013, 'Message stream client is too slow');
    } catch {
    }
    return false;
  }

  try {
    socket.send(serializedFrame);
    const bufferedAfter = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;
    if (bufferedAfter > MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES) {
      try {
        socket.close(1013, 'Message stream client is too slow');
      } catch {
      }
      return false;
    }

    // Emit a one-shot backpressure warning when the buffer is building up.
    // The flag prevents sending repeated warnings that would themselves
    // increase the buffer.  It resets once the buffer drains below the
    // threshold.
    if (bufferedAfter > MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES) {
      if (!socket._ocBackpressureWarned) {
        socket._ocBackpressureWarned = true;
        try {
          socket.send(JSON.stringify({
            type: 'backpressure',
            bufferedBytes: bufferedAfter,
            maxBytes: MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES,
          }));
        } catch {
          // Best-effort warning — ignore send failures.
        }
      }
    } else if (socket._ocBackpressureWarned) {
      socket._ocBackpressureWarned = false;
    }

    return true;
  } catch {
    return false;
  }
}

export function sendMessageStreamWsEvent(socket, payload, options = {}) {
  try {
    return sendSerializedMessageStreamWsFrame(socket, serializeMessageStreamWsEvent(payload, options));
  } catch {
    return false;
  }
}

export function serializeMessageStreamWsEvent(payload, options = {}) {
  const frame = { type: 'event', payload };
  if (typeof options.eventId === 'string' && options.eventId.length > 0) frame.eventId = options.eventId;
  if (typeof options.directory === 'string' && options.directory.length > 0) frame.directory = options.directory;
  return JSON.stringify(frame);
}
