import { isPlainObject, readTrimmedString } from './parse.js';
import { postLinearSessionStatus } from './status.js';

function readProperties(payload) {
  if (!isPlainObject(payload)) return {};
  return isPlainObject(payload.properties) ? payload.properties : {};
}

function readNested(properties, key) {
  return isPlainObject(properties[key]) ? properties[key] : {};
}

function extractSessionId(payload) {
  const properties = readProperties(payload);
  const info = readNested(properties, 'info');
  return readTrimmedString(info.sessionID)
    || readTrimmedString(info.sessionId)
    || readTrimmedString(properties.sessionID)
    || readTrimmedString(properties.sessionId)
    || readTrimmedString(properties.session);
}

function extractStatusType(payload) {
  if (!isPlainObject(payload) || payload.type !== 'session.status') return '';
  const properties = readProperties(payload);
  const status = readNested(properties, 'status');
  const info = readNested(properties, 'info');
  return readTrimmedString(status.type) || readTrimmedString(info.type);
}

function extractErrorName(payload) {
  if (!isPlainObject(payload) || payload.type !== 'session.error') return '';
  const properties = readProperties(payload);
  return readTrimmedString(readNested(properties, 'error').name);
}

export function createLinearSessionStatusRuntime() {
  let stopped = false;

  const processPayload = (payload) => {
    if (stopped) return;
    const sessionId = extractSessionId(payload);
    if (!sessionId) return;

    if (isPlainObject(payload) && payload.type === 'session.error') {
      if (extractErrorName(payload) === 'MessageAbortedError') return;
      void postLinearSessionStatus({ kind: 'failure', sessionId }).catch((error) => {
        console.warn('[linear] failed to post session failure comment:', error?.message || error);
      });
      return;
    }

    if (extractStatusType(payload) !== 'idle') return;
    void postLinearSessionStatus({ kind: 'completed', sessionId }).catch((error) => {
      console.warn('[linear] failed to post session completed comment:', error?.message || error);
    });
  };

  const stop = () => {
    stopped = true;
  };

  return { processPayload, stop };
}
