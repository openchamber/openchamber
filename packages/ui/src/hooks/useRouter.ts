import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import { isSessionOpenRedirect, openSessionLink } from '@/lib/router/openSessionFromRoute';
import { listenForNotificationNavigation } from '@/lib/router/notificationNavigation';
import type { RouteState, AppRouteState } from '@/lib/router';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

/**
 * Check if running in VS Code webview context.
 */
function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}

/**
 * Hook that provides bidirectional URL routing for OpenChamber.
 *
 * On mount:
 * - Parses URL parameters and applies them to app state
 * - Sets up subscriptions to sync state changes back to URL
 * - Listens for browser back/forward navigation
 *
 * Works in:
 * - Web: Full bidirectional sync
 * - Desktop: Full bidirectional sync
 * - VS Code: State-only (no URL updates, reads initial params)
 */
export function useRouter(): void {
  const isVSCode = React.useMemo(() => isVSCodeContext(), []);

  // Track initialization to avoid duplicate applies
  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);
  const pendingRouteRef = React.useRef<{ route: RouteState; initial: boolean; normalize: boolean } | null>(null);

  // Get store actions (stable references)
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  /**
   * Apply a parsed route state to the application stores.
   */
  const applyRouteState = React.useCallback(
    async (route: RouteState) => {
      // 1. Apply session first (may trigger async operations); a message
      // link also asks the session's timeline to show that message.
      if (route.sessionId) {
        await openSessionLink(route.sessionId, route.messageId);
      }

      // 2. Handle settings first because it is a full-screen overlay.
      if (route.settingsPath) {
        setSettingsPage(resolveSettingsSlug(route.settingsPath));
        setSettingsDialogOpen(true);
        // Do not process a route view while settings is open.
        return;
      }

      // Close settings if URL has no settings section
      if (useUIStore.getState().isSettingsDialogOpen) {
        setSettingsDialogOpen(false);
      }

      // 3. Apply the view selected by the legacy URL parameter. Desktop
      // surfaces live in the context panel, so a non-chat tab deep link
      // opens the matching panel surface; activeSurface itself stays 'chat'
      // (nothing renders non-chat surfaces in the main area).
      if (route.tab && route.tab !== 'chat') {
        const directory = useDirectoryStore.getState().currentDirectory;
        if (directory) {
          const mode: ContextPanelMode = route.tab === 'files' ? 'file' : route.tab;
          useUIStore.getState().openContextSurface(directory, mode);
        }
      }

      // 4. Apply diff file (only if going to diff tab)
      if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
        navigateToDiff(route.diffFile);
      }
    },
    [setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  /**
   * Get current app state for URL serialization.
   */
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
        // Back/Forward can supersede a route while the session list loads.
        // Only the latest applied request may normalize the current entry.
        // Message targets live in the route, not in the serialized app state.
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

  /**
   * Sync current app state to URL.
   */
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

  // Initialize: parse URL and apply route on mount
  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // Only process if URL has route params
    if (!hasRouteParams()) {
      // No route params. The launch may already have reopened the last
      // session (App selects it before this effect runs, so the session
      // subscription below never sees that change): name it in the URL
      // without adding a history entry.
      syncURLFromState({ replace: true });
      return;
    }

    const route = parseRoute();

    // Retain the parsed session until directory/message bootstrap catches up.
    void applyRoute(route, true);
  }, [applyRoute, syncURLFromState]);

  React.useEffect(() => {
    if (isVSCode) return;

    return listenForNotificationNavigation((target) => {
      // Do not acknowledge a route that applyRoute would drop during startup.
      if (isApplyingRouteRef.current) return false;
      const route = parseRoute(target.searchParams);
      window.history.pushState({}, '', target.href);
      // Acceptance acknowledges ownership, not completion of session fetching.
      // Slow network reads must not cause the worker to reload a responsive app.
      void applyRoute(route).catch((error) => {
        console.error('[PWA] notification navigation failed:', error);
      });
      return true;
    });
  }, [applyRoute, isVSCode]);

  // Subscribe to session changes
  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSessionId: string | null = useSessionUIStore.getState().currentSessionId;

    const unsubscribe = useSessionUIStore.subscribe((state) => {
      const sessionId = state.currentSessionId;

      // Track route-driven changes too, even while URL writes are suppressed.
      if (sessionId === prevSessionId) {
        return;
      }

      prevSessionId = sessionId;
      syncURLFromState({ replace: isSessionOpenRedirect() });
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  // Subscribe to UI store changes (view, settings)
  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;

    const unsubscribe = useUIStore.subscribe((state) => {
      // Skip if we're currently applying a route
      if (isApplyingRouteRef.current) {
        return;
      }

      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;

      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;

      if (settingsOpenChanged || settingsPathChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  // Listen for browser back/forward navigation
  React.useEffect(() => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    const handlePopState = () => {
      // Parse the new URL and apply it
      const route = parseRoute();

      // An empty route also supersedes pending startup and closes settings.
      void applyRoute(route);
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isVSCode]);
}
