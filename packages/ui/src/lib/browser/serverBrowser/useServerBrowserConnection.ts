/**
 * Polls and drives the built-in server browser's dock state for one chat.
 *
 * The service keeps exactly one scope "selected" at a time — whichever chat's
 * tab is being mirrored over the shared surface — and gates every dock
 * command (navigate, back, tabs, viewport…) on a `generation` the caller must
 * have last read from `state`, so a command built from a picture of an
 * earlier view is refused rather than landing somewhere unexpected. This hook
 * keeps that generation current and exposes one `act` wrapper so callers
 * never have to thread it through by hand.
 */
import React from 'react';

import { useSessionUIStore } from '@/sync/session-ui-store';

import {
  answerServerBrowserDialog,
  answerServerBrowserFileChooser,
  answerServerBrowserProfileRequest,
  captureServerBrowserPage,
  clearServerBrowserData,
  closeServerBrowserScope,
  evaluateServerBrowserPage,
  getServerBrowserState,
  goServerBrowserBack,
  goServerBrowserForward,
  navigateServerBrowser,
  newServerBrowserTab,
  closeServerBrowserTab,
  openServerBrowserScope,
  reloadServerBrowser,
  selectServerBrowserScope,
  selectServerBrowserTab,
  setServerBrowserViewer,
  setServerBrowserViewport,
  setServerBrowserZoom,
  setServerBrowserColorScheme,
  stopServerBrowser,
  type ServerBrowserCapture,
  type ServerBrowserResult,
} from './client';
import { findSelectedScope, type ServerBrowserScope, type ServerBrowserState } from './types';

const POLL_MS = 2_000;
const STATE_WAIT_MS = 15_000;
const POLL_MS_HIDDEN = 10_000;

type ServerBrowserConnection = {
  readonly state: ServerBrowserState | null;
  readonly scope: ServerBrowserScope | null;
  readonly sessionId: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly navigate: (url: string) => Promise<ServerBrowserState | null>;
  readonly back: () => Promise<ServerBrowserState | null>;
  readonly forward: () => Promise<ServerBrowserState | null>;
  readonly reload: () => Promise<ServerBrowserState | null>;
  readonly stop: () => Promise<ServerBrowserState | null>;
  /** Resolves to the state after the tab opened (its active tab is the new one), or null on failure. */
  readonly newTab: () => Promise<ServerBrowserState | null>;
  readonly selectTab: (tabId: string) => Promise<ServerBrowserState | null>;
  readonly closeTab: (tabId: string) => Promise<ServerBrowserState | null>;
  readonly setViewport: (viewport: { mode: 'auto' | 'fixed'; mobile: boolean; width?: number; height?: number }) => Promise<ServerBrowserState | null>;
  readonly setZoom: (level: number) => Promise<ServerBrowserState | null>;
  readonly setColorScheme: (scheme: 'system' | 'light' | 'dark') => Promise<ServerBrowserState | null>;
  readonly clearData: (what: 'cookies' | 'cache') => Promise<ServerBrowserState | null>;
  readonly selectScope: (scopeId: string) => Promise<ServerBrowserState | null>;
  readonly closeScope: (scopeId: string) => Promise<ServerBrowserState | null>;
  readonly evaluate: (expression: string, userGesture?: boolean) => Promise<unknown>;
  readonly capture: () => Promise<ServerBrowserCapture | null>;
  /** Resolve to null when the answer was refused (the dialog or request is gone, someone else is in control). */
  readonly answerDialog: (answer: { tabId: string; dialogId: number; accept: boolean; promptText?: string }) => Promise<ServerBrowserState | null>;
  readonly answerFileChooser: (answer: { tabId: string; chooserId: number; files: readonly string[] | null }) => Promise<ServerBrowserState | null>;
  readonly answerProfileRequest: (approve: boolean) => Promise<ServerBrowserState | null>;
};

export const useServerBrowserConnection = (
  guestId: string,
  directory: string,
  viewerId: string | undefined,
  /** False for a panel tab in the background: it neither opens the scope nor polls. */
  enabled = true,
  /** A profile being signed into from Settings: show its sign-in browser instead of the chat's. */
  signInProfileId: string | null = null,
): ServerBrowserConnection => {
  const sessionId = useSessionUIStore((storeState) => storeState.currentSessionId);
  const [state, setState] = React.useState<ServerBrowserState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);
  const stateRef = React.useRef<ServerBrowserState | null>(null);
  // The service shows another chat's browser (an agent of that chat started
  // it first, the service restarted, another window picked it): this chat's
  // is opened again, so a chat never shows another's pages.
  const [reopenRequest, setReopenRequest] = React.useState(0);
  const selectedSessionId = findSelectedScope(state)?.sessionId;
  const showsOtherChat = Boolean(sessionId && !signInProfileId && state && !loading
    && selectedSessionId !== undefined && selectedSessionId !== sessionId
    && !findSelectedScope(state)?.signIn);
  const lastReopenRef = React.useRef(0);
  React.useEffect(() => {
    if (!showsOtherChat) return undefined;
    // At most every 2 s, so two windows on two chats do not take the view
    // from each other in a tight loop.
    const wait = Math.max(0, lastReopenRef.current + 2_000 - Date.now());
    const timer = setTimeout(() => {
      lastReopenRef.current = Date.now();
      setReopenRequest((value) => value + 1);
    }, wait);
    return () => clearTimeout(timer);
  }, [showsOtherChat]);

  const applyState = React.useCallback((next: ServerBrowserState) => {
    // A held request that timed out returns the same state; nothing to render.
    if (next.version && next.version === stateRef.current?.version) return;
    stateRef.current = next;
    generationRef.current = next.generation;
    setState(next);
    setError(null);
  }, []);

  const act = React.useCallback(async (
    fn: (generation: number) => Promise<ServerBrowserResult<ServerBrowserState>>,
  ): Promise<ServerBrowserState | null> => {
    let result = await fn(generationRef.current);
    // The view moved on since our last poll (another tab, the agent): catch
    // up and try once more instead of dropping the click.
    if (!result.ok && /view changed/i.test(result.error)) {
      const current = await getServerBrowserState(guestId, viewerId);
      if (current.ok) {
        applyState(current.data);
        result = await fn(current.data.generation);
      }
    }
    if (result.ok) {
      applyState(result.data);
      return result.data;
    }
    setError(result.error);
    return null;
  }, [applyState, guestId, viewerId]);

  const refresh = React.useCallback(async (): Promise<void> => {
    const result = await getServerBrowserState(guestId, viewerId);
    if (result.ok) {
      applyState(result.data);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, [applyState, guestId, viewerId]);

  // Attaches this chat's scope (creating it if needed) and brings it to the
  // front of the shared surface. Re-runs when the current chat changes, so
  // switching chats while the panel is open follows the switch.
  React.useEffect(() => {
    if (!enabled || viewerId === undefined) return;
    if (signInProfileId) {
      let cancelled = false;
      void (async () => {
        const current = await getServerBrowserState(guestId, viewerId);
        if (cancelled || !current.ok) { setLoading(false); return; }
        applyState(current.data);
        const signInScope = current.data.scopes.find((entry) => entry.directory === `profile:${signInProfileId}`);
        if (signInScope && current.data.selectedScopeId !== signInScope.id) {
          const selected = await selectServerBrowserScope(guestId, viewerId, { scopeId: signInScope.id, generation: current.data.generation });
          if (!cancelled && selected.ok) applyState(selected.data);
        }
        if (!cancelled) setLoading(false);
      })();
      return () => { cancelled = true; };
    }
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      // The generation guards against acting on a view that changed; a panel
      // that just mounted has none yet, so it reads the current one first.
      // One retry covers a change that lands between the read and the open.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await getServerBrowserState(guestId, viewerId);
        if (cancelled) return;
        if (current.ok) applyState(current.data);
        const result = await openServerBrowserScope(guestId, viewerId, {
          directory,
          sessionId,
          generation: generationRef.current,
        });
        if (cancelled) return;
        if (result.ok) {
          applyState(result.data);
          break;
        }
        setError(result.error);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [applyState, directory, enabled, guestId, reopenRequest, sessionId, signInProfileId, viewerId]);

  // Tells the service our pixel ratio once a viewer is attached, so a
  // high-DPI client gets crisp frames from the start.
  React.useEffect(() => {
    if (!enabled || viewerId === undefined) return;
    void setServerBrowserViewer(guestId, viewerId, { devicePixelRatio: window.devicePixelRatio || 1 })
      .then((result) => { if (result.ok) applyState(result.data); });
  }, [applyState, enabled, guestId, viewerId]);

  React.useEffect(() => {
    if (!enabled || viewerId === undefined) return;
    let disposed = false;
    // Held requests: the service answers as soon as the state changes, so
    // the address bar, tabs, and loading state follow the page at once. A
    // hidden window or a failed request falls back to a slow poll.
    const tick = async () => {
      if (disposed) return;
      const since = stateRef.current?.version;
      const visible = document.visibilityState !== 'hidden';
      const result = await getServerBrowserState(guestId, viewerId, since && visible ? { since, waitMs: STATE_WAIT_MS } : undefined);
      if (!disposed && result.ok) applyState(result.data);
      if (disposed) return;
      const delay = !visible ? POLL_MS_HIDDEN : result.ok && result.data.version ? 0 : POLL_MS;
      timer = setTimeout(tick, delay);
    };
    let timer = setTimeout(tick, 0);
    return () => { disposed = true; clearTimeout(timer); };
  }, [applyState, enabled, guestId, viewerId]);

  const scope = React.useMemo(() => findSelectedScope(state), [state]);

  return {
    state,
    scope,
    sessionId,
    loading,
    error,
    refresh,
    navigate: (url) => act((generation) => navigateServerBrowser(guestId, viewerId, { url, generation })),
    back: () => act((generation) => goServerBrowserBack(guestId, viewerId, generation)),
    forward: () => act((generation) => goServerBrowserForward(guestId, viewerId, generation)),
    reload: () => act((generation) => reloadServerBrowser(guestId, viewerId, generation)),
    stop: () => act((generation) => stopServerBrowser(guestId, viewerId, generation)),
    newTab: () => act((generation) => newServerBrowserTab(guestId, viewerId, { generation })),
    selectTab: (tabId) => act((generation) => selectServerBrowserTab(guestId, viewerId, { generation, tabId })),
    closeTab: (tabId) => act((generation) => closeServerBrowserTab(guestId, viewerId, { generation, tabId })),
    setViewport: (viewport) => act((generation) => setServerBrowserViewport(guestId, viewerId, { generation, ...viewport })),
    setZoom: (level) => act((generation) => setServerBrowserZoom(guestId, viewerId, { generation, level })),
    setColorScheme: (scheme) => act((generation) => setServerBrowserColorScheme(guestId, viewerId, { generation, scheme })),
    clearData: (what) => act((generation) => clearServerBrowserData(guestId, viewerId, { generation, what })),
    selectScope: (scopeId) => act((generation) => selectServerBrowserScope(guestId, viewerId, { scopeId, generation })),
    closeScope: (scopeId) => act((generation) => closeServerBrowserScope(guestId, viewerId, { scopeId, generation })),
    evaluate: async (expression, userGesture) => {
      const result = await evaluateServerBrowserPage(guestId, viewerId, {
        generation: generationRef.current,
        expression,
        userGesture,
      });
      if (!result.ok) throw new Error(result.error);
      return result.data.value;
    },
    capture: async () => {
      const result = await captureServerBrowserPage(guestId, viewerId, { generation: generationRef.current });
      return result.ok ? result.data : null;
    },
    // A dialog or file request is named by its own ids, so these need no generation.
    answerDialog: (answer) => act(() => answerServerBrowserDialog(guestId, viewerId, answer)),
    answerFileChooser: ({ tabId, chooserId, files }) => act(() => answerServerBrowserFileChooser(
      guestId,
      viewerId,
      files === null ? { tabId, chooserId, cancel: true } : { tabId, chooserId, files },
    )),
    answerProfileRequest: (approve) => act(() => answerServerBrowserProfileRequest(guestId, viewerId, approve)),
  };
};
