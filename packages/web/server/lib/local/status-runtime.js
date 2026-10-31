import { asNonEmptyString, isPlainObject } from '../shared/guards.js';

/**
 * The local tracker's session-status runtime. The OpenCode event mapping is
 * the same as `../linear/status-runtime.js` (copied, not imported — the two
 * trackers share no state), but the comment goes to an injected `post` that
 * the tracker wires to its `sessionStatus.post`.
 *
 * Duplicate comments are prevented by that post layer (one comment per session
 * and kind), which is also where the session's issue link is recovered from:
 * the raw OpenCode events carry neither an identifier nor a session origin.
 */

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
  return asNonEmptyString(info.sessionID)
    || asNonEmptyString(info.sessionId)
    || asNonEmptyString(properties.sessionID)
    || asNonEmptyString(properties.sessionId)
    || asNonEmptyString(properties.session)
    || '';
}

function extractStatusType(payload) {
  if (!isPlainObject(payload) || payload.type !== 'session.status') return '';
  const properties = readProperties(payload);
  const status = readNested(properties, 'status');
  const info = readNested(properties, 'info');
  return asNonEmptyString(status.type) || asNonEmptyString(info.type) || '';
}

function extractErrorName(payload) {
  if (!isPlainObject(payload) || payload.type !== 'session.error') return '';
  const properties = readProperties(payload);
  return asNonEmptyString(readNested(properties, 'error').name) || '';
}

export function createLocalSessionStatusRuntime({ post }) {
  if (!(post instanceof Function)) {
    throw new Error('createLocalSessionStatusRuntime requires a post function');
  }

  let stopped = false;

  const processPayload = (payload) => {
    if (stopped) return;
    const sessionId = extractSessionId(payload);
    if (!sessionId) return;

    if (isPlainObject(payload) && payload.type === 'session.error') {
      if (extractErrorName(payload) === 'MessageAbortedError') return;
      void Promise.resolve(post({ kind: 'failure', sessionId })).catch((error) => {
        console.warn('[local] failed to post session failure comment:', error?.message || error);
      });
      return;
    }

    if (extractStatusType(payload) !== 'idle') return;
    void Promise.resolve(post({ kind: 'completed', sessionId })).catch((error) => {
      console.warn('[local] failed to post session completed comment:', error?.message || error);
    });
  };

  const stop = () => {
    stopped = true;
  };

  return { processPayload, stop };
}
