import React from 'react';
import {
  HostRequestError,
  OPENCHAMBER_SDK_CHANNEL,
  OPENCHAMBER_SDK_API_VERSION,
  EMPTY_GUEST_CONNECTION,
  GUEST_REQUEST_TIMEOUT_MS,
  GUEST_POPOVER_HEIGHT_MIN,
  GUEST_POPOVER_HEIGHT_MAX,
  guestFileScope,
  type AttachIssueRequest,
  type GuestBlockCall,
  type GuestHostSurface,
  type GuestItem,
  type GuestMicrophoneEndReason,
  type GuestPopoverClosedEvent,
  type GuestPopoverContext,
  type GuestPopoverRequest,
  type GuestMessage,
  type HostMessage,
  type HostReadyContext,
  type ResolveResultPayload,
  trackerProviderIdOf,
} from '@openchamber/sdk';
import { guestMessageSchema } from '@openchamber/sdk/schemas';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getReadableThemeColors } from '@/lib/theme/readableColors';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { copyTextToClipboard } from '@/lib/clipboard';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import {
  answerGuestMessage,
  buildConnectionMessage,
  buildDirectoryMessage,
  buildItemMessage,
  buildReadyMessage,
  buildResolveMessage,
  buildGenerateLateMessage,
  buildSessionLifecycleMessage,
  buildSessionMessage,
  buildSettingsMessage,
  guestSessionLifecyclePhase,
  guestSessionModelId,
  toGuestSessionSnapshot,
} from '@/lib/guests/host-bridge';
import { useGuestBadgeStore } from '@/lib/guests/badge-store';
import { guestMay, isGuestActive } from '@/lib/guests/capabilities';
import { guestFileOperation } from '@/lib/guests/files';
import { useHostDevice } from '@/lib/guests/useHostDevice';
import { useHostTypography } from '@/lib/guests/useHostTypography';
import { guestGenerate } from '@/lib/guests/generate';
import { guestGenerateResults, lateGenerateResult, type GenerateOwner } from '@/lib/guests/generate-results';
import { useConfigStore } from '@/stores/useConfigStore';
import { openGuestCommit, readCurrentBranch } from '@/lib/guests/open-commit';
import { openGuestSurface } from '@/lib/guests/open-surface';
import { openGuestUrl } from '@/lib/guests/open-url';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { registerGuestResolver, type GuestResolveOutcome } from '@/lib/guests/resolve';
import type { GuestBackgroundAction } from '@/lib/guests/run-action';
import { useGuestFrameUrl } from '@/lib/guests/useGuestFrameUrl';
import { useGuestItemStore } from '@/lib/guests/item-store';
import { isGuestFileMessage, type GuestFileChannel } from '@/lib/guests/file-editor-channel';
import { fetchHostLinearIssueGet } from '@/lib/guests/host-linear-request';
import { loadGuestServiceStatus, proxyGuestServiceRequest } from '@/lib/guests/service';
import { getSurfaceViewerId } from '@/lib/guests/surface-viewers';
import {
  AUTHORIZATION_POLL_MS,
  AUTHORIZATION_WATCH_MS,
  disconnectGuestOauth,
  guestAuthorizationCompleted,
  proxyGuestRequest,
  startGuestOauth,
} from '@/lib/guests/oauth';
import { useGuestOauthStore } from '@/lib/guests/oauth-store';
import { trackerGuestConnection } from '@/lib/guests/tracker-connection';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useTrackerAuthEntry, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { linkGuestSession, promptGuestSession, startGuestSession } from '@/lib/guests/start-session';
import { useGuestsStore } from '@/lib/guests/store';
import { readGuestWorkspace, observeGuestWorkspace, openGuestSession } from '@/lib/guests/workspace';
import { observeGuestShells, readGuestShellOutput } from '@/lib/guests/shells';
import { canCaptureGuestMicrophone, markGuestListening, startGuestMicrophone, type GuestMicrophoneCapture } from '@/lib/guests/microphone';
import { guestStorageOperation } from '@/lib/guests/storage';
import { getGuestPopoverController, guestPopoverOwnerBlocked, positionGuestPopover, type GuestPopoverActivation, type GuestPopoverPosition } from '@/lib/guests/popovers';
import { createGuestStatusControls, type GuestStatusControlBinding } from '@/lib/guests/status-controls';
import { showGuestToast } from '@/lib/guests/toast';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { closeGuestTabsEverywhere } from '@/lib/guests/tabs';
import { pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { useInputStore } from '@/sync/input-store';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { useChatSessionSelection } from '@/components/chat/chatColumnSession';
import { isForegroundShellStopping } from '@/components/chat/message/parts/foregroundShellStop';
import { useSessionSelector, useSessionStatus } from '@/sync/sync-context';
import type { Session } from '@/lib/opencode/model';
import { GuestPopover } from './GuestPopover';
import { GuestPopoverSheet } from './GuestPopoverSheet';
import { DockedPanelSurfaceContext, usePageColors } from '@/hooks/usePageColors';

type PluginPaneProps = {
  mode: PluginContextPanelMode;
  surface?: GuestHostSurface;
  item?: GuestItem | null;
  headless?: boolean;
  backgroundAction?: GuestBackgroundAction;
  onDismiss?: () => void;
  onAttach?: (issue: AttachIssueRequest) => void;
  onSessionStarted?: () => void;
  block?: { call: GuestBlockCall; entry: string; answer: (text: string) => Promise<void> };
  onResize?: (height: number) => void;
  onStatusControls?: (binding: GuestStatusControlBinding | null) => void;
  statusDirectory?: string | null;
  fileEditor?: { editorId: string; channel: GuestFileChannel };
  pinnedDirectory?: string;
  popover?: GuestPopoverContext;
  popoverHost?: { entry: string; directory: string; context: GuestPopoverContext; activation: GuestPopoverActivation; focus: boolean };
  isActive?: () => boolean;
  onPopoverClosed?: (event: GuestPopoverClosedEvent) => void;
  onPopoverActivity?: (active: boolean) => void;
};

// external: https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage Opaque-origin frames require a wildcard target and receive-side contentWindow identity checks.
const OPAQUE_FRAME_TARGET_ORIGIN = '*';

const HOST_RADIUS_FALLBACK = '0.5625rem';

const popoverOpensAsSheet = (): boolean => isMobileSurfaceRuntime();

const NOT_GRANTED_MESSAGE = 'The user has not allowed this capability for the extension.';

const withOwnProviderId = (message: GuestMessage, guestId: string): GuestMessage => {
  if (message.type === 'attach' || message.type === 'start-session' || message.type === 'session-link') {
    return message.payload.providerId === guestId
      ? message
      : { ...message, payload: { ...message.payload, providerId: guestId } };
  }
  return message;
};

const readCssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

type FrameSessionFields = { id?: string; title?: string; model?: string; agent?: string };

const frameSessionFields = (session: Session | undefined): FrameSessionFields => ({
  id: session?.id,
  title: session?.title,
  model: guestSessionModelId(session?.model),
  agent: session?.agent,
});

const sameFrameSessionFields = (left: FrameSessionFields, right: FrameSessionFields): boolean => (
  left.id === right.id && left.title === right.title && left.model === right.model && left.agent === right.agent
);

export const PluginPane: React.FC<PluginPaneProps> = ({
  mode,
  surface = 'panel',
  item: itemProp,
  headless = false,
  backgroundAction,
  onDismiss,
  onAttach,
  onSessionStarted,
  block,
  onResize,
  onStatusControls,
  statusDirectory,
  fileEditor,
  pinnedDirectory,
  popover,
  popoverHost,
  isActive,
  onPopoverClosed,
  onPopoverActivity,
}) => {
  const { t, locale } = useI18n();
  const { currentTheme } = useThemeSystem();
  const effectiveDirectory = useEffectiveDirectory();
  const { sessionId: selectedSessionId } = useChatSessionSelection();
  const directory = popoverHost?.directory ?? pinnedDirectory ?? (backgroundAction ? backgroundAction.item.directory ?? ''
    : surface === 'status' && statusDirectory !== undefined ? statusDirectory ?? '' : effectiveDirectory);
  const statusContextKey = surface === 'status' ? directory : null;
  const actionItem = backgroundAction?.item;
  const currentSessionId = actionItem && 'sessionId' in actionItem ? actionItem.sessionId : selectedSessionId;
  const session = useSessionSelector(currentSessionId, directory || undefined, frameSessionFields, sameFrameSessionFields);
  const sessionStatus = useSessionStatus(currentSessionId ?? '', directory || undefined);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const [activePopover, setActivePopover] = React.useState<{ request: GuestPopoverRequest; position: GuestPopoverPosition; entry: string; directory: string; activation: GuestPopoverActivation } | null>(null);
  const activePopoverRef = React.useRef<typeof activePopover>(null);
  const popoverCloseTimerRef = React.useRef<number | null>(null);
  const popoverAnchorActiveRef = React.useRef(false);
  const popoverOverlayActiveRef = React.useRef(false);
  const closeActivePopoverRef = React.useRef<(reason: GuestPopoverClosedEvent['reason']) => void>(() => {});
  const guestId = pluginIdFromMode(mode);
  const guest = useGuestsStore((state) => state.guests.find((entry) => entry.id === guestId) ?? null);
  const catalogStatus = useGuestsStore((state) => state.status);
  const guestEnabled = guest ? isGuestActive(guest) : true;
  const oauthStatus = useGuestOauthStore((state) => state.byId[guestId]);
  const setOauthStatus = useGuestOauthStore((state) => state.setStatus);
  const refreshOauth = useGuestOauthStore((state) => state.refresh);
  const runtimeTrackers = React.useContext(RuntimeAPIContext)?.trackers;
  const refreshTrackerStatus = useTrackerAuthStore((state) => state.refreshStatus);
  const trackerProvider = guest?.tracker && !guest.integration ? trackerProviderIdOf(guestId) : null;
  const trackerEntry = useTrackerAuthEntry(trackerProvider);
  const trackerStatus = trackerProvider ? trackerEntry.status : null;
  const connection = React.useMemo(
    () => (trackerProvider ? trackerGuestConnection(trackerStatus) : oauthStatus?.connection ?? EMPTY_GUEST_CONNECTION),
    [oauthStatus?.connection, trackerProvider, trackerStatus],
  );
  const pendingItem = useGuestItemStore((state) => state.pendingItemByGuest[guestId]);
  const takePendingItem = useGuestItemStore((state) => state.takePendingItem);
  const [railItem, setRailItem] = React.useState<GuestItem | null>(null);
  React.useEffect(() => {
    if (surface !== 'panel' || headless || itemProp !== undefined || !pendingItem) return;
    const taken = takePendingItem(guestId);
    if (taken) setRailItem(taken);
  }, [guestId, headless, itemProp, pendingItem, surface, takePendingItem]);
  const item = headless ? null : itemProp !== undefined ? itemProp : railItem;
  const clearBadge = useGuestBadgeStore((state) => state.clearBadge);
  React.useEffect(() => {
    if (surface === 'panel' && !headless) clearBadge(guestId);
  }, [clearBadge, guestId, headless, surface]);
  const sessionBusy = sessionStatus?.type === 'busy' || sessionStatus?.type === 'retry';
  const lifecyclePhase = guestSessionLifecyclePhase(sessionStatus);
  const sessionSnapshot = React.useMemo(
    () => toGuestSessionSnapshot(
      currentSessionId
        ? {
          id: session?.id ?? currentSessionId,
          title: session?.title ?? (actionItem && 'sessionTitle' in actionItem ? actionItem.sessionTitle : undefined),
          busy: sessionBusy,
          model: session?.model,
          agent: session?.agent,
        }
        : null,
    ),
    [actionItem, currentSessionId, session, sessionBusy],
  );

  const readableColors = React.useMemo(() => getReadableThemeColors(currentTheme), [currentTheme]);
  const pageColors = usePageColors();
  const typography = useHostTypography();
  const device = useHostDevice();
  const ready = React.useMemo<HostReadyContext>(() => {
    const features: NonNullable<HostReadyContext['features']> = {};
    if (guest?.storageId && globalThis.indexedDB) features.deviceStorage = true;
    if (surface === 'status' && onStatusControls) features.statusControls = true;
    if (!popoverHost && !popover && !headless && !isVSCodeRuntime()
      && (surface === 'panel' || surface === 'page' || surface === 'status')) features.popovers = true;
    if (!headless) features.lateGenerateResults = true;
    if (!headless && canCaptureGuestMicrophone()) features.microphone = true;
    return {
    theme: {
      mode: currentTheme.metadata.variant === 'dark' ? 'dark' : 'light',
      tokens: {
        background: pageColors.background,
        elevated: currentTheme.colors.surface.elevated,
        foreground: currentTheme.colors.surface.foreground,
        muted: currentTheme.colors.surface.mutedForeground,
        subtle: currentTheme.colors.surface.subtle,
        border: currentTheme.colors.interactive.border,
        hover: currentTheme.colors.interactive.hover,
        selection: currentTheme.colors.interactive.selection,
        focus: currentTheme.colors.interactive.focusRing,
        primary: currentTheme.colors.primary.base,
        mutedSurface: pageColors.mutedSurface,
        elevatedForeground: currentTheme.colors.surface.elevatedForeground,
        active: currentTheme.colors.interactive.active,
        selectionForeground: readableColors.selectionForeground,
        primaryForeground: currentTheme.colors.primary.foreground ?? '#ffffff',
        primaryText: readableColors.tinted.primary,
        successText: readableColors.tinted.success,
        warningText: readableColors.tinted.warning,
        errorText: readableColors.tinted.error,
        infoText: readableColors.tinted.info,
        success: currentTheme.colors.status.success,
        warning: currentTheme.colors.status.warning,
        error: currentTheme.colors.status.error,
        info: currentTheme.colors.status.info,
        font: typography.font,
        fontSize: typography.fontSize,
        mono: typography.mono,
        radius: readCssVar('--radius', HOST_RADIUS_FALLBACK),
        syntaxKeyword: currentTheme.colors.syntax.base.keyword,
        syntaxString: currentTheme.colors.syntax.base.string,
        syntaxNumber: currentTheme.colors.syntax.base.number,
        syntaxFunction: currentTheme.colors.syntax.base.function,
        syntaxType: currentTheme.colors.syntax.base.type,
        syntaxComment: currentTheme.colors.syntax.base.comment,
        syntaxVariable: currentTheme.colors.syntax.base.variable,
        syntaxOperator: currentTheme.colors.syntax.base.operator,
      },
    },
    locale,
    directory: directory || null,
    session: sessionSnapshot,
    surface: headless && guest?.backgroundEntry ? 'background' : surface,
    connection,
    settings: oauthStatus?.settings ?? {},
    item,
    ...(block ? { block: block.call } : {}),
    popover: popoverHost?.context ?? popover,
    features,
    device,
    };
  }, [block, connection, currentTheme, device, pageColors, readableColors, typography, directory, guest?.backgroundEntry, guest?.storageId, headless, item, locale, oauthStatus, onStatusControls, popover, popoverHost, sessionSnapshot, surface]);

  const fileEditorEntry = surface === 'file' && fileEditor
    ? guest?.fileEditors?.find((editor) => editor.id === fileEditor.editorId)?.entry ?? null
    : null;
  const approvedOrigins = guest?.capabilities.granted.includes('origins') ? guest.origins ?? [] : [];
  const revision = surface === 'file' ? 0 : guest?.revision ?? 0;
  const frameKey = `${guestId}:${guest?.storageId ?? ''}:${guest?.version ?? ''}:rev-${revision}:${guestEnabled}:grants-${guest?.capabilities.granted.join(',') ?? ''}:service-${guest?.service?.granted ? '1' : '0'}:origins-${approvedOrigins.join(',')}:${guest?.entry ?? ''}:${guest?.backgroundEntry ?? ''}:${guest?.statusEntry ?? ''}:${guest?.pageEntry ?? ''}:${guest?.attachEntry ?? ''}:${fileEditorEntry ?? ''}:${block?.entry ?? ''}:popover-${popoverHost?.context.id ?? popover?.id ?? ''}`;

  const guestEntry = popoverHost?.entry ?? (guest
    ? headless ? guest.backgroundEntry ?? guest.entry ?? null
      : surface === 'page' ? guest.pageEntry ?? null
        : surface === 'status' ? guest.statusEntry ?? null
        : surface === 'block' ? block?.entry ?? null
        : surface === 'file' ? fileEditorEntry
        : surface === 'dialog' && guest.attachEntry ? guest.attachEntry : guest.entry ?? null
    : null);
  const { src, srcDoc, status: frameStatus, retry: retryFrame, recoverExpiredNavigation, acknowledgeHandshake } = useGuestFrameUrl({
    guestId, entry: guestEntry, instanceKey: frameKey, enabled: guestEnabled, origins: approvedOrigins, reuseDocument: surface === 'block' || headless,
  });

  const readyRef = React.useRef(ready);
  readyRef.current = ready;
  const directoryRef = React.useRef(directory);
  directoryRef.current = directory;
  const effectiveDirectoryRef = React.useRef(effectiveDirectory);
  effectiveDirectoryRef.current = effectiveDirectory;
  const sessionIdRef = React.useRef(currentSessionId);
  sessionIdRef.current = currentSessionId;
  const sessionBusyRef = React.useRef(sessionBusy);
  sessionBusyRef.current = sessionBusy;
  const guestIdRef = React.useRef(guestId);
  guestIdRef.current = guestId;
  const guestEnabledRef = React.useRef(guestEnabled);
  guestEnabledRef.current = guestEnabled;
  const isActiveRef = React.useRef(isActive);
  isActiveRef.current = isActive;
  const popoverHostRef = React.useRef(popoverHost);
  popoverHostRef.current = popoverHost;
  const onPopoverClosedRef = React.useRef(onPopoverClosed);
  onPopoverClosedRef.current = onPopoverClosed;
  const onPopoverActivityRef = React.useRef(onPopoverActivity);
  onPopoverActivityRef.current = onPopoverActivity;
  const guestRef = React.useRef(guest);
  guestRef.current = guest;
  const guestAuthRef = React.useRef(guest?.integration?.auth);
  guestAuthRef.current = guest?.integration?.auth;
  const translateRef = React.useRef(t);
  translateRef.current = t;
  const onAttachRef = React.useRef(onAttach);
  onAttachRef.current = onAttach;
  const onDismissRef = React.useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const onSessionStartedRef = React.useRef(onSessionStarted);
  onSessionStartedRef.current = onSessionStarted;
  const blockRef = React.useRef(block);
  blockRef.current = block;
  const onResizeRef = React.useRef(onResize);
  onResizeRef.current = onResize;
  const onStatusControlsRef = React.useRef(onStatusControls);
  onStatusControlsRef.current = onStatusControls;
  const statusControlsRef = React.useRef<ReturnType<typeof createGuestStatusControls> | null>(null);
  const fileChannel = fileEditor?.channel ?? null;
  const fileChannelRef = React.useRef(fileChannel);
  fileChannelRef.current = fileChannel;
  const oauthPollRef = React.useRef<number | null>(null);
  const resolveWaitersRef = React.useRef(new Map<string, (outcome: GuestResolveOutcome) => void>());
  const resolveIdsRef = React.useRef(0);
  const frameDocumentRef = React.useRef(0);

  const stopOauthPoll = React.useCallback(() => {
    if (oauthPollRef.current != null) {
      window.clearInterval(oauthPollRef.current);
      oauthPollRef.current = null;
    }
  }, []);

  const postToGuest = React.useCallback((message: HostMessage) => {
    iframeRef.current?.contentWindow?.postMessage(message, OPAQUE_FRAME_TARGET_ORIGIN);
  }, []);

  const sendBackgroundAction = React.useCallback(() => {
    const message = backgroundAction?.takeMessage();
    if (message) postToGuest(message);
  }, [backgroundAction, postToGuest]);

  React.useEffect(() => {
    if (!guestEnabled) return undefined;
    return subscribeOpenchamberEvents((event) => {
      if (event.type !== 'guest-service-event' || event.guestId !== guestId) return;
      postToGuest({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'service-event', payload: { topic: event.topic, data: event.data } });
    });
  }, [guestEnabled, guestId, postToGuest]);

  const connectFileChannel = React.useCallback(() => {
    fileChannelRef.current?.connect(postToGuest);
  }, [postToGuest]);
  React.useEffect(() => {
    if (!fileChannel) return;
    return () => fileChannel.disconnect();
  }, [fileChannel, frameKey, src, srcDoc]);

  const resolverReadyRef = React.useRef(false);
  const unregisterResolverRef = React.useRef<(() => void) | null>(null);
  const registerResolver = React.useCallback(() => {
    if (resolverReadyRef.current || surface !== 'panel' || (!headless && guestRef.current?.backgroundEntry)) return;
    resolverReadyRef.current = true;
    const registeredGuest = guestRef.current;
    const runtimeKey = getRuntimeKey();
    unregisterResolverRef.current = registerGuestResolver(guestIdRef.current, (request) => {
      const currentGuest = useGuestsStore.getState().guests.find((candidate) => candidate.id === registeredGuest?.id);
      if (getRuntimeKey() !== runtimeKey || !currentGuest || !isGuestActive(currentGuest)
        || currentGuest.version !== registeredGuest?.version || currentGuest.entry !== registeredGuest?.entry
        || currentGuest.backgroundEntry !== registeredGuest?.backgroundEntry) {
        return Promise.resolve({ ok: false, reason: 'unavailable' });
      }
      return new Promise((resolve) => {
        resolveIdsRef.current += 1;
        const id = `resolve-${resolveIdsRef.current}`;
        const timer = window.setTimeout(() => {
          resolveWaitersRef.current.delete(id);
          resolve({ ok: false, reason: 'timeout' });
        }, GUEST_REQUEST_TIMEOUT_MS);
        resolveWaitersRef.current.set(id, (outcome) => {
          window.clearTimeout(timer);
          resolveWaitersRef.current.delete(id);
          resolve(outcome);
        });
        iframeRef.current?.contentWindow?.postMessage(buildResolveMessage(id, request.command, request.args), OPAQUE_FRAME_TARGET_ORIGIN);
      });
    });
  }, [headless, surface]);
  React.useEffect(() => () => {
    unregisterResolverRef.current?.();
    unregisterResolverRef.current = null;
    resolverReadyRef.current = false;
    for (const waiter of resolveWaitersRef.current.values()) {
      waiter({ ok: false, reason: 'unavailable' });
    }
    resolveWaitersRef.current.clear();
  }, [frameKey, src, srcDoc]);

  const pushHostState = React.useCallback(() => {
    postToGuest(buildReadyMessage(readyRef.current));
    postToGuest(buildDirectoryMessage(directoryRef.current || null));
    postToGuest(buildSessionMessage(readyRef.current.session));
    postToGuest(buildConnectionMessage(readyRef.current.connection));
    postToGuest(buildSettingsMessage(readyRef.current.settings));
    postToGuest(buildItemMessage(readyRef.current.item));
  }, [postToGuest]);

  const clearPopoverCloseTimer = React.useCallback(() => {
    if (popoverCloseTimerRef.current != null) {
      window.clearTimeout(popoverCloseTimerRef.current);
      popoverCloseTimerRef.current = null;
    }
  }, []);
  const schedulePopoverClose = React.useCallback((activation: GuestPopoverActivation, reason: GuestPopoverClosedEvent['reason']) => {
    clearPopoverCloseTimer();
    popoverCloseTimerRef.current = window.setTimeout(() => {
      if (activePopoverRef.current?.activation !== activation || popoverAnchorActiveRef.current || popoverOverlayActiveRef.current) return;
      closeActivePopoverRef.current(reason);
    }, 250);
  }, [clearPopoverCloseTimer]);
  const closeActivePopover = React.useCallback((reason: GuestPopoverClosedEvent['reason']) => {
    clearPopoverCloseTimer();
    const active = activePopoverRef.current;
    if (!active) return;
    getGuestPopoverController(document).release(active.activation);
    activePopoverRef.current = null;
    popoverAnchorActiveRef.current = false;
    popoverOverlayActiveRef.current = false;
    setActivePopover(null);
    if (reason === 'escape') iframeRef.current?.focus();
    iframeRef.current?.contentWindow?.postMessage({
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'popover-closed',
      payload: { id: active.request.id, reason },
    }, OPAQUE_FRAME_TARGET_ORIGIN);
  }, [clearPopoverCloseTimer]);
  closeActivePopoverRef.current = closeActivePopover;
  React.useEffect(() => () => closeActivePopover('owner'), [closeActivePopover]);
  React.useLayoutEffect(() => {
    if (!popoverHost && !popover) closeActivePopover('owner');
  }, [closeActivePopover, directory, frameKey, popover, popoverHost]);

  const hasIntegration = Boolean(guest?.integration);
  React.useEffect(() => {
    if (!guest || !hasIntegration) {
      return;
    }
    void refreshOauth(guest.id);
  }, [guest?.id, guest?.revision, hasIntegration, refreshOauth]);

  React.useEffect(() => {
    if (trackerProvider) void refreshTrackerStatus(runtimeTrackers, trackerProvider, { force: true });
  }, [refreshTrackerStatus, runtimeTrackers, trackerProvider]);

  React.useEffect(() => {
    if (guest && !guestEnabled) {
      onDismiss?.();
    }
  }, [guest, guestEnabled, onDismiss]);


  React.useEffect(() => {
    const subscriptions = new Map<string, () => void>();
    const childPopover = popoverHostRef.current;
    let disposed = false;
    const runtimeKey = getRuntimeKey();
    const requestingGuestId = guestIdRef.current;
    const installation = guestRef.current;
    const authorizationSignature = (candidate: typeof installation) => JSON.stringify({
      storageId: candidate?.storageId,
      version: candidate?.version,
      entry: candidate?.entry,
      statusEntry: candidate?.statusEntry,
      pageEntry: candidate?.pageEntry,
      attachEntry: candidate?.attachEntry,
      origins: candidate?.origins ?? [],
      grants: candidate?.capabilities.granted ?? [],
      service: candidate?.service?.granted ?? false,
    });
    const installationAuthorization = authorizationSignature(installation);
    const ownerFrame = iframeRef.current;
    const currentGuest = () => useGuestsStore.getState().guests.find((entry) => entry.id === requestingGuestId) ?? null;
    const ownsFrame = () => {
      const catalog = useGuestsStore.getState();
      const current = currentGuest();
      return !disposed && getRuntimeKey() === runtimeKey && catalog.runtimeKey === runtimeKey
        && catalog.status === 'ready' && Boolean(current && installation && isGuestActive(current)
          && authorizationSignature(current) === installationAuthorization)
        && iframeRef.current === ownerFrame
        && (!isActiveRef.current || isActiveRef.current())
        && (!backgroundAction || backgroundAction.isActive());
    };
    const statusControls = createGuestStatusControls({
      isActive: () => ownsFrame() && surface === 'status',
      getContext: () => directoryRef.current || null,
      onChange: (binding) => onStatusControlsRef.current?.(binding),
      post: (payload) => postToGuest({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'status-control-event', payload }),
    });
    statusControlsRef.current = statusControls;
    const clearSubscriptions = () => { for (const unsubscribe of subscriptions.values()) unsubscribe(); subscriptions.clear(); };
    let microphoneTicket = 0;
    let microphoneOpening = false;
    let microphoneCapture: GuestMicrophoneCapture | null = null;
    let releaseListening: (() => void) | null = null;
    const stopMicrophone = () => {
      microphoneTicket += 1;
      microphoneOpening = false;
      microphoneCapture?.stop();
      microphoneCapture = null;
      releaseListening?.();
      releaseListening = null;
    };
    const generateOwner = (): GenerateOwner => ({
      runtimeKey,
      guestId: requestingGuestId,
      storageId: installation?.storageId ?? null,
      surface: readyRef.current.surface,
      directory: directoryRef.current || null,
    });
    let stopLateGenerate: (() => void) | null = null;
    const stopLateGenerateListening = () => { stopLateGenerate?.(); stopLateGenerate = null; };
    const runtimeUnsubscribe = subscribeRuntimeEndpointChanged(() => { disposed = true; closeActivePopover('owner'); statusControls.dispose(); clearSubscriptions(); stopMicrophone(); stopOauthPoll(); });
    const requireSessions = () => {
      if (!guestMay(currentGuest(), 'sessions')) throw new HostRequestError('NOT_GRANTED', NOT_GRANTED_MESSAGE);
    };
    const requireShells = () => {
      if (!guestMay(currentGuest(), 'shells')) throw new HostRequestError('NOT_GRANTED', NOT_GRANTED_MESSAGE);
    };
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const parsed = guestMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (disposed || getRuntimeKey() !== runtimeKey || (backgroundAction && !backgroundAction.isActive())
        || (isActiveRef.current && !isActiveRef.current())) return;
      const message = withOwnProviderId(parsed.data, guestIdRef.current);
      const activeGuest = currentGuest();
      if (!activeGuest || !isGuestActive(activeGuest)) {
        clearSubscriptions();
        stopMicrophone();
        if ('id' in message) postToGuest({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION,
          type: 'result', id: message.id, ok: false, error: 'Extension is unavailable.', code: 'DISABLED' });
        return;
      }
      if (!ownsFrame()) return;

      if (message.type === 'hello') {
        frameDocumentRef.current += 1;
        stopLateGenerateListening();
        acknowledgeHandshake();
        clearSubscriptions();
        stopMicrophone();
        pushHostState();
        connectFileChannel();
        registerResolver();
        sendBackgroundAction();
        return;
      }

      if (message.type === 'action-result') {
        if (message.id === backgroundAction?.id) backgroundAction.complete(message.payload);
        return;
      }

      if (message.type === 'generate-late-listen') {
        if (headless) return;
        stopLateGenerateListening();
        stopLateGenerate = guestGenerateResults.listen({
          owner: generateOwner,
          deliver: (result) => {
            if (!ownsFrame() || iframeRef.current !== frame) return false;
            postToGuest(buildGenerateLateMessage(result));
            return true;
          },
        });
        return;
      }

      if (isGuestFileMessage(message)) {
        fileChannelRef.current?.receive(message);
        return;
      }

      const requestOwner = message.type === 'generate' && !headless ? generateOwner() : null;
      const requestDocument = frameDocumentRef.current;

      void answerGuestMessage(message, {
        workspaceRead: (query) => { requireSessions(); return readGuestWorkspace(query, guestIdRef.current); },
        workspaceSubscribe: ({ subscriptionId, query }) => {
          requireSessions();
          subscriptions.get(subscriptionId)?.();
          subscriptions.delete(subscriptionId);
          if (subscriptions.size >= 32) throw new HostRequestError('HOST_REJECTED', 'At most 32 workspace subscriptions per frame.');
          subscriptions.set(subscriptionId, observeGuestWorkspace(query, guestIdRef.current, (snapshot) => {
            if (ownsFrame() && guestMay(guestRef.current, 'sessions')) postToGuest({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION,
              type: 'workspace', payload: { subscriptionId, snapshot } });
          }));
        },
        workspaceUnsubscribe: (id) => { subscriptions.get(id)?.(); subscriptions.delete(id); },
        shellsSubscribe: ({ subscriptionId, scope }) => {
          requireShells();
          subscriptions.get(subscriptionId)?.();
          subscriptions.delete(subscriptionId);
          if (subscriptions.size >= 32) throw new HostRequestError('HOST_REJECTED', 'At most 32 subscriptions per frame.');
          subscriptions.set(subscriptionId, observeGuestShells(scope, (snapshot) => {
            if (ownsFrame() && guestMay(guestRef.current, 'shells')) postToGuest({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION,
              type: 'shells', payload: { subscriptionId, snapshot } });
          }));
        },
        shellsUnsubscribe: (id) => { subscriptions.get(id)?.(); subscriptions.delete(id); },
        shellOutput: async ({ shellId, cursor, tailBytes }) => {
          requireShells();
          return readGuestShellOutput(shellId, cursor, tailBytes);
        },
        shellStop: async ({ shellId }) => {
          requireShells();
          const shell = useBackgroundShellsStore.getState().byId.get(shellId);
          if (!shell) throw new HostRequestError('NOT_FOUND', 'That shell is not running.');
          if (isForegroundShellStopping(shellId)) throw new HostRequestError('HOST_REJECTED', 'That shell is already being stopped.');
          const session = useGlobalSessionsStore.getState().entityById.get(shell.sessionID);
          await opencodeClient.stopBackgroundShells({
            sessionID: shell.sessionID,
            sessionDirectory: session?.directory ?? shell.directory,
            shells: [{ shellID: shell.id, shellDirectory: shell.directory, command: shell.command }],
          });
          return { stopped: true as const };
        },
        microphoneOpen: async (sampleRate) => {
          if (!guestMay(currentGuest(), 'microphone')) throw new HostRequestError('NOT_GRANTED', NOT_GRANTED_MESSAGE);
          if (headless) throw new HostRequestError('UNSUPPORTED', 'A hidden frame cannot open the microphone.');
          if (microphoneCapture || microphoneOpening) throw new HostRequestError('HOST_REJECTED', 'The microphone is already open in this frame.');
          microphoneTicket += 1;
          const ticket = microphoneTicket;
          microphoneOpening = true;
          const mayHear = () => ticket === microphoneTicket && !disposed && iframeRef.current === frame
            && guestMay(currentGuest(), 'microphone');
          const end = (reason: GuestMicrophoneEndReason) => {
            stopMicrophone();
            if (iframeRef.current === frame) postToGuest({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION,
              type: 'microphone-ended', payload: { reason } });
          };
          let capture: GuestMicrophoneCapture;
          try {
            capture = await startGuestMicrophone({
              sampleRate,
              onSamples: (samples) => {
                if (ticket !== microphoneTicket) return;
                if (!mayHear()) { end('revoked'); return; }
                postToGuest({ channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'microphone-audio', payload: { samples } });
              },
              onDeviceLost: () => { if (ticket === microphoneTicket) end('device-lost'); },
            });
          } finally {
            if (ticket === microphoneTicket) microphoneOpening = false;
          }
          if (!mayHear()) {
            capture.stop();
            throw new HostRequestError('DISCONNECTED', 'The microphone closed while it was opening.');
          }
          microphoneCapture = capture;
          releaseListening = markGuestListening(requestingGuestId);
        },
        microphoneClose: stopMicrophone,
        storage: (request) => guestStorageOperation(requestingGuestId, request,
          installation?.storageId ? { runtimeKey, storageId: installation.storageId, authorize: ownsFrame } : undefined),
        setStatusControls: (controls) => {
          if (surface !== 'status' || !onStatusControlsRef.current) throw new HostRequestError('UNSUPPORTED', 'This frame has no status header.');
          statusControls.set(controls);
        },
        openSession: (id) => { requireSessions(); openGuestSession(id); },
        toast: (request) => {
          if (!guestEnabledRef.current) return;
          showGuestToast(request, guestIdRef.current);
        },
        openUrl: (url) => openGuestUrl(
          url,
          directoryRef.current || effectiveDirectoryRef.current || null,
          !isVSCodeRuntime() && !isMobileSurfaceRuntime(),
        ),
        openSurface: (surfaceMode) => openGuestSurface({
          mode: surfaceMode,
          directory: directoryRef.current || effectiveDirectoryRef.current || null,
          supported: !isVSCodeRuntime(),
        }),
        writeClipboard: async (text) => {
          const result = await copyTextToClipboard(text);
          return result.ok;
        },
        compose: (text, composeMode) => {
          useInputStore.getState().setPendingInputText(text, composeMode);
        },
        attach: (issue) => {
          if (onAttachRef.current) {
            onAttachRef.current(issue);
            return;
          }
          useInputStore.getState().setPendingGuestIssue(issue);
        },
        startSession: async (request) => {
          if (!guestMay(guestRef.current, 'sessions') || (request.text && !guestMay(guestRef.current, 'prompt'))) {
            return { ok: false, code: 'NOT_GRANTED', message: NOT_GRANTED_MESSAGE };
          }
          const started = await startGuestSession({
            request,
            directory: directoryRef.current || null,
            t: translateRef.current,
            assertAuthorized: () => {
              requireSessions();
              if (request.text && !guestMay(currentGuest(), 'prompt')) throw new HostRequestError('NOT_GRANTED', NOT_GRANTED_MESSAGE);
            },
          });
          if (started?.sessionId && request.navigation === 'open') {
            onSessionStartedRef.current?.();
            onDismissRef.current?.();
          }
          return started;
        },
        prompt: (request) => {
          if (request.send && !guestMay(guestRef.current, 'prompt')) {
            return Promise.resolve({ ok: false as const, code: 'NOT_GRANTED' as const, message: NOT_GRANTED_MESSAGE });
          }
          return promptGuestSession({
          request,
          sessionId: sessionIdRef.current,
          directory: directoryRef.current || null,
          busy: sessionBusyRef.current,
          compose: (text, composeMode) => {
            useInputStore.getState().setPendingInputText(text, composeMode);
          },
          t: translateRef.current,
          });
        },
        sessionLink: (issue) => linkGuestSession({
          request: issue,
          sessionId: sessionIdRef.current,
          directory: directoryRef.current || null,
          t: translateRef.current,
        }),
        close: () => {
          if (childPopover || popover) {
            const context = childPopover?.context ?? popover;
            if (context) onPopoverClosedRef.current?.({ id: context.id, reason: 'closed' });
            return;
          }
          onDismissRef.current?.();
        },
        oauthStart: async () => {
          if (!guestEnabledRef.current) return false;
          const id = guestIdRef.current;
          const previous = useGuestOauthStore.getState().byId[id]?.connection ?? EMPTY_GUEST_CONNECTION;
          const authorizationUrl = await startGuestOauth(id);
          if (!authorizationUrl || disposed || getRuntimeKey() !== runtimeKey) {
            return false;
          }
          void openExternalUrl(authorizationUrl);
          stopOauthPoll();
          const deadline = Date.now() + AUTHORIZATION_WATCH_MS;
          oauthPollRef.current = window.setInterval(() => {
            void (async () => {
              if (Date.now() > deadline) {
                stopOauthPoll();
                return;
              }
              const next = await refreshOauth(id);
              if (next && guestAuthorizationCompleted(previous, next.connection)) {
                stopOauthPoll();
              }
            })();
          }, AUTHORIZATION_POLL_MS);
          return true;
        },
        oauthDisconnect: async () => {
          const status = await disconnectGuestOauth(requestingGuestId);
          if (!status || disposed || getRuntimeKey() !== runtimeKey) {
            return false;
          }
          setOauthStatus(requestingGuestId, status);
          return true;
        },
        request: async (request) => {
          if (!guestEnabledRef.current) {
            return {
              ok: false,
              code: 'DISABLED',
              message: 'This extension is disabled in Settings → Extensions.',
            };
          }
          const hosted = await fetchHostLinearIssueGet(guestAuthRef.current, request);
          if (hosted !== undefined) {
            if (!hosted) {
              return { ok: false, code: 'HOST_REJECTED', message: 'Request failed.' };
            }
            return { ok: true, result: hosted };
          }
          const result = await proxyGuestRequest(guestIdRef.current, request);
          if (!result.ok) {
            void refreshOauth(guestIdRef.current);
          }
          return result;
        },
        serviceRequest: (request) => {
          if (!guestEnabledRef.current) {
            return Promise.resolve({
              ok: false as const,
              code: 'DISABLED' as const,
              message: 'This extension is disabled in Settings → Extensions.',
            });
          }
          return proxyGuestServiceRequest(guestIdRef.current, request, getSurfaceViewerId(guestIdRef.current));
        },
        serviceStatus: () => loadGuestServiceStatus(guestIdRef.current),
        file: (request) => {
          if (!guestEnabledRef.current) {
            return Promise.resolve({
              ok: false as const,
              code: 'DISABLED' as const,
              message: 'This extension is disabled in Settings → Extensions.',
            });
          }
          const scope = guestFileScope(request.path);
          if (!guestMay(guestRef.current, scope === 'project' ? 'files' : 'filesystem')) {
            return Promise.resolve({ ok: false as const, code: 'NOT_GRANTED' as const, message: NOT_GRANTED_MESSAGE });
          }
          const directory = directoryRef.current || null;
          if (scope === 'project' && !directory) {
            return Promise.resolve({ ok: false as const, code: 'NO_DIRECTORY' as const, message: 'No project is open.' });
          }
          return guestFileOperation(guestIdRef.current, request, directory);
        },
        generate: (request) => {
          if (!guestEnabledRef.current) {
            return Promise.resolve({
              ok: false as const,
              code: 'DISABLED' as const,
              message: 'This extension is disabled in Settings → Extensions.',
            });
          }
          if (!guestMay(guestRef.current, 'model')) {
            return Promise.resolve({ ok: false as const, code: 'NOT_GRANTED' as const, message: NOT_GRANTED_MESSAGE });
          }
          return guestGenerate(
            guestIdRef.current,
            request,
            directoryRef.current || null,
            {
              providerID: useConfigStore.getState().currentProviderId || null,
              modelID: useConfigStore.getState().currentModelId || null,
            },
          );
        },
        setBadge: (count) => {
          if (!guestEnabledRef.current) return;
          useGuestBadgeStore.getState().setBadge(guestIdRef.current, count);
        },
        openCommit: (sha) => {
          const git = getRegisteredRuntimeAPIs()?.git ?? null;
          return openGuestCommit({
          sha,
          directory: directoryRef.current || null,
          git,
          currentBranch: (dir) => (git ? readCurrentBranch(git, dir) : Promise.resolve(null)),
          supported: !isVSCodeRuntime(),
          });
        },
        resize: (height) => {
          onResizeRef.current?.(height);
        },
        answerBlock: (text) => {
          const answer = blockRef.current?.answer;
          if (!answer) return Promise.reject(new Error('Only a block in the chat can answer the agent.'));
          const clicked = !navigator.userActivation || navigator.userActivation.isActive;
          if (!clicked || document.activeElement !== iframeRef.current) return Promise.reject(new Error('answerBlock works only from a click.'));
          return answer(text);
        },
        resolveResult: (id, payload: ResolveResultPayload) => {
          const waiter = resolveWaitersRef.current.get(id);
          if (!waiter) return;
          if ('error' in payload) {
            waiter({ ok: false, reason: 'error', message: payload.error });
            return;
          }
          waiter({ ok: true, item: payload.item });
        },
        openPopover: (request) => {
          if (childPopover || popover || headless || isVSCodeRuntime()
            || !(surface === 'panel' || surface === 'page' || surface === 'status')) {
            throw new HostRequestError('UNSUPPORTED', 'This frame cannot open a popover.');
          }
          const frameBounds = iframeRef.current?.getBoundingClientRect();
          const frame = iframeRef.current;
          if (!frameBounds || !frame) throw new HostRequestError('HOST_REJECTED', 'The popover owner is unavailable.');
          if (guestPopoverOwnerBlocked(frame)) {
            throw new HostRequestError('HOST_REJECTED', 'A host dialog is active.');
          }
          const ownerFocused = document.activeElement === frame;
          if (request.focus && !ownerFocused) {
            throw new HostRequestError('HOST_REJECTED', 'Popover focus requires keyboard interaction with its owner.');
          }
          const position = positionGuestPopover({
            anchor: request.anchor,
            width: request.width,
            height: request.height,
            side: request.side,
            frame: {
              left: frameBounds.left, top: frameBounds.top, width: frameBounds.width, height: frameBounds.height,
              clientWidth: frame.clientWidth, clientHeight: frame.clientHeight,
            },
            viewport: { width: window.innerWidth, height: window.innerHeight },
          });
          if (!position) throw new HostRequestError('HOST_REJECTED', 'The popover anchor is not visible.');
          if (!guestEntry) throw new HostRequestError('UNSUPPORTED', 'This extension has no entry for a popover.');
          const capturedDirectory = directoryRef.current ?? '';
          const activation = getGuestPopoverController(document).claim({
            id: request.id,
            authorize: () => ownsFrame() && directoryRef.current === capturedDirectory && !guestPopoverOwnerBlocked(frame),
            close: (reason) => closeActivePopoverRef.current(reason),
          });
          const next = { request, position, entry: guestEntry, directory: capturedDirectory, activation };
          popoverAnchorActiveRef.current = true;
          popoverOverlayActiveRef.current = false;
          activePopoverRef.current = next;
          setActivePopover(next);
        },
        closePopover: (id, reason) => {
          if (childPopover || popover) {
            const context = childPopover?.context ?? popover;
            if (id !== context?.id) throw new HostRequestError('HOST_REJECTED', 'A popover may close only itself.');
            onPopoverClosedRef.current?.({ id, reason: reason ?? 'closed' });
            return;
          }
          if (activePopoverRef.current?.request.id === id) closeActivePopover(reason ?? 'closed');
        },
        setPopoverAnchorActive: (id, active) => {
          if (childPopover || popover) {
            const context = childPopover?.context ?? popover;
            if (id !== context?.id) throw new HostRequestError('HOST_REJECTED', 'A popover may report only its own activity.');
            onPopoverActivityRef.current?.(active);
            return;
          }
          if (activePopoverRef.current?.request.id !== id || popoverOpensAsSheet()) return;
          clearPopoverCloseTimer();
          popoverAnchorActiveRef.current = active;
          if (!active) {
            schedulePopoverClose(activePopoverRef.current.activation, 'anchor');
          }
        },
      }).then((reply) => {
        if (!reply) return;
        const deliverable = ownsFrame() && frame === iframeRef.current;
        if (message.type === 'generate' && requestOwner && !(deliverable && frameDocumentRef.current === requestDocument)) {
          const late = lateGenerateResult(message.payload, reply);
          if (late) guestGenerateResults.keep(requestOwner, late);
          return;
        }
        if (deliverable) postToGuest(reply);
      });
    };

    window.addEventListener('message', onMessage);
    return () => {
      disposed = true;
      if (!childPopover) closeActivePopover('owner');
      statusControls.dispose();
      if (statusControlsRef.current === statusControls) statusControlsRef.current = null;
      clearSubscriptions();
      stopMicrophone();
      stopLateGenerateListening();
      runtimeUnsubscribe();
      window.removeEventListener('message', onMessage);
    };
  }, [acknowledgeHandshake, backgroundAction, clearPopoverCloseTimer, closeActivePopover, connectFileChannel, frameKey, guestEnabled, guestEntry, headless, popover, postToGuest, pushHostState, refreshOauth, registerResolver, schedulePopoverClose, sendBackgroundAction, setOauthStatus, src, srcDoc, stopOauthPoll, surface]);

  React.useLayoutEffect(() => { statusControlsRef.current?.retire(); }, [statusContextKey]);

  React.useEffect(() => {
    if (backgroundAction && (frameStatus === 'error' || !guestEnabled)) {
      backgroundAction.complete({ ok: false, reason: 'unavailable' });
    }
  }, [backgroundAction, frameStatus, guestEnabled]);

  const backgroundMountedRef = React.useRef(false);
  React.useEffect(() => {
    backgroundMountedRef.current = true;
    return () => {
      backgroundMountedRef.current = false;
      queueMicrotask(() => {
        if (!backgroundMountedRef.current) backgroundAction?.complete({ ok: false, reason: 'unavailable' });
      });
    };
  }, [backgroundAction]);

  React.useEffect(() => () => stopOauthPoll(), [frameKey, stopOauthPoll]);

  React.useEffect(() => {
    pushHostState();
  }, [pushHostState, ready, directory]);

  React.useEffect(() => {
    if (headless || surface === 'status' || surface === 'file' || surface === 'popover' || surface === 'block' || surface === 'page' || catalogStatus !== 'ready' || guest?.entry) {
      return;
    }
    closeGuestTabsEverywhere(mode);
    onDismiss?.();
  }, [catalogStatus, guest?.entry, headless, mode, onDismiss, surface]);

  React.useEffect(() => {
    if (!currentSessionId || !lifecyclePhase) {
      return;
    }
    postToGuest(buildSessionLifecycleMessage({
      sessionId: currentSessionId,
      phase: lifecyclePhase,
    }));
  }, [currentSessionId, lifecyclePhase, postToGuest]);

  if (!guest && catalogStatus !== 'ready' && catalogStatus !== 'error') {
    return null;
  }

  if (!guest || (!src && !srcDoc)) {
    return (
      <div className="flex h-full items-center justify-center gap-3 px-6 text-sm text-muted-foreground">
        {guest && frameStatus === 'loading'
          ? t('common.loading')
          : t(surface === 'block' ? 'contextPanel.plugin.blockLoadFailed' : 'contextPanel.plugin.loadFailed')}
        {guest && frameStatus === 'error' ? (
          <Button type="button" variant="outline" size="sm" onClick={retryFrame}>{t('terminalView.actions.tryAgain')}</Button>
        ) : null}
      </div>
    );
  }

  if (!guestEnabled) {
    return null;
  }

  const sheet = popoverOpensAsSheet();
  const popoverChild = activePopover ? (
    <DockedPanelSurfaceContext.Provider value={false}>
    <PluginPane
      mode={mode}
      surface="popover"
      item={null}
      popoverHost={{
        entry: activePopover.entry,
        directory: activePopover.directory,
        context: { id: activePopover.request.id, data: activePopover.request.data },
        activation: activePopover.activation,
        focus: Boolean(activePopover.request.focus),
      }}
      isActive={() => getGuestPopoverController(document).authorize(activePopover.activation)}
      onResize={(height) => {
        const current = activePopoverRef.current;
        const frame = iframeRef.current;
        if (!current || current.activation !== activePopover.activation || !frame
          || !getGuestPopoverController(document).authorize(current.activation)) return;
        const nextHeight = Math.max(GUEST_POPOVER_HEIGHT_MIN, Math.min(GUEST_POPOVER_HEIGHT_MAX, height + (sheet ? 0 : 2)));
        if (current.request.height === nextHeight) return;
        const request = { ...current.request, height: nextHeight };
        if (sheet) {
          const next = { ...current, request };
          activePopoverRef.current = next;
          setActivePopover(next);
          return;
        }
        const bounds = frame.getBoundingClientRect();
        const position = positionGuestPopover({
          ...request,
          frame: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
            clientWidth: frame.clientWidth, clientHeight: frame.clientHeight },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
        if (!position) { closeActivePopover('anchor'); return; }
        const next = { ...current, request, position };
        activePopoverRef.current = next;
        setActivePopover(next);
      }}
      onPopoverClosed={(event) => {
        if (activePopoverRef.current?.request.id === event.id) closeActivePopover(event.reason);
      }}
      onPopoverActivity={(active) => {
        if (sheet || activePopoverRef.current?.activation !== activePopover.activation) return;
        popoverOverlayActiveRef.current = active;
        if (active) clearPopoverCloseTimer();
        else schedulePopoverClose(activePopover.activation, 'outside');
      }}
    />
    </DockedPanelSurfaceContext.Provider>
  ) : null;
  const popoverOverlay = !activePopover ? null : sheet ? (
    <GuestPopoverSheet height={activePopover.request.height} label={guest.name} ownerFrame={iframeRef.current} onClose={() => closeActivePopover('outside')}>
      {popoverChild}
    </GuestPopoverSheet>
  ) : (
    <GuestPopover
      position={activePopover.position}
      focused={Boolean(activePopover.request.focus)}
      label={guest.name}
      ownerFrame={iframeRef.current}
      onClose={(reason) => closeActivePopover(reason)}
      onEnter={() => {
        popoverOverlayActiveRef.current = true;
        clearPopoverCloseTimer();
      }}
      onLeave={() => {
        popoverOverlayActiveRef.current = false;
        schedulePopoverClose(activePopover.activation, 'outside');
      }}
      onOutsideHover={() => {
        if (!popoverAnchorActiveRef.current && !popoverOverlayActiveRef.current && popoverCloseTimerRef.current !== null) return;
        popoverAnchorActiveRef.current = false;
        popoverOverlayActiveRef.current = false;
        schedulePopoverClose(activePopover.activation, 'outside');
      }}
    >
      {popoverChild}
    </GuestPopover>
  );

  return (
    <>
      <iframe
      ref={iframeRef}
      key={frameKey}
      title={guest.name}
      src={src || undefined}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      style={{ colorScheme: currentTheme.metadata.variant === 'dark' ? 'dark' : 'light' }}
      className={cn(
        'h-full w-full min-h-0 min-w-0 border-0 overflow-hidden',
        surface === 'dialog' || surface === 'status' || surface === 'popover' || surface === 'block' ? 'bg-transparent' : 'bg-[var(--surface-background)]',
      )}
      onLoad={() => {
        if (!popoverHost && !popover) closeActivePopover('owner');
        if (popoverHost?.focus && isActiveRef.current?.()) iframeRef.current?.focus();
        if (recoverExpiredNavigation()) return;
        pushHostState();
        connectFileChannel();
        registerResolver();
        sendBackgroundAction();
      }}
      />
      {popoverOverlay}
    </>
  );
};
