import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { openGuestPanelFromRoute } from '@/lib/router/openGuestPanelFromRoute';
import { openBotsFromRoute } from '@/lib/router/openBotsFromRoute';
import { getBotsRuntime } from '@/lib/botsRuntime';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
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
export function useRouter(openMobileBots?: () => void): void {
  const isVSCode = React.useMemo(() => isVSCodeContext(), []);

  // Track initialization to avoid duplicate applies
  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);
  const routeGenerationRef = React.useRef(0);

  // Get store actions (stable references)
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  React.useEffect(() => subscribeRuntimeEndpointWillChange(({ runtimeKey, previousRuntimeKey }) => {
    if (runtimeKey === previousRuntimeKey) return;
    routeGenerationRef.current += 1;
    isApplyingRouteRef.current = false;
    useUIStore.getState().setBotsPageOpen(false);
  }), []);

  /**
   * Apply a parsed route state to the application stores.
   */
  const applyRoute = React.useCallback(
    async (route: RouteState) => {
      const generation = ++routeGenerationRef.current;
      const runtime = getBotsRuntime();
      isApplyingRouteRef.current = true;

      try {
        // Item links do not depend on a stage session or its async bootstrap.
        if (route.botsTarget) {
          if (!isVSCode) openBotsFromRoute(route.botsTarget, openMobileBots);
          return true;
        }

        // 1. Apply session first (may trigger async operations); a message
        // link also asks the session's timeline to show that message.
        if (route.sessionId) {
          await openSessionLink(route.sessionId, route.messageId);
          if (runtime.signal.aborted || generation !== routeGenerationRef.current) return false;
        }

        // 2. Handle settings first because it is a full-screen overlay.
        if (route.settingsPath) {
          setSettingsPage(resolveSettingsSlug(route.settingsPath));
          setSettingsDialogOpen(true);
          // Do not process a route view while settings is open.
          return true;
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

        // 5. Reveal a guest's panel named by a browser-help deep link
        // (?session=...&panel=<guestId>), once the session's directory is
        // known. Unknown/disabled guests and runtimes with no guest panel
        // (VS Code, mobile) are handled inside openGuestPanelFromRoute.
        if (route.guestPanelId) {
          const directory = useDirectoryStore.getState().currentDirectory;
          if (directory) {
            await openGuestPanelFromRoute(directory, route.guestPanelId);
          }
        }
        return !runtime.signal.aborted && generation === routeGenerationRef.current;
      } finally {
        if (generation === routeGenerationRef.current) isApplyingRouteRef.current = false;
      }
    },
    [setSettingsDialogOpen, setSettingsPage, navigateToDiff, isVSCode, openMobileBots]
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

    // Apply the initial route
    const initializeRoute = async () => {
      const runtime = getBotsRuntime();
      const applied = await applyRoute(route);
      if (!applied || runtime.signal.aborted) return;

      // After applying, update URL to normalized form (use replaceState).
      // Use the parsed route values instead of an immediate store snapshot so
      // deep links do not briefly normalize `?session=...` back to `/` while
      // the session's directory/message bootstrap is still catching up.
      if (!isVSCode) {
        updateBrowserURL({
          ...getCurrentAppState(),
          sessionId: route.botsTarget ? useSessionUIStore.getState().currentSessionId : route.sessionId ?? useSessionUIStore.getState().currentSessionId,
          settingsPath: route.settingsPath ?? useUIStore.getState().settingsPage,
        }, { replace: true, force: true });
      }
    };

    void initializeRoute();
  }, [applyRoute, getCurrentAppState, isVSCode, syncURLFromState]);

  // Subscribe to session changes
  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSessionId: string | null = useSessionUIStore.getState().currentSessionId;

    const unsubscribe = useSessionUIStore.subscribe((state) => {
      const sessionId = state.currentSessionId;

      // Skip if no change or if we're currently applying a route
      if (sessionId === prevSessionId || isApplyingRouteRef.current) {
        return;
      }

      prevSessionId = sessionId;
      syncURLFromState();
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

      // Check if this is a route with any params, or if we should restore defaults
      if (hasRouteParams()) {
        void applyRoute(route);
      } else {
        // URL has no route params - this might be a "back to home" navigation
        // Close settings if open, keep current session
        const uiState = useUIStore.getState();
        if (uiState.isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isVSCode, setSettingsDialogOpen]);
}
