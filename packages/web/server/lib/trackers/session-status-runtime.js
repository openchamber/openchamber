import { isPlainObject } from '../shared/guards.js';

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const properties = (payload) => (isPlainObject(payload) && isPlainObject(payload.properties) ? payload.properties : {});
const nested = (object, key) => (isPlainObject(object[key]) ? object[key] : {});

/** The session an event is about, as the hub forwards it. */
const sessionIdOf = (payload) => {
  const props = properties(payload);
  const info = nested(props, 'info');
  return text(info.sessionID) || text(info.sessionId) || text(props.sessionID) || text(props.sessionId) || text(props.session);
};

/**
 * A per-tracker runtime fed every host session event (`session-status.js`):
 * a turn that ends posts `completed`, a failed one `failure`, each through the
 * tracker's own `post`, which decides whether the session was started from one
 * of its items and whether comments are on. A stop (`MessageAbortedError`)
 * posts nothing. The runtime posts and forgets: a failed post is warned, never
 * retried. `createTrackerSessionStatus` stops it when the tracker leaves.
 *
 * @param {{ post: (input: { kind: 'completed' | 'failure', sessionId: string }) => Promise<unknown>, label: string, warn?: (...args: unknown[]) => void }} deps
 */
export function createSessionStatusRuntime({ post, label, warn = (...args) => console.warn(...args) }) {
  let stopped = false;
  const send = (kind, sessionId) => {
    void post({ kind, sessionId }).catch((error) => {
      warn(`[trackers] ${label}: failed to post the session ${kind} comment:`, error?.message || error);
    });
  };
  return {
    processPayload: (payload) => {
      if (stopped) return;
      const sessionId = sessionIdOf(payload);
      if (!sessionId || !isPlainObject(payload)) return;
      if (payload.type === 'session.error') {
        if (text(nested(properties(payload), 'error').name) === 'MessageAbortedError') return;
        send('failure', sessionId);
        return;
      }
      if (payload.type !== 'session.status') return;
      const props = properties(payload);
      const status = text(nested(props, 'status').type) || text(nested(props, 'info').type);
      if (status === 'idle') send('completed', sessionId);
    },
    stop: () => { stopped = true; },
  };
}
