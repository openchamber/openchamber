export const LIVE_BROWSER_TABS_DEFAULT = 5;
export const LIVE_BROWSER_TABS_MIN = 1;
export const LIVE_BROWSER_TABS_MAX = 20;

export const clampLiveBrowserTabs = (value: number): number => (
  Number.isFinite(value)
    ? Math.max(LIVE_BROWSER_TABS_MIN, Math.min(LIVE_BROWSER_TABS_MAX, Math.round(value)))
    : LIVE_BROWSER_TABS_DEFAULT
);

export const touchRecentBrowserTab = (recent: readonly string[], key: string): readonly string[] => (
  recent[0] === key ? recent : [key, ...recent.filter((entry) => entry !== key)]
);

export const AGENT_TAB_IDLE_MS = 30 * 60_000;

export const dropIdleAgentTabs = (
  recent: readonly string[],
  agentTabs: ReadonlySet<string>,
  lastUsed: ReadonlyMap<string, number>,
  idleBefore: number,
): readonly string[] => {
  const kept = recent.filter((key) => !agentTabs.has(key) || (lastUsed.get(key) ?? Infinity) >= idleBefore);
  return kept.length === recent.length ? recent : kept;
};

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
