/**
 * With the Server Browser every chat has its own Chrome, so a Browser tab of
 * the panel belongs to the chat it was opened in (`ownerSessionId`) and only
 * shows while that chat is on screen. Tabs of other chats wait in the
 * directory's `parked` list with their Chrome tab still open.
 *
 * A tab with no owner (opened before the chat existed, or with the in-app
 * browser) is never parked: the chat on screen in its directory adopts it.
 */
type SessionTab = {
  readonly id: string;
  readonly mode: string;
  readonly ownerSessionId: string | null;
};

type SessionTabs<T extends SessionTab> = {
  readonly tabs: T[];
  readonly parked: T[];
};

/**
 * Splits a directory's tabs for the chat on screen, `sessionId` (null for a
 * draft, which shows only unowned tabs). Returns null when nothing moves.
 */
export const splitBrowserTabsForSession = <T extends SessionTab>(
  tabs: readonly T[],
  parked: readonly T[],
  sessionId: string | null,
  adoptUnowned: boolean,
): SessionTabs<T> | null => {
  let changed = false;
  const shown: T[] = [];
  const waiting: T[] = [];
  for (const tab of tabs) {
    if (tab.mode !== 'browser' || tab.ownerSessionId === sessionId) {
      shown.push(tab);
    } else if (tab.ownerSessionId === null) {
      if (adoptUnowned && sessionId !== null) {
        shown.push({ ...tab, ownerSessionId: sessionId });
        changed = true;
      } else {
        shown.push(tab);
      }
    } else {
      waiting.push(tab);
      changed = true;
    }
  }
  for (const tab of parked) {
    if (tab.ownerSessionId === sessionId) {
      shown.push(tab);
      changed = true;
    } else {
      waiting.push(tab);
    }
  }
  return changed ? { tabs: shown, parked: waiting } : null;
};
