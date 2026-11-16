import { SERVICE_MARKS_MAX, isGuestApproved, requestedGuestCapabilities } from '@openchamber/sdk';

import { guestIdOfServiceToken } from './service.js';

const targetKey = (target) => (typeof target.sessionId === 'string'
  ? JSON.stringify(['session', target.sessionId])
  : JSON.stringify(['directory', target.directory, target.branch ?? null]));

const sameMark = (a, b) => a.icon === b.icon && a.tone === b.tone && a.text === b.text && (a.url ?? null) === (b.url ?? null);

/**
 * Whether the sidebar shows this guest's marks: it is on, approved for all it
 * asks, and its manifest still asks for marks. A grant left over from a
 * version that asked no longer counts.
 */
export const mayGuestShowMarks = (guest) => guest.marks === true
  && guest.enabled !== false
  && guest.capabilityGrants?.includes('marks') === true
  && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants });

/**
 * The marks running services put on sidebar rows (`marks.set`). Memory only,
 * and held under the token of the process that set them: a mark is gone when
 * that process is, whatever ended it, and the next process starts with none.
 * @param {{ guestIdOfToken?: (token: string) => string | null }} [deps]
 */
export const createGuestMarks = ({ guestIdOfToken = guestIdOfServiceToken } = {}) => {
  /** @type {Map<string, { token: string, marks: Map<string, { target: object, mark: object }> }>} */
  const held = new Map();

  /** The marks of the guest's running process; what an ended one left is dropped here. */
  const current = (guestId) => {
    const entry = held.get(guestId);
    if (!entry) return null;
    if (guestIdOfToken(entry.token) === guestId) return entry;
    held.delete(guestId);
    return null;
  };

  return {
    /**
     * Sets or, with `null`, removes the mark on one target.
     * @param {string} guestId
     * @param {string} token the bearer of the call
     * @param {object} target
     * @param {object | null} mark
     * @param {() => boolean} [mayChange] asked once, only when the call would change something
     * @returns {'changed' | 'unchanged' | 'full' | 'limited' | 'ended'} `ended`
     *   when the token no longer names the guest's running service, `full`
     *   when the guest already holds `SERVICE_MARKS_MAX` marks on other
     *   targets, `limited` when `mayChange` refused
     */
    set: (guestId, token, target, mark, mayChange = () => true) => {
      if (guestIdOfToken(token) !== guestId) return 'ended';
      const entry = current(guestId);
      const marks = entry?.token === token ? entry.marks : new Map();
      const key = targetKey(target);
      const previous = marks.get(key);
      if (mark === null) {
        if (!previous) return 'unchanged';
        if (!mayChange()) return 'limited';
        marks.delete(key);
        if (marks.size === 0) held.delete(guestId);
        return 'changed';
      }
      if (previous && sameMark(previous.mark, mark)) return 'unchanged';
      if (!previous && marks.size >= SERVICE_MARKS_MAX) return 'full';
      if (!mayChange()) return 'limited';
      marks.set(key, { target, mark });
      held.set(guestId, { token, marks });
      return 'changed';
    },

    /**
     * Drops what the guest holds, whatever process set it.
     * @param {string} guestId
     * @returns {boolean} whether it held any
     */
    clearGuest: (guestId) => held.delete(guestId),

    /**
     * Drops what a process that is no longer the guest's running service left.
     * @param {string} guestId
     * @returns {boolean} whether it left any
     */
    dropEnded: (guestId) => held.has(guestId) && current(guestId) === null,

    /**
     * @param {string} guestId
     * @returns {Array<{ target: object, mark: object }>}
     */
    list: (guestId) => [...(current(guestId)?.marks.values() ?? [])],
  };
};

/** The one set of marks this server holds. */
export const guestMarks = createGuestMarks();
