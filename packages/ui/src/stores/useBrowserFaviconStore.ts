import { create } from 'zustand';

import { invokeDesktopCommand } from '@/lib/desktopNative';

const MAX_ORIGINS = 60;

type FaviconState = {
  byOrigin: Record<string, string>;
  resolve: (pageUrl: string, iconUrl: string, webContentsId: number) => void;
};

const originOf = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
};

const pending = new Set<string>();

export const useBrowserFaviconStore = create<FaviconState>()((set, get) => ({
  byOrigin: {},

  resolve: (pageUrl, iconUrl, webContentsId) => {
    const origin = originOf(pageUrl);
    if (!origin || !iconUrl) return;
    if (get().byOrigin[origin] || pending.has(origin)) return;

    pending.add(origin);
    void invokeDesktopCommand<{ dataUrl?: string }>('desktop_browser_fetch_favicon', { url: iconUrl, webContentsId })
      .then((result) => {
        const dataUrl = typeof result?.dataUrl === 'string' ? result.dataUrl : '';
        if (!dataUrl) return;
        set((state) => {
          const byOrigin = { ...state.byOrigin, [origin]: dataUrl };
          const origins = Object.keys(byOrigin);
          if (origins.length <= MAX_ORIGINS) return { byOrigin };
          for (const stale of origins.slice(0, origins.length - MAX_ORIGINS)) delete byOrigin[stale];
          return { byOrigin };
        });
      })
      .catch(() => undefined)
      .finally(() => { pending.delete(origin); });
  },
}));
