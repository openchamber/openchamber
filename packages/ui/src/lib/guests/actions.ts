import {
  GUEST_ITEM_MESSAGE_TEXT_MAX,
  GUEST_ITEM_SESSION_MAX,
  type GuestActionContribution,
  type GuestActionRole,
  type GuestItemRole,
  type GuestMessageItem,
  type GuestSessionItem,
  type GuestSessionItemMessage,
} from '@openchamber/sdk';

import type { IconName } from '@/components/icon/icons';
import { formatMessageRecordText, type SessionMessageRecord } from '@/lib/exportSession';

import { isGuestActive } from './capabilities.ts';
import { guestPackageIconSrc, resolveGuestIconName } from './icon.ts';
import type { InstalledGuest } from './types.ts';

/** One menu entry: the action and the guest that declared it, with the icon resolved for the host sprite. */
export type GuestActionEntry = {
  guest: InstalledGuest;
  action: GuestActionContribution;
  icon: IconName;
  iconSrc?: string;
};

/**
 * Menu entries for every active guest, in catalog order. A paused or not yet
 * approved guest contributes nothing, so a `payload: ["messages"]` action
 * only appears once `conversation` was granted.
 */
export const guestActionEntries = (
  guests: readonly InstalledGuest[],
  authenticatedAsset: (path: string) => string,
): GuestActionEntry[] => {
  const entries: GuestActionEntry[] = [];
  for (const guest of guests) {
    if (!isGuestActive(guest) || !guest.actions?.length) continue;
    for (const action of guest.actions) {
      const icon = action.icon ?? guest.icon;
      entries.push({
        guest,
        action,
        icon: resolveGuestIconName(icon),
        iconSrc: guestPackageIconSrc(guest.id, icon, authenticatedAsset),
      });
    }
  }
  return entries;
};

export const guestMessageActionsFor = (
  entries: readonly GuestActionEntry[],
  role: GuestActionRole,
): GuestActionEntry[] => entries.filter((entry) => (
  entry.action.where === 'message' && (entry.action.roles?.includes(role) ?? true)
));

export const guestSessionActions = (
  entries: readonly GuestActionEntry[],
): GuestActionEntry[] => entries.filter((entry) => entry.action.where === 'session');

export const guestActionWantsMessages = (action: GuestActionContribution): boolean => (
  action.payload?.includes('messages') ?? false
);

const recordRole = (record: SessionMessageRecord): GuestItemRole => (
  record.info.role === 'user' ? 'user' : 'assistant'
);

type SessionRef = {
  sessionId: string;
  sessionTitle: string | null | undefined;
  directory: string | null | undefined;
};

export const buildGuestMessageItem = (
  action: string,
  session: SessionRef,
  record: SessionMessageRecord,
): GuestMessageItem => ({
  kind: 'message',
  action,
  sessionId: session.sessionId,
  sessionTitle: session.sessionTitle?.trim() || session.sessionId,
  directory: session.directory ?? null,
  messageId: record.info.id,
  role: recordRole(record),
  text: formatMessageRecordText(record).slice(0, GUEST_ITEM_MESSAGE_TEXT_MAX),
});

const toSessionItemMessage = (record: SessionMessageRecord): GuestSessionItemMessage | null => {
  const text = formatMessageRecordText(record);
  if (!text) return null;
  return {
    id: record.info.id,
    role: recordRole(record),
    text: text.slice(0, GUEST_ITEM_MESSAGE_TEXT_MAX),
    createdAt: record.info.time?.created ?? 0,
  };
};

/**
 * The session item. `records` omitted means the action did not ask for the
 * conversation (no `messages` field); an empty list is a real empty
 * conversation. Messages are the same ones the Markdown export writes,
 * oldest first; when their JSON would exceed `GUEST_ITEM_SESSION_MAX` the
 * oldest are dropped and `truncated` is set.
 */
export const buildGuestSessionItem = (
  action: string,
  session: SessionRef,
  records?: readonly SessionMessageRecord[],
): GuestSessionItem => {
  const item: GuestSessionItem = {
    kind: 'session',
    action,
    sessionId: session.sessionId,
    sessionTitle: session.sessionTitle?.trim() || session.sessionId,
    directory: session.directory ?? null,
  };
  if (!records) return item;

  const messages: GuestSessionItemMessage[] = [];
  for (const record of records) {
    const message = toSessionItemMessage(record);
    if (message) messages.push(message);
  }
  // Size each message once; the total is the frame plus the entries plus a
  // comma between them, so trimming from the front never re-serializes.
  const frame = JSON.stringify({ ...item, messages: [], truncated: true }).length;
  const sizes = messages.map((message) => JSON.stringify(message).length);
  let total = sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, messages.length - 1);
  let dropped = 0;
  while (messages.length - dropped > 0 && frame + total > GUEST_ITEM_SESSION_MAX) {
    total -= sizes[dropped] + (messages.length - dropped > 1 ? 1 : 0);
    dropped += 1;
  }
  item.messages = dropped > 0 ? messages.slice(dropped) : messages;
  if (dropped > 0) item.truncated = true;
  return item;
};
