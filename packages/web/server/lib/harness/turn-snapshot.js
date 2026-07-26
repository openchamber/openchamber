/**
 * Server-side last-turn snapshot for Claude harness sessions.
 * Goal / auto-accept / reconnect paths cannot read OpenCode /session/:id/message
 * for harness turns (those are broadcast-only into the UI stream).
 */

/** @typedef {'busy' | 'idle'} HarnessSessionStatus */

/**
 * @typedef {object} HarnessTurnSnapshot
 * @property {string} sessionId
 * @property {string} directory
 * @property {HarnessSessionStatus} status
 * @property {number} updatedAt
 * @property {{ info: object, parts: object[] } | null} lastUser
 * @property {{ info: object, parts: object[] } | null} lastAssistant
 * @property {boolean} aborted
 */

/** @type {Map<string, HarnessTurnSnapshot>} */
const snapshots = new Map();

const SESSION_LIMIT = 500;

/**
 * @param {string} sessionId
 * @param {string} [directory]
 * @returns {HarnessTurnSnapshot}
 */
function ensureSnapshot(sessionId, directory = '') {
  let snap = snapshots.get(sessionId);
  if (!snap) {
    snap = {
      sessionId,
      directory: typeof directory === 'string' ? directory : '',
      status: 'idle',
      updatedAt: Date.now(),
      lastUser: null,
      lastAssistant: null,
      aborted: false,
    };
    snapshots.set(sessionId, snap);
    if (snapshots.size > SESSION_LIMIT) {
      snapshots.delete(snapshots.keys().next().value);
    }
  } else if (directory && !snap.directory) {
    snap.directory = directory;
  }
  return snap;
}

/**
 * Apply one OpenCode-shaped harness event to the snapshot.
 * @param {object} event
 * @param {string} [directory]
 */
export function applyHarnessEventToSnapshot(event, directory = '') {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;

  if (event.type === 'session.status') {
    const sessionId = typeof event.properties?.sessionID === 'string' ? event.properties.sessionID : '';
    if (!sessionId) return;
    const statusType = event.properties?.status?.type;
    if (statusType !== 'busy' && statusType !== 'idle') return;
    const snap = ensureSnapshot(sessionId, directory);
    snap.status = statusType;
    snap.updatedAt = Date.now();
    if (statusType === 'busy') snap.aborted = false;
    return;
  }

  if (event.type === 'message.updated') {
    const info = event.properties?.info;
    if (!info || typeof info !== 'object') return;
    const sessionId = typeof info.sessionID === 'string' ? info.sessionID : '';
    if (!sessionId) return;
    const snap = ensureSnapshot(sessionId, directory);
    snap.updatedAt = Date.now();
    if (info.error?.name === 'MessageAbortedError') {
      snap.aborted = true;
    }
    if (info.role === 'user') {
      snap.lastUser = {
        info,
        parts: snap.lastUser?.info?.id === info.id ? (snap.lastUser.parts || []) : [],
      };
      return;
    }
    if (info.role === 'assistant') {
      const prev = snap.lastAssistant?.info?.id === info.id ? snap.lastAssistant : null;
      snap.lastAssistant = {
        info,
        parts: prev?.parts || [],
      };
    }
    return;
  }

  if (event.type === 'message.part.updated') {
    const part = event.properties?.part;
    if (!part || typeof part !== 'object') return;
    const sessionId = typeof part.sessionID === 'string'
      ? part.sessionID
      : (typeof event.properties?.sessionID === 'string' ? event.properties.sessionID : '');
    if (!sessionId) return;
    const messageID = typeof part.messageID === 'string' ? part.messageID : '';
    if (!messageID) return;
    const snap = ensureSnapshot(sessionId, directory);
    snap.updatedAt = Date.now();

    const attach = (bucket) => {
      if (!bucket || bucket.info?.id !== messageID) return false;
      const parts = Array.isArray(bucket.parts) ? [...bucket.parts] : [];
      const idx = parts.findIndex((entry) => entry?.id === part.id);
      if (idx >= 0) parts[idx] = part;
      else parts.push(part);
      bucket.parts = parts;
      return true;
    };

    if (!attach(snap.lastAssistant) && !attach(snap.lastUser)) {
      // Part arrived before message.updated — seed a stub assistant/user bucket.
      if (part.type === 'text') {
        snap.lastAssistant = {
          info: {
            id: messageID,
            sessionID: sessionId,
            role: 'assistant',
            time: { created: Date.now() },
            providerID: 'claude-code',
            modelID: 'sonnet',
            agent: 'build',
            mode: 'build',
          },
          parts: [part],
        };
      }
    }
  }
}

/**
 * @param {string} sessionId
 * @returns {HarnessTurnSnapshot | null}
 */
export function getHarnessTurnSnapshot(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return snapshots.get(sessionId) ?? null;
}

/**
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isHarnessSessionWorking(sessionId) {
  const snap = getHarnessTurnSnapshot(sessionId);
  return snap?.status === 'busy';
}

/**
 * Active harness session statuses for OpenCode `/session/status` overlays.
 * Matches OpenCode's contract: only non-idle entries are returned.
 *
 * @param {string} [directory]
 * @returns {Record<string, { type: 'busy' }>}
 */
export function listHarnessBusyStatuses(directory) {
  const filter = typeof directory === 'string' && directory.trim()
    ? directory.trim()
    : '';
  /** @type {Record<string, { type: 'busy' }>} */
  const result = {};
  for (const snap of snapshots.values()) {
    if (snap.status !== 'busy') continue;
    if (filter && snap.directory && snap.directory !== filter) continue;
    result[snap.sessionId] = { type: 'busy' };
  }
  return result;
}

/**
 * Build OpenCode-shaped message list for session-goal ticks.
 * @param {string} sessionId
 * @returns {Array<{ info: object, parts: object[] }> | null}
 */
export function getHarnessRecentMessages(sessionId) {
  const snap = getHarnessTurnSnapshot(sessionId);
  if (!snap) return null;
  const messages = [];
  if (snap.lastUser) messages.push(snap.lastUser);
  if (snap.lastAssistant) messages.push(snap.lastAssistant);
  return messages;
}

/** Test helper */
export function resetHarnessTurnSnapshots() {
  snapshots.clear();
}
