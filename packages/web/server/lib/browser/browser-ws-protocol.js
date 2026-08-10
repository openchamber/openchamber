export const BROWSER_WS_PATH = '/api/browser/ws';
const BROWSER_WS_CONTROL_TAG_JSON = 0x01;
// Inbound client frames are small control messages (attach/watch/input).
export const BROWSER_WS_MAX_PAYLOAD_BYTES = 64 * 1024;

export const parseBrowserWsRequestPathname = (requestUrl) => {
  if (typeof requestUrl !== 'string' || requestUrl.length === 0) {
    return '';
  }
  try {
    return new URL(requestUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

const normalizeToBuffer = (rawData) => {
  if (Buffer.isBuffer(rawData)) {
    return rawData;
  }
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
  }
  return Buffer.from(rawData);
};

export const readBrowserWsControlFrame = (rawData) => {
  if (!rawData) {
    return null;
  }
  const buffer = normalizeToBuffer(rawData);
  if (buffer.length < 2 || buffer[0] !== BROWSER_WS_CONTROL_TAG_JSON) {
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

export const createBrowserWsControlFrame = (payload) => {
  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([Buffer.from([BROWSER_WS_CONTROL_TAG_JSON]), jsonBytes]);
};
