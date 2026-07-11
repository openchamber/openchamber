// In-memory sandbox registry for Daytona sandbox orchestration.
//
// Maps chat session IDs to sandbox state objects. Provides lookup,
// registration, activity tracking, and enumeration of active sandboxes.

/**
 * Create a sandbox registry instance.
 *
 * @returns {{
 *   register: (sessionId: string, sandboxInfo: object) => void,
 *   unregister: (sessionId: string) => object | null,
 *   get: (sessionId: string) => object | null,
 *   updateActivity: (sessionId: string) => void,
 *   listActive: () => object[],
 *   getAll: () => Map<string, object>,
 * }}
 */
export const createSandboxRegistry = () => {
  /** @type {Map<string, object>} */
  const entries = new Map();

  /**
   * Register a new sandbox for a chat session.
   *
   * @param {string} sessionId - The chat session identifier.
   * @param {{
   *   sandboxId: string,
   *   openCodeUrl: string,
   *   [key: string]: unknown,
   * }} sandboxInfo - Sandbox metadata from the Daytona SDK.
   */
  const register = (sessionId, sandboxInfo) => {
    const now = Date.now();
    entries.set(sessionId, {
      sandboxId: sandboxInfo.sandboxId,
      sessionId,
      openCodeUrl: sandboxInfo.openCodeUrl || null,
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
    });
  };

  /**
   * Remove a sandbox entry and return it (or null if not found).
   *
   * @param {string} sessionId
   * @returns {object | null}
   */
  const unregister = (sessionId) => {
    const entry = entries.get(sessionId) || null;
    entries.delete(sessionId);
    return entry;
  };

  /**
   * Get the sandbox entry for a session.
   *
   * @param {string} sessionId
   * @returns {object | null}
   */
  const get = (sessionId) => entries.get(sessionId) || null;

  /**
   * Update the last activity timestamp for a session, keeping it alive.
   *
   * @param {string} sessionId
   */
  const updateActivity = (sessionId) => {
    const entry = entries.get(sessionId);
    if (entry) {
      entry.lastActivityAt = Date.now();
    }
  };

  /**
   * Return all entries with status "active".
   *
   * @returns {object[]}
   */
  const listActive = () => {
    const active = [];
    for (const entry of entries.values()) {
      if (entry.status === 'active') {
        active.push(entry);
      }
    }
    return active;
  };

  /**
   * Return the underlying map (for iteration/debugging).
   *
   * @returns {Map<string, object>}
   */
  const getAll = () => entries;

  return {
    register,
    unregister,
    get,
    updateActivity,
    listActive,
    getAll,
  };
};
