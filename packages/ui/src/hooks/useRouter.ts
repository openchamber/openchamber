import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import type { RouteState, AppRouteState } from '@/lib/router';
import type { WorkspaceSurface } from '@/stores/useUIStore';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';

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
 * - Embedded session-chat iframe (`?ocPanel=session-chat`): No URL updates.
 *   The iframe's session identity is fixed at mount (the parent builds the
 *   src with `sessionId`); in-place subtask navigation must NOT rewrite the
 *   URL, otherwise `ocPanel` (and `directory`/`readOnly`) get stripped and
 *   `isEmbeddedSessionChat()` starts returning false, breaking subsequent
 *   "Open subtask" clicks.
 */
export function useRouter(): void {
  const isVSCode = React.useMemo(() => isVSCodeContext(), []);
  // Captured once at mount: the iframe's embedded-ness never changes during
  // its lifetime (a parent src swap is a full reload).
  const isEmbeddedChat = React.useMemo(() => isEmbeddedSessionChat(), []);

  // Track initialization to avoid duplicate applies
  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);

  // Get store actions (stable references)
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setActiveSurface = useUIStore((state) => state.setActiveSurface);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  /**
   * Apply a parsed route state to the application stores.
   */
  const applyRoute = React.useCallback(
    async (route: RouteState) => {
      if (isApplyingRouteRef.current) {
        return;
      }

      isApplyingRouteRef.current = true;

      try {
        // 1. Apply session first (may trigger async operations)
        if (route.sessionId) {
          const currentSessionId = useSessionUIStore.getState().currentSessionId;
          if (route.sessionId !== currentSessionId) {
            const directoryHint = useSessionUIStore.getState().getDirectoryForSession(route.sessionId);
            setCurrentSession(route.sessionId, directoryHint);
          }
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

        // 3. Apply the view selected by the legacy URL parameter.
        if (route.tab) {
          setActiveSurface(route.tab);
        }

        // 4. Apply diff file (only if going to diff tab)
        if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
          navigateToDiff(route.diffFile);
        }
      } finally {
        isApplyingRouteRef.current = false;
      }
    },
    [setCurrentSession, setActiveSurface, setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  /**
   * Get current app state for URL serialization.
   */
  const getCurrentAppState = React.useCallback((): AppRouteState => {
    const sessionState = useSessionUIStore.getState();
    const uiState = useUIStore.getState();

    return {
      sessionId: sessionState.currentSessionId,
      tab: uiState.activeSurface,
      isSettingsOpen: uiState.isSettingsDialogOpen,
      settingsPath: uiState.settingsPage,
      diffFile: uiState.pendingDiffFile,
    };
  }, []);

  /**
   * Sync current app state to URL.
   */
  const syncURLFromState = React.useCallback(
    (options: { replace?: boolean } = {}) => {
      if (isVSCode || isEmbeddedChat || isApplyingRouteRef.current) {
        return;
      }

      const state = getCurrentAppState();
      updateBrowserURL(state, options);
    },
    [isVSCode, isEmbeddedChat, getCurrentAppState]
  );

  // Initialize: parse URL and apply route on mount
  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // Only process if URL has route params
    if (!hasRouteParams()) {
      // No route params - just set up sync (URL will update when user navigates)
      return;
    }

    const route = parseRoute();

    // Apply the initial route
    const initializeRoute = async () => {
      await applyRoute(route);

      // After applying, update URL to normalized form (use replaceState).
      // Use the parsed route values instead of an immediate store snapshot so
      // deep links do not briefly normalize `?session=...` back to `/` while
      // the session's directory/message bootstrap is still catching up.
      if (!isVSCode && !isEmbeddedChat) {
        updateBrowserURL({
          ...getCurrentAppState(),
          sessionId: route.sessionId ?? useSessionUIStore.getState().currentSessionId,
          tab: route.tab ?? useUIStore.getState().activeSurface,
          settingsPath: route.settingsPath ?? useUIStore.getState().settingsPage,
          diffFile: route.diffFile ?? useUIStore.getState().pendingDiffFile,
        }, { replace: true, force: true });
      }
    };

    void initializeRoute();
  }, [applyRoute, getCurrentAppState, isVSCode, isEmbeddedChat]);

  // Subscribe to session changes
  React.useEffect(() => {
    if (isVSCode || isEmbeddedChat) {
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
  }, [isVSCode, isEmbeddedChat, syncURLFromState]);

  // Subscribe to UI store changes (view, settings)
  React.useEffect(() => {
    if (isVSCode || isEmbeddedChat) {
      return;
    }

    let prevSurface: WorkspaceSurface = useUIStore.getState().activeSurface;
    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;
    let prevDiffFile: string | null = useUIStore.getState().pendingDiffFile;

    const unsubscribe = useUIStore.subscribe((state) => {
      // Skip if we're currently applying a route
      if (isApplyingRouteRef.current) {
        return;
      }

      const surfaceChanged = state.activeSurface !== prevSurface;
      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;
      const diffFileChanged = state.pendingDiffFile !== prevDiffFile && state.activeSurface === 'diff';

      // Update tracking vars
      prevSurface = state.activeSurface;
      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;
      prevDiffFile = state.pendingDiffFile;

      // Only sync if something relevant changed
      if (surfaceChanged || settingsOpenChanged || settingsPathChanged || diffFileChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [isVSCode, isEmbeddedChat, syncURLFromState]);

  // Listen for browser back/forward navigation
  React.useEffect(() => {
    if (typeof window === 'undefined' || isVSCode || isEmbeddedChat) {
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
        // Reset to chat when no route view is specified.
        if (uiState.activeSurface !== 'chat') {
          setActiveSurface('chat');
        }
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isVSCode, isEmbeddedChat, setActiveSurface, setSettingsDialogOpen]);
}
