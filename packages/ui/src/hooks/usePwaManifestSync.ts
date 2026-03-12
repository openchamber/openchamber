import React from 'react';
import { useSessionStore } from '@/stores/useSessionStore';
import { isWebRuntime } from '@/lib/desktop';
import { PWA_RECENT_SESSIONS_STORAGE_KEY } from '@/lib/pwa';

type RecentSessionShortcut = {
  sessionId: string;
  title: string;
};

type ManifestSyncWindow = Window & {
  __OPENCHAMBER_UPDATE_PWA_MANIFEST__?: () => void;
};

const MAX_RECENT_SHORTCUTS = 3;

const normalizeRecentTitle = (value: string | undefined, fallback: string): string => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, 48);
};

const buildRecentShortcuts = (
  sessions: Array<{ id: string; title?: string }>,
  currentSessionId: string | null,
): RecentSessionShortcut[] => {
  const ordered = currentSessionId
    ? [
        ...sessions.filter((session) => session.id === currentSessionId),
        ...sessions.filter((session) => session.id !== currentSessionId),
      ]
    : sessions;

  const shortcuts: RecentSessionShortcut[] = [];
  const seen = new Set<string>();

  for (const session of ordered) {
    const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }

    seen.add(sessionId);
    shortcuts.push({
      sessionId,
      title: normalizeRecentTitle(session.title, `Session ${shortcuts.length + 1}`),
    });

    if (shortcuts.length >= MAX_RECENT_SHORTCUTS) {
      break;
    }
  }

  return shortcuts;
};

export const usePwaManifestSync = () => {
  const sessions = useSessionStore((state) => state.sessions);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  const recentShortcuts = React.useMemo(() => {
    return buildRecentShortcuts(sessions, currentSessionId);
  }, [currentSessionId, sessions]);

  const signature = React.useMemo(() => JSON.stringify(recentShortcuts), [recentShortcuts]);

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isWebRuntime()) {
      return;
    }

    try {
      if (recentShortcuts.length === 0) {
        localStorage.removeItem(PWA_RECENT_SESSIONS_STORAGE_KEY);
      } else {
        localStorage.setItem(PWA_RECENT_SESSIONS_STORAGE_KEY, signature);
      }
    } catch {
      return;
    }

    const win = window as ManifestSyncWindow;
    win.__OPENCHAMBER_UPDATE_PWA_MANIFEST__?.();
  }, [recentShortcuts, signature]);
};
