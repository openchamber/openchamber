import { create } from 'zustand';

/**
 * Tracks which browser panel tabs are currently "detached" into a separate
 * pop-out window. In-memory only (a pop-out window never survives an app
 * restart). Cross-window coordination rides on a BroadcastChannel — the pop-out
 * window posts `closed` when it goes away so the panel can re-attach the pane.
 */

export const BROWSER_POPOUT_CHANNEL = 'openchamber:browser-popout';

/**
 * DOM event the Electron main process emits (via the preload bridge) to every
 * window when a pop-out closes, so the panel can re-dock. Desktop can't rely on
 * BroadcastChannel across separate BrowserWindows, so it brokers through main.
 * NOTE: kept in sync with the literal emitted in `packages/electron/main.mjs`
 * (a .mjs in another package can't import this constant).
 */
export const BROWSER_POPOUT_CLOSED_EVENT = 'openchamber:browser-popout-closed';

type BrowserPopoutMessage =
  | { type: 'closed'; key: string }
  | { type: 'dock'; key: string };

/**
 * Stable per-tab key shared by every surface (panel, pop-out window, and the
 * `${directory}::${tabID}` literal derived in main.mjs). Keep the format aligned
 * across those three call sites.
 */
export const browserPopoutKey = (directory: string, tabID: string): string => `${directory}::${tabID}`;

export const postBrowserPopoutMessage = (message: BrowserPopoutMessage): void => {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(BROWSER_POPOUT_CHANNEL);
  try {
    channel.postMessage(message);
  } finally {
    channel.close();
  }
};

interface BrowserPopoutState {
  detached: Record<string, boolean>;
  setDetached: (key: string, detached: boolean) => void;
}

export const useBrowserPopoutStore = create<BrowserPopoutState>((set) => ({
  detached: {},
  setDetached: (key, detached) =>
    set((state) => {
      if (Boolean(state.detached[key]) === detached) return state;
      const next = { ...state.detached };
      if (detached) next[key] = true;
      else delete next[key];
      return { detached: next };
    }),
}));
