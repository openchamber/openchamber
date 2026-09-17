import type { SessionMessageRecord } from '@/lib/exportSession';

import { buildGuestSessionItem, guestActionWantsMessages, type GuestActionEntry } from './actions.ts';
import { guestMay } from './capabilities.ts';
import { openGuestWithItem } from './dialog-store.ts';

type SessionActionTarget = {
  id: string;
  title: string | null | undefined;
  directory: string | null | undefined;
};

/**
 * Run a session action from a menu: load the conversation when the action
 * asked for it and the grant covers it, then open the guest with the item.
 * `loadRecords` answers `null` for a failed load; the caller reports that
 * and nothing opens, so the guest never sees an empty conversation that is
 * really a fetch failure.
 */
export const runGuestSessionAction = async (input: {
  entry: GuestActionEntry;
  session: SessionActionTarget;
  loadRecords: () => Promise<readonly SessionMessageRecord[] | null>;
  onLoadFailed: () => void;
}): Promise<void> => {
  const { entry, session } = input;
  const target = { sessionId: session.id, sessionTitle: session.title, directory: session.directory };
  const wantsMessages = guestActionWantsMessages(entry.action) && guestMay(entry.guest, 'conversation');
  if (!wantsMessages) {
    openGuestWithItem(entry.guest, buildGuestSessionItem(entry.action.id, target), session.directory);
    return;
  }
  const records = await input.loadRecords();
  if (!records) {
    input.onLoadFailed();
    return;
  }
  openGuestWithItem(entry.guest, buildGuestSessionItem(entry.action.id, target, records), session.directory);
};
