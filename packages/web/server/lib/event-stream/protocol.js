export const MESSAGE_STREAM_GLOBAL_WS_PATH = '/api/global/event/ws';
export const MESSAGE_STREAM_DIRECTORY_WS_PATH = '/api/event/ws';
export const MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;

export function parseSseEventEnvelope(block) {
  if (!block || typeof block !== 'string') {
    return null;
  }

  const eventId = block
    .split('\n')
    .find((line) => line.startsWith('id:'))
    ?.slice(3)
    .trim() || null;

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
        eventId,
        directory: typeof parsed.directory === 'string' && parsed.directory.length > 0 ? parsed.directory : null,
        payload: parsed.payload,
      };
    }

    const directory =
      typeof parsed?.directory === 'string' && parsed.directory.length > 0
        ? parsed.directory
        : typeof parsed?.properties?.directory === 'string' && parsed.properties.directory.length > 0
          ? parsed.properties.directory
          : null;

    return {
      eventId,
      directory,
      payload: parsed,
    };
  } catch {
    return null;
  }
}

export function sendMessageStreamWsFrame(socket, payload) {
  if (!socket || socket.readyState !== 1) {
    return false;
  }

  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function sendMessageStreamWsEvent(socket, payload, options = {}) {
  return sendMessageStreamWsFrame(socket, {
    type: 'event',
    payload,
    ...(typeof options.eventId === 'string' && options.eventId.length > 0 ? { eventId: options.eventId } : {}),
    ...(typeof options.directory === 'string' && options.directory.length > 0 ? { directory: options.directory } : {}),
  });
}
