import { SERVICE_MARKS_MAX, isGuestApproved, requestedGuestCapabilities } from '@openchamber/sdk';

import { guestIdOfServiceToken } from './service.js';
import type { ServiceMark, ServiceMarkTarget } from '@openchamber/sdk';
import type { GuestRecord } from './contracts.js';
import { isString } from './input-guards.js';

type MarkTarget = { sessionId?: string; directory?: string; branch?: string };
type MarkEntry = { target: ServiceMarkTarget; mark: ServiceMark };

const targetKey = (target: MarkTarget) => (isString(target.sessionId)
  ? JSON.stringify(['session', target.sessionId])
  : JSON.stringify(['directory', target.directory, target.branch ?? null]));

const sameMark = (a: ServiceMark, b: ServiceMark) => a.icon === b.icon && a.tone === b.tone && a.text === b.text && (a.url ?? null) === (b.url ?? null);

export const mayGuestShowMarks = (guest: GuestRecord) => guest.marks === true
  && guest.enabled !== false
  && guest.capabilityGrants?.includes('marks') === true
  && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted: guest.capabilityGrants });

export const createGuestMarks = ({ guestIdOfToken = guestIdOfServiceToken }: { guestIdOfToken?: (token: string) => string | null } = {}) => {
  const held = new Map<string, { token: string; marks: Map<string, MarkEntry> }>();

  const current = (guestId: string) => {
    const entry = held.get(guestId);
    if (!entry) return null;
    if (guestIdOfToken(entry.token) === guestId) return entry;
    held.delete(guestId);
    return null;
  };

  return {
    set: (guestId: string, token: string, target: ServiceMarkTarget, mark: ServiceMark | null, mayChange = () => true): 'changed' | 'unchanged' | 'full' | 'limited' | 'ended' => {
      if (guestIdOfToken(token) !== guestId) return 'ended';
      const entry = current(guestId);
      const marks = entry?.token === token ? entry.marks : new Map<string, MarkEntry>();
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

    clearGuest: (guestId: string) => held.delete(guestId),

    dropEnded: (guestId: string) => held.has(guestId) && current(guestId) === null,

    list: (guestId: string) => [...(current(guestId)?.marks.values() ?? [])],
  };
};

export const guestMarks = createGuestMarks();
