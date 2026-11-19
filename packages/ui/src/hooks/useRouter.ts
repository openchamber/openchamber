import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import { pushRouteEntry } from '@/lib/router/backGuard';
import { isSessionOpenRedirect, openSessionLink } from '@/lib/router/openSessionFromRoute';
import { listenForNotificationNavigation } from '@/lib/router/notificationNavigation';
import type { RouteState, AppRouteState } from '@/lib/router';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}

export function useRouter(): void {
  const isVSCode = React.useMemo(() => isVSCodeContext(), []);

  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);
  const pendingRouteRef = React.useRef<{ route: RouteState; initial: boolean; normalize: boolean } | null>(null);

  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  const applyRouteState = React.useCallback(
    async (route: RouteState) => {
      if (!route.settingsPath && useUIStore.getState().isSettingsDialogOpen) {
        setSettingsDialogOpen(false);
      }

      if (route.sessionId) {
        await openSessionLink(route.sessionId, route.messageId);
      }

      if (route.settingsPath) {
        setSettingsPage(resolveSettingsSlug(route.settingsPath));
        setSettingsDialogOpen(true);
        return;
      }

      if (route.tab && route.tab !== 'chat') {
        const directory = useDirectoryStore.getState().currentDirectory;
        if (directory) {
          const mode: ContextPanelMode = route.tab === 'files' ? 'file' : route.tab;
          useUIStore.getState().openContextSurface(directory, mode);
        }
      }

      if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
        navigateToDiff(route.diffFile);
      }
    },
    [setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  const getCurrentAppState = React.useCallback((): AppRouteState => {
    const sessionState = useSessionUIStore.getState();
    const uiState = useUIStore.getState();

    return {
      sessionId: sessionState.currentSessionId,
      isSettingsOpen: uiState.isSettingsDialogOpen,
      settingsPath: uiState.settingsPage,
    };
  }, []);

  const applyRoute = React.useCallback(async (route: RouteState, initial = false) => {
    pendingRouteRef.current = { route, initial, normalize: hasRouteParams() };
    if (isApplyingRouteRef.current) return;
    isApplyingRouteRef.current = true;
    try {
      while (pendingRouteRef.current) {
        const request = pendingRouteRef.current;
        pendingRouteRef.current = null;
        await applyRouteState(request.route);
        if (!isVSCode && request.normalize && !request.route.messageId && !pendingRouteRef.current) {
          const state = getCurrentAppState();
          updateBrowserURL(request.initial ? {
            ...state,
            sessionId: state.sessionId ?? request.route.sessionId,
            settingsPath: request.route.settingsPath ?? state.settingsPath,
          } : state, { replace: true, force: request.initial });
        }
      }
    } finally {
      isApplyingRouteRef.current = false;
    }
  }, [applyRouteState, getCurrentAppState, isVSCode]);

  const syncURLFromState = React.useCallback(
    (options: { replace?: boolean } = {}) => {
      if (isVSCode || isApplyingRouteRef.current) {
        return;
      }

      const state = getCurrentAppState();
      updateBrowserURL(state, options);
    },
    [isVSCode, getCurrentAppState]
  );

  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    if (!hasRouteParams()) {
      syncURLFromState({ replace: true });
      return;
    }

    const route = parseRoute();

    void applyRoute(route, true);
  }, [applyRoute, syncURLFromState]);

  React.useEffect(() => {
    if (isVSCode) return;

    return listenForNotificationNavigation((target) => {
      if (isApplyingRouteRef.current) return false;
      const route = parseRoute(target.searchParams);
      pushRouteEntry({}, target.href);
      void applyRoute(route).catch((error) => {
        console.error('[PWA] notification navigation failed:', error);
      });
      return true;
    });
  }, [applyRoute, isVSCode]);

  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSessionId: string | null = useSessionUIStore.getState().currentSessionId;

    const unsubscribe = useSessionUIStore.subscribe((state) => {
      const sessionId = state.currentSessionId;

      if (sessionId === prevSessionId) {
        return;
      }

      prevSessionId = sessionId;
      syncURLFromState({ replace: isSessionOpenRedirect() });
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;

    const unsubscribe = useUIStore.subscribe((state) => {
      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;

      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;

      if (isApplyingRouteRef.current) {
        return;
      }

      if (settingsOpenChanged || settingsPathChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  React.useEffect(() => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    const handlePopState = () => {
      const route = parseRoute();

      void applyRoute(route);
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isVSCode]);
}
