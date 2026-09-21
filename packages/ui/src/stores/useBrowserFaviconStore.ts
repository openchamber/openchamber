import { create } from 'zustand';

import { invokeDesktopCommand } from '@/lib/desktopNative';

/**
 * Page icons for browser tabs, kept per origin.
 *
 * Per origin rather than per tab or per page: a site uses one icon everywhere,
 * so the second tab on the same host already has its icon, and navigating
 * within a site does not make the tab flicker back to a placeholder.
 *
 * Held in memory only. The icons are data URLs, and filling persisted storage
 * with them to save one small request per host is a poor trade.
 */
const MAX_ORIGINS = 60;

type FaviconState = {
  byOrigin: Record<string, string>;
  /** Resolves and stores the icon a page reported. Failure is silent by design. */
  resolve: (pageUrl: string, iconUrl: string) => void;
};

const originOf = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
};

/** Requests in flight, so a page reporting its icon twice fetches once. */
const pending = new Set<string>();

export const useBrowserFaviconStore = create<FaviconState>()((set, get) => ({
  byOrigin: {},

  resolve: (pageUrl, iconUrl) => {
    const origin = originOf(pageUrl);
    if (!origin || !iconUrl) return;
    if (get().byOrigin[origin] || pending.has(origin)) return;

    pending.add(origin);
    void invokeDesktopCommand<{ dataUrl?: string }>('desktop_browser_fetch_favicon', { url: iconUrl })
      .then((result) => {
        const dataUrl = typeof result?.dataUrl === 'string' ? result.dataUrl : '';
        if (!dataUrl) return;
        set((state) => {
          const byOrigin = { ...state.byOrigin, [origin]: dataUrl };
          const origins = Object.keys(byOrigin);
          if (origins.length <= MAX_ORIGINS) return { byOrigin };
          // Oldest first: insertion order is close enough to least-recently-seen
          // for a cache whose only cost is one request.
          for (const stale of origins.slice(0, origins.length - MAX_ORIGINS)) delete byOrigin[stale];
          return { byOrigin };
        });
      })
      // A missing or unreachable icon is not a problem worth reporting: the tab
      // simply keeps the placeholder it already has.
      .catch(() => undefined)
      .finally(() => { pending.delete(origin); });
  },
}));
