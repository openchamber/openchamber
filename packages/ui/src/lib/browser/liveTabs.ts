/**
 * How many of the user's browser tabs keep their page loaded, across every
 * project. Each loaded tab is a Chromium process of its own, so the rest sleep:
 * the tab and its address stay, and the page loads again when shown.
 * Agent tabs are outside this count; they stay loaded for the session working them.
 */
export const LIVE_BROWSER_TABS_DEFAULT = 5;
export const LIVE_BROWSER_TABS_MIN = 1;
export const LIVE_BROWSER_TABS_MAX = 20;

export const clampLiveBrowserTabs = (value: number): number => (
  Number.isFinite(value)
    ? Math.max(LIVE_BROWSER_TABS_MIN, Math.min(LIVE_BROWSER_TABS_MAX, Math.round(value)))
    : LIVE_BROWSER_TABS_DEFAULT
);

/** Tab keys by last use, newest first, each key once. */
export const touchRecentBrowserTab = (recent: readonly string[], key: string): readonly string[] => (
  recent[0] === key ? recent : [key, ...recent.filter((entry) => entry !== key)]
);

/** The user's tabs that keep their page: the `limit` most recently used of those still open. */
export const pickLiveBrowserTabs = (
  recent: readonly string[],
  openUserTabs: ReadonlySet<string>,
  limit: number,
): ReadonlySet<string> => {
  const live = new Set<string>();
  for (const key of recent) {
    if (live.size >= limit) break;
    if (openUserTabs.has(key)) live.add(key);
  }
  return live;
};
