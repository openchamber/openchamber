import React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useZoneInteractive } from '@/components/layout/zoneInteractiveContext';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { BLANK_URL, normalizeBrowserUrl } from '@/lib/browser/url';
import {
  cancelAnnotationSession,
  runAnnotationSession,
  type AnnotationHost,
  type PageCapture,
} from '@/lib/browser/annotationSession';
import { resolveAnnotationOverlayTheme } from '@/lib/browser/overlayTheme';
import { suggestFromHistory } from '@/lib/browser/history';
import { selectBrowserHistory, useBrowserHistoryStore } from '@/stores/useBrowserHistoryStore';
import { useBrowserFaviconStore } from '@/stores/useBrowserFaviconStore';
import { toDisplayUrl } from '@/lib/browser/devTunnel';
import { FILL_VIEWPORT, VIEWPORT_PRESETS, type BrowserViewport } from '@/lib/browser/viewport';
import {
  closeServerBrowserProfile,
  closeServerBrowserTab,
  getServerBrowserState,
} from '@/lib/browser/serverBrowser/client';
import {
  claimedChromeTab,
  panelTabsByChromeTab,
  unclaimedChromeTabs,
  useServerBrowserAgentTab,
  useServerBrowserPanelTabs,
  useServerBrowserSignIn,
} from '@/lib/browser/serverBrowser/panelTabs';
import {
  findSelectedScope,
  type ServerBrowserDownload,
  type ServerBrowserScope,
  type ServerBrowserState,
  type ServerBrowserViewportState,
} from '@/lib/browser/serverBrowser/types';
import { supportsSurfaceAudio } from '@/lib/guests/surface-audio';
import { isFollowingBrowserAgent, useUIStore } from '@/stores/useUIStore';
import { getSurfaceViewerId } from '@/lib/guests/surface-viewers';
import { useServerBrowserConnection } from '@/lib/browser/serverBrowser/useServerBrowserConnection';
import type { SurfaceConnectionState, SurfaceControlState } from '@/lib/guests/surface-client';

import { BrowserToolbar } from './BrowserToolbar';
import { BrowserDeviceBar } from './BrowserDeviceBar';
import { BrowserEmptyState } from './BrowserEmptyState';
import { useAnnotationAttach, useAnnotationOverlayLabels } from './useAnnotationAttach';
import { ServerBrowserCanvas, type ServerBrowserCanvasHandle } from './ServerBrowserCanvas';
import { ServerBrowserBanners } from './ServerBrowserBanners';
import { ServerBrowserInspector } from './ServerBrowserInspector';
import { ServerBrowserDialogCard, ServerBrowserFileChooserCard } from './ServerBrowserPageRequests';

type ServerBrowserViewProps = {
  guestId: string;
  directory: string;
  /** The Browser panel tab in front, which shows one Chrome tab of the chat; null when no Browser tab is. */
  tabID: string | null;
};

type LiveViewProps = { guestId: string; directory: string; tabID: string };

const ZOOM_MIN = -5;
const ZOOM_MAX = 5;

/** Mobile-sized presets get `mobile: true` so the service's layout matches what the picker promises. */
const MOBILE_PRESET_IDS = new Set(['iphone-se', 'iphone-14', 'iphone-14-pro-max', 'pixel-7', 'ipad-mini', 'ipad-pro']);

const toServiceViewport = (viewport: BrowserViewport): { mode: 'auto' | 'fixed'; mobile: boolean; width?: number; height?: number } => {
  if (viewport.kind === 'fill') return { mode: 'auto', mobile: false };
  const mobile = viewport.kind === 'preset' && MOBILE_PRESET_IDS.has(viewport.id);
  return { mode: 'fixed', mobile, width: viewport.width, height: viewport.height };
};

/** The device bar shows the size the chat's page really has, which the agent may have chosen. */
const fromServiceViewport = (viewport: ServerBrowserViewportState | null | undefined): BrowserViewport => {
  if (!viewport || viewport.mode === 'auto') return FILL_VIEWPORT;
  const preset = VIEWPORT_PRESETS.find((entry) => entry.width === viewport.width && entry.height === viewport.height);
  return preset
    ? { kind: 'preset', id: preset.id, width: preset.width, height: preset.height }
    : { kind: 'custom', width: viewport.width, height: viewport.height };
};

/**
 * Server-engine counterpart to `WebviewBrowser`/`IframeBrowser` in
 * `BrowserPane.tsx`: same toolbar, tabs, annotation, and control UI, driven
 * by the built-in server browser's dock HTTP API instead of a local
 * `<webview>`. The page picture itself comes from the shared-surface
 * protocol (`ServerBrowserCanvas` / `SurfaceClient`), which is also what
 * extension rail panels use — this view never talks to Chrome directly.
 */
const panelTabExists = (tabID: string): boolean => Object.values(useUIStore.getState().contextPanelByDirectory)
  .some((panel) => panel?.tabs.some((tab) => tab.id === tabID) || panel?.parkedBrowserTabs?.some((tab) => tab.id === tabID));

const closeChromeTabsOfPanelTab = async (guestId: string, tabID: string): Promise<void> => {
  if (panelTabExists(tabID)) return;
  const { claims, release } = useServerBrowserPanelTabs.getState();
  const owned = Object.entries(claims)
    .map(([key, chromeTabId]) => {
      const [scopeId, panelTabId] = key.split('\u0000');
      return { scopeId, panelTabId, chromeTabId };
    })
    .filter((entry) => entry.panelTabId === tabID);
  if (owned.length === 0) return;
  // As this window's viewer: it may hold control, and the service refuses
  // dock commands from anyone else while it does.
  const viewerId = getSurfaceViewerId(guestId);
  try {
    const current = await getServerBrowserState(guestId, viewerId);
    if (!current.ok) return;
    const scope = findSelectedScope(current.data);
    let generation = current.data.generation;
    for (const entry of owned) {
      if (!scope || scope.id !== entry.scopeId || !scope.tabs.some((tab) => tab.id === entry.chromeTabId)) continue;
      const closed = await closeServerBrowserTab(guestId, viewerId, { generation, tabId: entry.chromeTabId });
      if (closed.ok) generation = closed.data.generation;
    }
  } finally {
    // Released only now: while the claim stands, the open Chrome tab is not
    // "unclaimed", so it does not get a panel tab of its own again.
    for (const entry of owned) release(entry.scopeId, entry.panelTabId);
  }
};

/**
 * Closing a Browser panel tab closes the Chrome tab it showed. Watches the
 * panel's tabs rather than a view's unmount: one view serves every tab.
 */
const useCloseChromeTabsOfClosedPanelTabs = (guestId: string): void => {
  React.useEffect(() => {
    // A tab of another chat, put aside while this one is on screen, is still open.
    const browserTabIds = (state: ReturnType<typeof useUIStore.getState>) => new Set(
      Object.values(state.contextPanelByDirectory).flatMap((panel) => [...(panel?.tabs ?? []), ...(panel?.parkedBrowserTabs ?? [])]
        .filter((tab) => tab.mode === 'browser')
        .map((tab) => tab.id)),
    );
    let previous = browserTabIds(useUIStore.getState());
    return useUIStore.subscribe((state) => {
      const current = browserTabIds(state);
      for (const id of previous) {
        if (!current.has(id)) void closeChromeTabsOfPanelTab(guestId, id);
      }
      previous = current;
    });
  }, [guestId]);
};

export const ServerBrowserView: React.FC<ServerBrowserViewProps> = ({ guestId, directory, tabID }) => {
  useCloseChromeTabsOfClosedPanelTabs(guestId);
  if (!tabID) return null;
  return <ServerBrowserLiveView guestId={guestId} directory={directory} tabID={tabID} />;
};

// Each dock request must answer within the host proxy's 20 s, but the
// annotation script resolves only when the person finishes. So the promise is
// started in the page and its result fetched by short requests that each wait
// up to HELD_POLL_MS inside the page. `code` must be an expression.
const HELD_POLL_MS = 8_000;
let heldSequence = 0;

const evaluateHeld = async (
  evaluate: (expression: string, userGesture?: boolean) => Promise<unknown>,
  code: string,
  userGesture?: boolean,
): Promise<unknown> => {
  heldSequence += 1;
  const key = JSON.stringify(`${Date.now()}-${heldSequence}`);
  // Callers pass a statement-like expression, possibly ending in `;`.
  const expression = code.trim().replace(/;+\s*$/, '');
  await evaluate(`(() => {
    const store = (window.__openchamberHeld ||= {});
    const slot = store[${key}] = { done: false, value: null, error: null, wake: [] };
    const finish = () => { slot.done = true; for (const wake of slot.wake.splice(0)) wake(); };
    Promise.resolve((
${expression}
)).then((value) => { slot.value = value ?? null; finish(); }, (error) => { slot.error = String(error && error.message || error); finish(); });
    return true;
  })()`, userGesture);
  for (;;) {
    const result = await evaluate(`(async () => {
      const slot = window.__openchamberHeld && window.__openchamberHeld[${key}];
      if (!slot) return { gone: true };
      if (!slot.done) await new Promise((resolve) => { slot.wake.push(resolve); setTimeout(resolve, ${HELD_POLL_MS}); });
      if (!slot.done) return { pending: true };
      delete window.__openchamberHeld[${key}];
      return { done: true, value: slot.value, error: slot.error };
    })()`) as { gone?: boolean; pending?: boolean; value?: unknown; error?: string | null } | null;
    // The page navigated away: whatever the script was doing went with it.
    if (!result || result.gone) return null;
    if (result.pending) continue;
    if (result.error) throw new Error(result.error);
    return result.value ?? null;
  }
};

const activeChromeTabOf = (state: ServerBrowserState | null): string | null => (
  findSelectedScope(state)?.tabs.find((tab) => tab.active)?.id ?? null
);

const joinServerPath = (directory: string, name: string): string => `${directory.replace(/[\\/]+$/, '')}/${name}`;

/** Recent downloads shown in the ⋯ menu. */
const DOWNLOADS_IN_MENU = 5;

/**
 * Files the chat's pages download stay on the server, where the agent finds
 * them; each one that finishes is offered to the person to save on this
 * device, and the recent ones stay in the ⋯ menu.
 */
const useServerBrowserDownloads = (scope: ServerBrowserScope | null) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const downloads = scope?.downloads;
  const directory = scope?.directory;
  const save = React.useCallback((download: ServerBrowserDownload) => {
    if (!download.path || !files.downloadFile) return;
    // A browser with no project (signing into a profile) keeps its downloads outside every workspace.
    void files.downloadFile(download.path, { directory, allowOutsideWorkspace: true }).catch(() => {
      toast.error(t('contextPanel.browser.server.downloads.saveFailed', { name: download.name }));
    });
  }, [directory, files, t]);

  // Only what finishes while the panel is open is announced, not what was there before.
  const announcedRef = React.useRef<{ scopeId: string; ids: Set<string> } | null>(null);
  React.useEffect(() => {
    if (!scope || !downloads) return;
    const complete = downloads.filter((download) => download.state === 'complete' && download.path);
    if (announcedRef.current?.scopeId !== scope.id) {
      announcedRef.current = { scopeId: scope.id, ids: new Set(complete.map((download) => download.id)) };
      return;
    }
    const announced = announcedRef.current.ids;
    for (const download of complete) {
      if (announced.has(download.id)) continue;
      announced.add(download.id);
      toast.success(t('contextPanel.browser.server.downloads.done', { name: download.name }), {
        action: files.downloadFile
          ? { label: t('contextPanel.browser.server.downloads.save'), onClick: () => save(download) }
          : undefined,
      });
    }
  }, [downloads, files.downloadFile, save, scope, t]);

  return React.useMemo(() => (downloads ?? [])
    .filter((download) => download.state === 'complete' || download.state === 'downloading')
    .slice(0, DOWNLOADS_IN_MENU)
    .map((download) => {
      if (download.state === 'complete') {
        return {
          kind: 'item' as const,
          id: `download-${download.id}`,
          icon: 'download' as const,
          label: t('contextPanel.browser.server.downloads.saveItem', { name: download.name }),
          onSelect: () => save(download),
          disabled: !files.downloadFile || !download.path,
        };
      }
      const percent = download.totalBytes ? Math.min(99, Math.floor((download.receivedBytes / download.totalBytes) * 100)) : null;
      return {
        kind: 'item' as const,
        id: `download-${download.id}`,
        icon: 'download' as const,
        label: percent === null
          ? t('contextPanel.browser.server.downloads.downloading', { name: download.name })
          : t('contextPanel.browser.server.downloads.progress', { name: download.name, percent }),
        onSelect: () => undefined,
        disabled: true,
      };
    }), [downloads, files.downloadFile, save, t]);
};

const ServerBrowserLiveView: React.FC<LiveViewProps> = ({ guestId, directory, tabID }) => {
  const { t } = useI18n();
  const visible = useZoneInteractive();
  const { currentTheme } = useThemeSystem();
  const canvasHandleRef = React.useRef<ServerBrowserCanvasHandle | null>(null);

  const [viewerId, setViewerId] = React.useState<string | undefined>(undefined);
  const [control, setControl] = React.useState<SurfaceControlState>({ controller: 'none', mine: false });
  const [connection, setConnection] = React.useState<SurfaceConnectionState>({ status: 'connecting' });
  const [canvasFocused, setCanvasFocused] = React.useState(false);

  const signIn = useServerBrowserSignIn((store) => store.signIn);
  const setSignIn = useServerBrowserSignIn((store) => store.setSignIn);
  const serverBrowser = useServerBrowserConnection(guestId, directory, viewerId, true, signIn?.profileId ?? null);
  const { state } = serverBrowser;
  // Right after a chat switch the service still shows the previous chat's
  // browser until this chat's opens. Nothing of it is paired, shown as this
  // chat's, or closed from here, so no tab of one chat lands in another's.
  const scope = serverBrowser.scope && (serverBrowser.scope.signIn || serverBrowser.scope.sessionId === serverBrowser.sessionId)
    ? serverBrowser.scope
    : null;

  // ---- this panel tab <-> one Chrome tab of the chat ----------------------
  const claims = useServerBrowserPanelTabs((store) => store.claims);
  const claim = useServerBrowserPanelTabs((store) => store.claim);
  const release = useServerBrowserPanelTabs((store) => store.release);
  const openAgentBrowserTab = useUIStore((store) => store.openAgentBrowserTab);
  const closeContextPanelTabs = useUIStore((store) => store.closeContextPanelTabs);
  const setContextPanelTabTargetPath = useUIStore((store) => store.setContextPanelTabTargetPath);
  const setActiveContextPanelTab = useUIStore((store) => store.setActiveContextPanelTab);
  const panelTabs = useUIStore((store) => store.contextPanelByDirectory[directory]?.tabs);
  const myChromeTab = scope ? claimedChromeTab(claims, scope.id, tabID) : null;
  const pairingRef = React.useRef(false);
  const tabsSignature = scope ? scope.tabs.map((tab) => `${tab.id}:${tab.active ? 1 : 0}`).join(',') : '';

  React.useEffect(() => {
    if (signIn || !scope || pairingRef.current) return;
    const mine = myChromeTab ? scope.tabs.find((tab) => tab.id === myChromeTab) : undefined;
    if (mine) {
      if (!mine.active) {
        pairingRef.current = true;
        void serverBrowser.selectTab(mine.id).finally(() => { pairingRef.current = false; });
      }
      return;
    }
    if (myChromeTab) {
      release(scope.id, tabID);
      // The Chrome tab this panel tab showed closed (the agent's browser.close,
      // a popup that finished) while other panel tabs still show live ones:
      // this panel tab closes with it, as the effect below does for tabs out
      // of sight. After a browser restart every claim is stale, so the panel
      // tab claims one of the reopened tabs below.
      const liveIds = new Set(scope.tabs.map((tab) => tab.id));
      const othersLive = [...panelTabsByChromeTab(claims, scope.id)]
        .some(([chromeTabId, panelTabId]) => panelTabId !== tabID && liveIds.has(chromeTabId));
      if (othersLive) {
        closeContextPanelTabs(directory, [tabID]);
        return;
      }
    }
    const free = unclaimedChromeTabs(claims, scope);
    const activeFree = scope.tabs.find((tab) => tab.active && free.includes(tab.id))?.id;
    const pick = activeFree ?? free[0];
    if (pick) {
      claim(scope.id, tabID, pick);
      return;
    }
    // No tab yet: the picture's first request opens the first page, which
    // this panel tab then claims. Opening another here would make two.
    if (scope.tabs.length === 0) return;
    // Every Chrome tab already has a panel tab: this one is new, so it gets
    // a new Chrome tab, which opens blank on the dev-server list.
    pairingRef.current = true;
    void serverBrowser.newTab().then((next) => {
      const opened = activeChromeTabOf(next);
      const nextScope = findSelectedScope(next);
      if (opened && nextScope) claim(nextScope.id, tabID, opened);
    }).finally(() => { pairingRef.current = false; });
    // `scope` changes identity on every poll; the signature is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.id, tabsSignature, myChromeTab, claims, tabID, signIn]);

  // Chrome tabs the page or the agent opened get panel tabs of their own,
  // first reusing panel tabs that show nothing yet (after a reload), and a
  // claimed Chrome tab that closed (a popup that finished) takes its panel
  // tab with it.
  React.useEffect(() => {
    // Only once this panel tab shows a live Chrome tab: a claim left over from
    // a browser that restarted would make the free tab look like a new one.
    if (signIn || !scope || !myChromeTab || pairingRef.current || !scope.tabs.some((tab) => tab.id === myChromeTab)) return;
    const browserPanelTabs = (panelTabs ?? []).filter((tab) => tab.mode === 'browser');
    const byChromeTab = panelTabsByChromeTab(claims, scope.id);
    const liveIds = new Set(scope.tabs.map((tab) => tab.id));
    const stale = [...byChromeTab.entries()].filter(([chromeTabId, panelTabId]) => !liveIds.has(chromeTabId) && panelTabId !== tabID);
    const anyLive = [...byChromeTab.keys()].some((chromeTabId) => liveIds.has(chromeTabId));
    if (stale.length > 0 && anyLive) {
      for (const [, panelTabId] of stale) release(scope.id, panelTabId);
      closeContextPanelTabs(directory, stale.map(([, panelTabId]) => panelTabId));
    }
    const claimedPanels = new Set(byChromeTab.values());
    const idlePanels = browserPanelTabs.filter((tab) => tab.id !== tabID && !claimedPanels.has(tab.id));
    for (const chromeTabId of unclaimedChromeTabs(claims, scope)) {
      const reuse = idlePanels.shift();
      if (reuse) {
        claim(scope.id, reuse.id, chromeTabId);
        continue;
      }
      const url = scope.tabs.find((tab) => tab.id === chromeTabId)?.url ?? '';
      const panelTabId = openAgentBrowserTab(directory, url === BLANK_URL ? '' : url, scope.sessionId);
      if (panelTabId) claim(scope.id, panelTabId, chromeTabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.id, tabsSignature, myChromeTab, claims, panelTabs, signIn]);

  // Panel tab names follow the page each one shows.
  React.useEffect(() => {
    if (!scope) return;
    for (const [chromeTabId, panelTabId] of panelTabsByChromeTab(claims, scope.id)) {
      const chromeTab = scope.tabs.find((tab) => tab.id === chromeTabId);
      if (!chromeTab) continue;
      const url = chromeTab.url === BLANK_URL ? '' : toDisplayUrl(chromeTab.url);
      const panelTab = panelTabs?.find((tab) => tab.id === panelTabId);
      if (panelTab && (panelTab.targetPath ?? '') !== url) setContextPanelTabTargetPath(directory, panelTabId, url);
    }
  }, [claims, directory, panelTabs, scope, setContextPanelTabTargetPath]);

  // Their icons too: the tab strip finds icons by the origin of the address it shows.
  const putFavicon = useBrowserFaviconStore((store) => store.put);
  React.useEffect(() => {
    for (const chromeTab of scope?.tabs ?? []) {
      if (chromeTab.favicon) putFavicon(toDisplayUrl(chromeTab.url), chromeTab.favicon);
    }
  }, [putFavicon, scope?.tabs]);

  const isSignInScope = Boolean(scope?.directory.startsWith('profile:'));

  // ---- the agent's tab ------------------------------------------------------
  // The panel tab that shows the Chrome tab the agent works in: the strip
  // marks it, and "Follow agent" brings it in front whenever the agent's tab
  // or its activity changes, except while the person drives the page.
  const agentPanelTabId = scope?.agentTabId ? panelTabsByChromeTab(claims, scope.id).get(scope.agentTabId) ?? null : null;
  const agentActing = scope?.agentActive === true;
  const setAgentTab = useServerBrowserAgentTab((store) => store.setAgentTab);
  React.useEffect(() => {
    setAgentTab(agentPanelTabId ? { panelTabId: agentPanelTabId, acting: agentActing } : null);
  }, [agentActing, agentPanelTabId, setAgentTab]);
  React.useEffect(() => () => setAgentTab(null), [setAgentTab]);
  const followAgent = useUIStore((store) => isFollowingBrowserAgent(store.browserFollowAgentOffSessions, scope?.sessionId ?? null));
  const personDrives = control.controller === 'user';
  React.useEffect(() => {
    if (!followAgent || personDrives || !agentPanelTabId || agentPanelTabId === tabID) return;
    setActiveContextPanelTab(directory, agentPanelTabId);
  }, [agentActing, agentPanelTabId, directory, followAgent, personDrives, setActiveContextPanelTab, tabID]);
  // A sign-in browser is not one of this panel's tabs: it is shown as is.
  const showingMine = isSignInScope || Boolean(scope && myChromeTab && scope.tabs.some((tab) => tab.id === myChromeTab && tab.active));

  const closeChatBrowser = React.useCallback(() => {
    if (!scope) return;
    const owned = [...panelTabsByChromeTab(claims, scope.id).values()];
    for (const panelTabId of owned) release(scope.id, panelTabId);
    void serverBrowser.closeScope(scope.id).then(() => {
      const browserPanelIds = (useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [])
        .filter((tab) => tab.mode === 'browser')
        .map((tab) => tab.id);
      closeContextPanelTabs(directory, browserPanelIds);
    });
  }, [claims, closeContextPanelTabs, directory, release, scope, serverBrowser]);

  const [address, setAddress] = React.useState('');
  React.useEffect(() => {
    setAddress(scope ? toDisplayUrl(scope.url) : '');
    // Only the url, not the whole (identity-changing-every-poll) scope object:
    // resyncing on every poll tick would fight whatever the user is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.url]);

  const [showDeviceBar, setShowDeviceBar] = React.useState(false);
  const viewport = fromServiceViewport(scope?.viewport);
  const setFollowAgent = useUIStore((store) => store.setBrowserFollowAgent);
  const [isAnnotating, setIsAnnotating] = React.useState(false);
  const [inspectorOpen, setInspectorOpen] = React.useState(false);
  const [clearConfirm, setClearConfirm] = React.useState<'cookies' | 'cache' | null>(null);
  const [savingSignIn, setSavingSignIn] = React.useState(false);

  const history = useBrowserHistoryStore(selectBrowserHistory(directory));
  const recordHistoryVisit = useBrowserHistoryStore((storeState) => storeState.recordVisit);
  const forgetHistoryVisit = useBrowserHistoryStore((storeState) => storeState.forget);
  const suggestions = React.useMemo(() => suggestFromHistory(history, address), [history, address]);

  const servedUrlRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!scope || scope.isLoading || !scope.url || scope.url === BLANK_URL) return;
    if (servedUrlRef.current === scope.url) return;
    servedUrlRef.current = scope.url;
    recordHistoryVisit(directory, { url: toDisplayUrl(scope.url), title: scope.title });
  }, [directory, recordHistoryVisit, scope]);

  const annotationHost = React.useMemo<AnnotationHost>(() => ({
    executeJavaScript: (code, userGesture) => evaluateHeld(serverBrowser.evaluate, code, userGesture),
    capturePage: async (): Promise<PageCapture | null> => {
      const capture = await serverBrowser.capture();
      return capture ? { mime: capture.mime, base64: capture.base64, width: capture.width, height: capture.height } : null;
    },
  }), [serverBrowser]);

  const attachAnnotation = useAnnotationAttach(directory);
  const overlayLabels = useAnnotationOverlayLabels();

  const handleAnnotate = React.useCallback(() => {
    if (isAnnotating) {
      setIsAnnotating(false);
      void cancelAnnotationSession(annotationHost);
      return;
    }
    if (!scope?.url || scope.url === BLANK_URL) {
      toast.error(t('contextPanel.browser.annotate.noPage'));
      return;
    }
    const theme = resolveAnnotationOverlayTheme(currentTheme.metadata.variant === 'light' ? 'light' : 'dark');
    setIsAnnotating(true);
    void runAnnotationSession({ host: annotationHost, theme, labels: overlayLabels })
      .then(async (result) => {
        setIsAnnotating(false);
        if (!result) return;
        await attachAnnotation(result);
      })
      .catch(() => {
        setIsAnnotating(false);
        toast.error(t('contextPanel.browser.annotate.failed'));
      });
  }, [annotationHost, attachAnnotation, currentTheme, isAnnotating, overlayLabels, scope?.url, t]);

  // An annotation belongs to the page it started on; another tab ends it.
  const annotatingRef = React.useRef(isAnnotating);
  annotatingRef.current = isAnnotating;
  React.useEffect(() => {
    if (!annotatingRef.current) return;
    setIsAnnotating(false);
    void cancelAnnotationSession(annotationHost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabID]);

  const handleSaveSignIn = React.useCallback(() => {
    const profileId = scope?.profile?.id;
    if (!profileId) return;
    setSavingSignIn(true);
    void closeServerBrowserProfile(guestId, viewerId, { id: profileId })
      .then((result) => {
        if (result.ok) {
          toast.success(t('contextPanel.browser.server.help.saveSignInSuccess'));
          // Back to this chat's own browser.
          if (signIn?.profileId === profileId) setSignIn(null);
          void serverBrowser.refresh();
        } else {
          toast.error(t('contextPanel.browser.server.help.saveSignInFailed'));
        }
      })
      .finally(() => setSavingSignIn(false));
  }, [guestId, scope?.profile?.id, serverBrowser, setSignIn, signIn?.profileId, t, viewerId]);

  // Leaves without saving: the sign-in browser closes and the profile keeps
  // what it had.
  const cancelSignIn = React.useCallback(() => {
    if (!scope || !isSignInScope) return;
    void serverBrowser.closeScope(scope.id).finally(() => setSignIn(null));
  }, [isSignInScope, scope, serverBrowser, setSignIn]);

  const answerProfileRequest = React.useCallback(async (approve: boolean) => {
    const answered = await serverBrowser.answerProfileRequest(approve);
    if (!answered) toast.error(t('contextPanel.browser.server.help.profileAnswerFailed'));
  }, [serverBrowser, t]);

  const handleViewportChange = React.useCallback((next: BrowserViewport) => {
    void serverBrowser.setViewport(toServiceViewport(next));
  }, [serverBrowser]);

  const zoomLevel = scope?.zoomLevel ?? 0;
  const zoomPercent = Math.round(1.2 ** zoomLevel * 100);

  const loaded = Boolean(showingMine && scope && scope.url && scope.url !== BLANK_URL);

  // ---- what the page in front asks of the person ---------------------------
  const { files } = useRuntimeAPIs();
  const shownTab = showingMine ? scope?.tabs.find((tab) => tab.active) ?? null : null;
  const help = state?.help ?? null;
  // A request for help names the page it is about; other tabs of the chat do not show it.
  // A login request shows on the sign-in browser the person signs in on, never
  // on the chat's own browser it returns to once the sign-in is saved.
  const helpTargetsThisScope = Boolean(help && scope && help.scopeId === scope.id
    && (help.tabId === null || shownTab?.id === help.tabId));
  // A new request brings its tab in front once; the person may then look elsewhere.
  const helpPanelTabId = help?.tabId && scope && help.scopeId === scope.id
    ? panelTabsByChromeTab(claims, scope.id).get(help.tabId) ?? null
    : null;
  const shownHelpRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!help || !helpPanelTabId || shownHelpRef.current === help.since) return;
    shownHelpRef.current = help.since;
    if (helpPanelTabId !== tabID) setActiveContextPanelTab(directory, helpPanelTabId);
  }, [directory, help, helpPanelTabId, setActiveContextPanelTab, tabID]);
  // Someone else holds control: only they can answer the page.
  const answerLocked = control.controller === 'user' && !control.mine;
  const answerDialog = React.useCallback(async (accept: boolean, promptText?: string) => {
    const dialog = shownTab?.dialog;
    if (!shownTab || !dialog) return;
    const answered = await serverBrowser.answerDialog({ tabId: shownTab.id, dialogId: dialog.id, accept, ...(promptText === undefined ? {} : { promptText }) });
    if (!answered) toast.error(t('contextPanel.browser.server.dialog.failed'));
  }, [serverBrowser, shownTab, t]);
  const chooseFiles = React.useCallback(async (picked: File[]) => {
    const chooser = shownTab?.fileChooser;
    if (!shownTab || !chooser || !scope || !files.uploadFile) return;
    try {
      // The folder is this request's own: a second try after a failure
      // replaces what the first one got through.
      for (const file of picked) {
        await files.uploadFile(joinServerPath(chooser.directory, file.name), file, { directory: scope.directory, overwrite: true });
      }
    } catch {
      toast.error(t('contextPanel.browser.server.files.failed'));
      return;
    }
    const given = await serverBrowser.answerFileChooser({ tabId: shownTab.id, chooserId: chooser.id, files: picked.map((file) => file.name) });
    if (!given) toast.error(t('contextPanel.browser.server.files.failed'));
  }, [files, scope, serverBrowser, shownTab, t]);
  const cancelFiles = React.useCallback(async () => {
    const chooser = shownTab?.fileChooser;
    if (!shownTab || !chooser) return;
    await serverBrowser.answerFileChooser({ tabId: shownTab.id, chooserId: chooser.id, files: null });
  }, [serverBrowser, shownTab]);

  const downloadMenuItems = useServerBrowserDownloads(scope);

  // ---- sound: off until the person turns it on ----------------------------
  const [soundSupported, setSoundSupported] = React.useState(false);
  const [soundOn, setSoundOn] = React.useState(false);
  const [soundMissing, setSoundMissing] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    void supportsSurfaceAudio().then((supported) => { if (!cancelled) setSoundSupported(supported); });
    return () => { cancelled = true; };
  }, []);
  React.useEffect(() => { setSoundMissing(false); }, [scope?.url]);
  const toggleSound = React.useCallback(() => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundMissing(false);
    // In the click itself: browsers start audio only in answer to the person.
    canvasHandleRef.current?.setAudio(next);
  }, [soundOn]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      {isSignInScope && scope ? (
        <div className="flex items-center gap-2 border-b border-border bg-[var(--status-info-background)] px-3 py-1.5 typography-ui-label">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{t('contextPanel.browser.server.signingIn', { profile: scope.profile?.name ?? signIn?.name ?? '' })}</span>
            {' — '}
            {t('contextPanel.browser.server.help.loginHint')}
          </span>
          <Button size="xs" variant="ghost" onClick={cancelSignIn} disabled={savingSignIn}>
            {t('contextPanel.browser.server.cancel')}
          </Button>
          <Button size="xs" variant="outline" onClick={handleSaveSignIn} disabled={savingSignIn}>
            <Icon name="save-3" className="size-3.5" aria-hidden="true" />
            {t('contextPanel.browser.server.help.saveSignIn')}
          </Button>
        </div>
      ) : null}
      <BrowserToolbar
        address={address}
        onAddressChange={setAddress}
        onSubmit={(value) => {
          const next = normalizeBrowserUrl(value);
          if (next === BLANK_URL) return;
          void serverBrowser.navigate(next);
        }}
        suggestions={suggestions}
        onForgetSuggestion={(url) => forgetHistoryVisit(directory, url)}
        onBack={() => void serverBrowser.back()}
        onForward={() => void serverBrowser.forward()}
        onReload={() => void (scope?.isLoading ? serverBrowser.stop() : serverBrowser.reload())}
        onOpenExternal={() => void openExternalUrl(scope?.url || address)}
        canGoBack={scope?.canGoBack ?? false}
        canGoForward={scope?.canGoForward ?? false}
        isLoading={scope?.isLoading ?? false}
        onAnnotate={handleAnnotate}
        isAnnotating={isAnnotating}
        onToggleInspector={() => setInspectorOpen((current) => !current)}
        isInspectorOpen={inspectorOpen}
        onZoomIn={() => void serverBrowser.setZoom(Math.min(ZOOM_MAX, zoomLevel + 1))}
        onZoomOut={() => void serverBrowser.setZoom(Math.max(ZOOM_MIN, zoomLevel - 1))}
        onZoomReset={() => void serverBrowser.setZoom(0)}
        zoomPercent={zoomPercent}
        menuItems={[
          ...downloadMenuItems,
          ...(downloadMenuItems.length > 0 ? [{ kind: 'separator' as const, id: 'sep-downloads' }] : []),
          { kind: 'item', id: 'cookies', icon: 'delete-bin', label: t('contextPanel.browser.clearCookies'), onSelect: () => setClearConfirm('cookies') },
          { kind: 'item', id: 'cache', icon: 'database-2', label: t('contextPanel.browser.clearCache'), onSelect: () => setClearConfirm('cache') },
          { kind: 'item', id: 'external', icon: 'external-link', label: t('contextPanel.browser.openExternal'), onSelect: () => void openExternalUrl(scope?.url || address), disabled: !loaded },
          { kind: 'separator', id: 'sep' },
          { kind: 'item', id: 'close', icon: 'close-circle', label: t('contextPanel.browser.server.closeScope'), onSelect: closeChatBrowser, destructive: true, disabled: !scope },
        ]}
        onToggleDeviceBar={() => setShowDeviceBar((current) => !current)}
        isDeviceBarOpen={showDeviceBar}
        onToggleFollowAgent={scope?.sessionId && !isSignInScope ? () => setFollowAgent(scope.sessionId ?? '', !followAgent) : undefined}
        isFollowingAgent={followAgent}
        onToggleSound={soundSupported ? toggleSound : undefined}
        isSoundOn={soundOn}
        isSoundUnavailable={soundMissing || scope?.audioUnavailable === true}
      />
      {showDeviceBar ? (
        <BrowserDeviceBar
          viewport={viewport}
          onViewportChange={handleViewportChange}
          colorScheme={scope?.colorScheme ?? 'system'}
          onColorSchemeChange={(scheme) => void serverBrowser.setColorScheme(scheme)}
          scale={1}
        />
      ) : null}
      <ServerBrowserBanners
        // The host's lease covers every chat; only the one the agent works in is busy.
        control={control.controller === 'agent' && state?.agentScopeId !== undefined && state.agentScopeId !== scope?.id
          ? { controller: 'none', mine: false }
          : control}
        connection={connection}
        focused={canvasFocused}
        onHandBack={() => canvasHandleRef.current?.release()}
        help={help}
        helpTargetsThisScope={helpTargetsThisScope}
        onAnswerProfileRequest={answerProfileRequest}
        chrome={state?.chrome ?? null}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ServerBrowserCanvas
          ref={canvasHandleRef}
          guestId={guestId}
          onViewer={setViewerId}
          onControl={setControl}
          onConnection={setConnection}
          onFocusChange={setCanvasFocused}
          onAudioState={(available) => setSoundMissing(!available)}
        />
        {shownTab?.dialog ? (
          <ServerBrowserDialogCard key={shownTab.dialog.id} dialog={shownTab.dialog} url={shownTab.url} disabled={answerLocked} onAnswer={answerDialog} />
        ) : shownTab?.fileChooser ? (
          <ServerBrowserFileChooserCard
            key={shownTab.fileChooser.id}
            chooser={shownTab.fileChooser}
            disabled={answerLocked}
            canUpload={Boolean(files.uploadFile)}
            onChoose={chooseFiles}
            onCancel={cancelFiles}
          />
        ) : null}
        {!loaded && showingMine ? (
          <div className="absolute inset-0">
            <BrowserEmptyState onOpen={(url) => void serverBrowser.navigate(normalizeBrowserUrl(url))} directory={directory} visible={visible} />
          </div>
        ) : null}
      </div>
      <ServerBrowserInspector guestId={guestId} viewerId={viewerId} open={inspectorOpen} />

      <Dialog open={clearConfirm !== null} onOpenChange={(open) => { if (!open) setClearConfirm(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>
              {clearConfirm === 'cookies' ? t('contextPanel.browser.clearCookies') : t('contextPanel.browser.clearCache')}
            </DialogTitle>
            <DialogDescription>
              {t('contextPanel.browser.server.clearConfirm', {
                what: clearConfirm === 'cookies' ? t('contextPanel.browser.clearCookies').toLowerCase() : t('contextPanel.browser.clearCache').toLowerCase(),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setClearConfirm(null)}>{t('contextPanel.browser.server.cancel')}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const what = clearConfirm;
                setClearConfirm(null);
                if (!what) return;
                void serverBrowser.clearData(what).then(() => {
                  toast.success(t(what === 'cookies' ? 'contextPanel.browser.clearedCookies' : 'contextPanel.browser.clearedCache'));
                });
              }}
            >
              {clearConfirm === 'cookies' ? t('contextPanel.browser.clearCookies') : t('contextPanel.browser.clearCache')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
