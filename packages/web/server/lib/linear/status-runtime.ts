import { isPlainObject, readTrimmedString } from './parse.js';
import { postLinearSessionStatus } from './status.js';
import type { TrackerRuntimeEvent, TrackerSessionStatusRuntime } from '../trackers/tracker-contract.js';

interface LinearEventFields {
  info?: unknown;
  status?: unknown;
  error?: unknown;
  sessionID?: unknown;
  sessionId?: unknown;
  session?: unknown;
  type?: unknown;
  name?: unknown;
}

function readProperties(payload: TrackerRuntimeEvent): LinearEventFields {
  if (!isPlainObject(payload)) return {};
  return isPlainObject(payload.properties) ? payload.properties : {};
}

function readNested(properties: LinearEventFields, key: 'info' | 'status' | 'error'): LinearEventFields {
  return isPlainObject(properties[key]) ? properties[key] : {};
}

function extractSessionId(payload: TrackerRuntimeEvent) {
  const properties = readProperties(payload);
  const info = readNested(properties, 'info');
  const sessionId: unknown = readTrimmedString(info.sessionID)
    || readTrimmedString(info.sessionId)
    || readTrimmedString(properties.sessionID)
    || readTrimmedString(properties.sessionId)
    || readTrimmedString(properties.session);
  return sessionId;
}

function extractStatusType(payload: TrackerRuntimeEvent) {
  if (!isPlainObject(payload) || payload.type !== 'session.status') return '';
  const properties = readProperties(payload);
  const status = readNested(properties, 'status');
  const info = readNested(properties, 'info');
  const type: unknown = readTrimmedString(status.type) || readTrimmedString(info.type);
  return type;
}

function extractErrorName(payload: TrackerRuntimeEvent) {
  if (!isPlainObject(payload) || payload.type !== 'session.error') return '';
  const properties = readProperties(payload);
  const name: unknown = readTrimmedString(readNested(properties, 'error').name);
  return name;
}

export function createLinearSessionStatusRuntime(): TrackerSessionStatusRuntime {
  let stopped = false;

  const processPayload = (payload: TrackerRuntimeEvent) => {
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
