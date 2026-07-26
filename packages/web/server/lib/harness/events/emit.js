/**
 * Emit OpenCode-shaped events through the injected global UI broadcaster.
 * Directory scoping keeps transcript events on the correct project stream.
 *
 * Always updates the server-side turn snapshot and notifies observers, even
 * when no UI clients are connected (Goal / permission auto-accept).
 */

import { applyHarnessEventToSnapshot } from '../turn-snapshot.js';

/** @type {Set<(event: object, directory: string) => void>} */
const observers = new Set();

/**
 * @param {(event: object, directory: string) => void} observer
 * @returns {() => void}
 */
export function addHarnessEventObserver(observer) {
  if (typeof observer !== 'function') return () => {};
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/** Test helper */
export function resetHarnessEventObservers() {
  observers.clear();
}

/**
 * Stamp directory into event properties so SSE consumers (which do not receive
 * the broadcaster's options.directory) still route into the correct project
 * store via resolveEventDirectory / parseSseEventEnvelope.
 * @param {object} payload
 * @param {string} directory
 * @returns {object}
 */
export function withHarnessEventDirectory(payload, directory) {
  if (!payload || typeof payload !== 'object' || !directory) {
    return payload;
  }
  const properties = payload.properties && typeof payload.properties === 'object'
    ? payload.properties
    : {};
  if (typeof properties.directory === 'string' && properties.directory.length > 0) {
    return payload;
  }
  return {
    ...payload,
    properties: {
      ...properties,
      directory,
    },
  };
}

/**
 * @param {(payload: object, options?: { directory?: string, eventId?: string }) => void} broadcast
 * @param {object} payload
 * @param {{ directory?: string, eventId?: string }} [options]
 */
export function emitHarnessEvent(broadcast, payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const directory = typeof options.directory === 'string' && options.directory.length > 0
    ? options.directory
    : '';
  const eventId = typeof options.eventId === 'string' && options.eventId.length > 0
    ? options.eventId
    : undefined;

  const scopedPayload = withHarnessEventDirectory(payload, directory);

  applyHarnessEventToSnapshot(scopedPayload, directory);
  for (const observer of observers) {
    try {
      observer(scopedPayload, directory);
    } catch (error) {
      console.warn('[harness] event observer failed:', error?.message || error);
    }
  }

  if (typeof broadcast !== 'function') {
    return;
  }
  broadcast(scopedPayload, {
    ...(directory ? { directory } : {}),
    ...(eventId ? { eventId } : {}),
  });
}

/**
 * @param {(payload: object, options?: object) => void} broadcast
 * @param {string} directory
 * @param {object[]} events
 */
export function emitHarnessEvents(broadcast, directory, events) {
  if (!Array.isArray(events)) return;
  for (const event of events) {
    emitHarnessEvent(broadcast, event, { directory });
  }
}
