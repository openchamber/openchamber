export const TERMINAL_WS_PATH = '/api/terminal/ws';
export const TERMINAL_WS_CONTROL_TAG_JSON = 0x01;
export const TERMINAL_WS_MAX_PAYLOAD_BYTES = 64 * 1024;

export const parseRequestPathname = (requestUrl) => {
  if (typeof requestUrl !== 'string' || requestUrl.length === 0) {
    return '';
  }

  try {
    return new URL(requestUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

export const isTerminalWsPathname = (pathname) => pathname === TERMINAL_WS_PATH;

export const normalizeTerminalWsMessageToBuffer = (rawData) => {
  if (Buffer.isBuffer(rawData)) {
    return rawData;
  }

  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
  }

  return Buffer.from(rawData);
};

export const normalizeTerminalWsMessageToText = (rawData) => {
  if (typeof rawData === 'string') {
    return rawData;
  }

  return normalizeTerminalWsMessageToBuffer(rawData).toString('utf8');
};

export const readTerminalWsControlFrame = (rawData) => {
  if (!rawData) {
    return null;
  }

  const buffer = normalizeTerminalWsMessageToBuffer(rawData);
  if (buffer.length < 2 || buffer[0] !== TERMINAL_WS_CONTROL_TAG_JSON) {
    return null;
  }

  try {
    const parsed = JSON.parse(buffer.subarray(1).toString('utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const createTerminalWsControlFrame = (payload) => {
  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([Buffer.from([TERMINAL_WS_CONTROL_TAG_JSON]), jsonBytes]);
};

export const pruneRebindTimestamps = (timestamps, now, windowMs) =>
  timestamps.filter((timestamp) => now - timestamp < windowMs);

export const isRebindRateLimited = (timestamps, maxPerWindow) => timestamps.length >= maxPerWindow;
