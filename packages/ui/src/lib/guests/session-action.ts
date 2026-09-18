import type { SessionMessageRecord } from '@/lib/exportSession';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

import { buildGuestSessionItem, guestActionWantsMessages, type GuestActionEntry } from './actions.ts';
import { guestMay } from './capabilities.ts';
import { runGuestAction } from './run-action.ts';

type SessionActionTarget = {
  id: string;
  title: string | null | undefined;
  directory: string | null | undefined;
};

/**
 * Run a session action from a menu: load the conversation when the action
 * asked for it and the grant covers it, then dispatch the declared mode.
 * `loadRecords` answers `null` for a failed load; the caller reports that
 * and nothing opens, so the guest never sees an empty conversation that is
 * really a fetch failure.
 */
export const runGuestSessionAction = async (input: {
  entry: GuestActionEntry;
  session: SessionActionTarget;
  loadRecords: () => Promise<readonly SessionMessageRecord[] | null>;
  onLoadFailed: () => void;
  t: Parameters<typeof runGuestAction>[2];
}): Promise<void> => {
  const { entry, session } = input;
  const runtimeKey = getRuntimeKey();
  const target = { sessionId: session.id, sessionTitle: session.title, directory: session.directory };
  const wantsMessages = guestActionWantsMessages(entry.action) && guestMay(entry.guest, 'conversation');
  if (!wantsMessages) {
    await runGuestAction(entry, buildGuestSessionItem(entry.action.id, target), input.t, runtimeKey);
    return;
  }
  let runtimeChanged = false;
  const unsubscribe = subscribeRuntimeEndpointChanged(() => { runtimeChanged = true; });
  let records: readonly SessionMessageRecord[] | null;
  try {
    records = await input.loadRecords();
  } finally {
    unsubscribe();
  }
  if (runtimeChanged) return;
  if (!records) {
    input.onLoadFailed();
    return;
  }
  await runGuestAction(entry, buildGuestSessionItem(entry.action.id, target, records), input.t, runtimeKey);
};
