import React from 'react';
import { create } from 'zustand';

import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { fetchReceivedPages, type ReceivedPageItem } from '@/lib/received-pages/api';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { isSharingTurnedOff } from '@/lib/share-pages/api';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

/**
 * The pages this server received (decision 0018): what the `pages` surface
 * lists, and whether the rail shows it at all. One feed for every reader (the
 * rail, the switch shortcut, the list, the phone's drawer), read on first use,
 * again on every `received-page-changed` event and after the event stream
 * reconnects. `pages` stays null until a read succeeds; a failed read keeps
 * the pages already shown, and enterprise mode without a relay empties them.
 */
type ReceivedPagesState = {
  pages: ReceivedPageItem[] | null;
  error: string | null;
  turnedOff: boolean;
};

export const useReceivedPagesStore = create<ReceivedPagesState>()(() => ({ pages: null, error: null, turnedOff: false }));

let sequence = 0;
let feedKey: string | null = null;
let stopFeed: (() => void) | null = null;

const reload = async () => {
  const request = ++sequence;
  try {
    const pages = await fetchReceivedPages();
    if (request === sequence) useReceivedPagesStore.setState({ pages, error: null, turnedOff: false });
  } catch (error) {
    if (request !== sequence) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    useReceivedPagesStore.setState(isSharingTurnedOff(failure)
      ? { pages: [], error: null, turnedOff: true }
      : { error: failure.message });
  }
};

/** Starts the feed for this server and policy, once; a new server or policy starts it again from empty. */
export const ensureReceivedPagesFeed = (enterpriseMode: boolean) => {
  if (isVSCodeRuntime()) return;
  const key = `${getRuntimeKey()}\n${enterpriseMode}`;
  if (feedKey === key) return;
  stopFeed?.();
  feedKey = key;
  sequence += 1;
  useReceivedPagesStore.setState({ pages: null, error: null, turnedOff: false });
  void reload();
  let connected = false;
  const stopEvents = subscribeOpenchamberEvents((event) => {
    if (event.type === 'event-stream-ready') {
      // A reconnect reads again; so does the first connection when no read has
      // succeeded yet (the server was not up for the first one).
      if (connected || useReceivedPagesStore.getState().pages === null) void reload();
      connected = true;
    }
    if (event.type === 'received-page-changed') void reload();
  });
  const stopSwitch = subscribeRuntimeEndpointWillChange(() => {
    stopFeed?.();
    stopFeed = null;
    feedKey = null;
  });
  stopFeed = () => {
    stopEvents();
    stopSwitch();
  };
};

/** The received pages, kept current while any reader is mounted. */
export function useReceivedPages(): ReceivedPagesState {
  const enterpriseMode = useEnterpriseMode();
  React.useEffect(() => { ensureReceivedPagesFeed(enterpriseMode); }, [enterpriseMode]);
  return useReceivedPagesStore();
}

/** Whether the rail shows the `pages` surface: the server has received a page (or a tab of it is open). */
export const hasReceivedPages = (state: ReceivedPagesState): boolean => !state.turnedOff && (state.pages?.length ?? 0) > 0;

/** Reads the latest list again (Retry). */
export const reloadReceivedPages = () => { void reload(); };
