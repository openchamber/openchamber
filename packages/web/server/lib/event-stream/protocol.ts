import type { EventRouting, JsonValue, SseEnvelope, StreamSocket, WsEventFrame } from './contracts.js';
import { isJsonContainer, isJsonObject, isString } from './guards.js';

export const MESSAGE_STREAM_GLOBAL_WS_PATH = '/api/global/event/ws';
export const MESSAGE_STREAM_DIRECTORY_WS_PATH = '/api/event/ws';
export const MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;
export const MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export const MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES = 12 * 1024 * 1024;

export function parseSseEventEnvelope(block: string): SseEnvelope | null {
  if (!block) {
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
    const parsed: JsonValue = JSON.parse(payloadText);
    if (
      isJsonObject(parsed) &&
      isJsonContainer(parsed.payload)
    ) {
      return {
        eventId: readEventId(parsed.payload) ?? readEventId(parsed),
        directory: isString(parsed.directory) && parsed.directory.length > 0
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

function readEventId(payload: JsonValue) {
  return isJsonObject(payload) && isString(payload.id) && payload.id.length > 0
    ? payload.id
    : null;
}

function readDirectory(payload: JsonValue) {
  if (!isJsonObject(payload)) return null;
  const directory = isJsonObject(payload.location) ? payload.location.directory : undefined;
  return isString(directory) && directory.length > 0 ? directory : null;
}

export function sendMessageStreamWsFrame<T>(socket: StreamSocket | null | undefined, payload: T) {
  try {
    return sendSerializedMessageStreamWsFrame(socket, JSON.stringify(payload));
  } catch {
    return false;
  }
}

export function sendSerializedMessageStreamWsFrame(socket: StreamSocket | null | undefined, serializedFrame: string) {
  if (!socket || socket.readyState !== 1) {
    return false;
  }

  const buffered = socket.bufferedAmount ?? 0;

  if (buffered > MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES) {
    try {
      socket.close(1013, 'Message stream client is too slow');
    } catch {
      void 0;
    }
    return false;
  }

  try {
    socket.send(serializedFrame);
    const bufferedAfter = socket.bufferedAmount ?? 0;
    if (bufferedAfter > MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES) {
      try {
        socket.close(1013, 'Message stream client is too slow');
      } catch {
        void 0;
      }
      return false;
    }

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
          void 0;
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

export function sendMessageStreamWsEvent<T>(socket: StreamSocket | null | undefined, payload: T, options: EventRouting = {}) {
  try {
    return sendSerializedMessageStreamWsFrame(socket, serializeMessageStreamWsEvent(payload, options));
  } catch {
    return false;
  }
}

export function serializeMessageStreamWsEvent<T>(payload: T, options: EventRouting = {}) {
  const frame: WsEventFrame<T> = { type: 'event', payload };
  if (options.eventId && options.eventId.length > 0) frame.eventId = options.eventId;
  if (options.directory && options.directory.length > 0) frame.directory = options.directory;
  return JSON.stringify(frame);
}
