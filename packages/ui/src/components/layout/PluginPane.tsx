import React from 'react';
import { toast } from 'sonner';
import {
  EMPTY_GUEST_CONNECTION,
  GUEST_REQUEST_TIMEOUT_MS,
  guestFileScope,
  type AttachIssueRequest,
  type GuestHostSurface,
  type GuestItem,
  type GuestMessage,
  type HostMessage,
  type HostReadyContext,
  type ResolveResultPayload,
} from '@openchamber/sdk';
import { guestMessageSchema } from '@openchamber/sdk/schemas';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import {
  answerGuestMessage,
  buildConnectionMessage,
  buildDirectoryMessage,
  buildItemMessage,
  buildReadyMessage,
  buildResolveMessage,
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
import { registerGuestResolver, type GuestResolveOutcome } from '@/lib/guests/resolve';
import { resolveGuestFrameUrl } from '@/lib/guests/frame-url';
import { useGuestItemStore } from '@/lib/guests/item-store';
import { fetchHostLinearIssueGet } from '@/lib/guests/host-linear-request';
import { loadGuestServiceStatus, proxyGuestServiceRequest } from '@/lib/guests/service';
import {
  AUTHORIZATION_POLL_MS,
  AUTHORIZATION_WATCH_MS,
  disconnectGuestOauth,
  guestAuthorizationCompleted,
  proxyGuestRequest,
  startGuestOauth,
} from '@/lib/guests/oauth';
import { useGuestOauthStore } from '@/lib/guests/oauth-store';
import { linkGuestSession, promptGuestSession, startGuestSession } from '@/lib/guests/start-session';
import { useGuestsStore } from '@/lib/guests/store';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { closeGuestTabsEverywhere } from '@/lib/guests/tabs';
import { pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { useUIStore } from '@/stores/useUIStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession, useSessionStatus } from '@/sync/sync-context';

type PluginPaneProps = {
  mode: PluginContextPanelMode;
  surface?: GuestHostSurface;
  /**
   * The item this surface was opened for (`ready.item`). The dialog passes
   * it explicitly; the rail pane takes it from `useGuestItemStore` when this
   * prop is left undefined.
   */
  item?: GuestItem | null;
  /**
   * Mounted off-screen only to answer a slash command: never takes a parked
   * item and never clears the badge, because the user did not open it.
   */
  headless?: boolean;
  onDismiss?: () => void;
  onAttach?: (issue: AttachIssueRequest) => void;
  onSessionStarted?: () => void;
};

// Sandboxed frames without allow-same-origin have an opaque origin.
// The string "null" is not a legal postMessage targetOrigin; browsers throw.
// Isolation is the unique contentWindow plus event.source on receive.
const OPAQUE_FRAME_TARGET_ORIGIN = '*';

const HOST_FONT_FALLBACK = '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const HOST_MONO_FALLBACK = 'ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace';
const HOST_RADIUS_FALLBACK = '0.5625rem';

// Sent to the guest, not shown by the host; the guest decides how to surface it.
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

export const PluginPane: React.FC<PluginPaneProps> = ({
  mode,
  surface = 'panel',
  item: itemProp,
  headless = false,
  onDismiss,
  onAttach,
  onSessionStarted,
}) => {
  const { t, locale } = useI18n();
  const { currentTheme } = useThemeSystem();
  const directory = useEffectiveDirectory();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const session = useSession(currentSessionId, directory || undefined);
  const sessionStatus = useSessionStatus(currentSessionId ?? '', directory || undefined);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const guestId = pluginIdFromMode(mode);
  const guest = useGuestsStore((state) => state.guests.find((entry) => entry.id === guestId) ?? null);
  const catalogStatus = useGuestsStore((state) => state.status);
  // Paused or not yet approved: the frame stays down and every effect refuses.
  const guestEnabled = guest ? isGuestActive(guest) : true;
  const oauthStatus = useGuestOauthStore((state) => state.byId[guestId]);
  const setOauthStatus = useGuestOauthStore((state) => state.setStatus);
  const refreshOauth = useGuestOauthStore((state) => state.refresh);
  // A chip click parks the item under this guest's id; take it (clearing the
  // slot) so a later mount of the same pane starts without a stale item.
  const pendingItem = useGuestItemStore((state) => state.pendingItemByGuest[guestId]);
  const takePendingItem = useGuestItemStore((state) => state.takePendingItem);
  const [railItem, setRailItem] = React.useState<GuestItem | null>(null);
  React.useEffect(() => {
    if (headless || itemProp !== undefined || !pendingItem) return;
    setRailItem(takePendingItem(guestId));
  }, [guestId, headless, itemProp, pendingItem, takePendingItem]);
  const item = headless ? null : itemProp !== undefined ? itemProp : railItem;
  // The user opened this guest's panel: whatever it counted is seen.
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
          title: session?.title,
          busy: sessionBusy,
          model: guestSessionModelId(session?.model),
          agent: session?.agent,
        }
        : null,
    ),
    [currentSessionId, session, sessionBusy],
  );

  const ready = React.useMemo<HostReadyContext>(() => ({
    theme: {
      mode: currentTheme.metadata.variant === 'dark' ? 'dark' : 'light',
      tokens: {
        background: currentTheme.colors.surface.background,
        elevated: currentTheme.colors.surface.elevated,
        foreground: currentTheme.colors.surface.foreground,
        muted: currentTheme.colors.surface.mutedForeground,
        subtle: currentTheme.colors.surface.subtle,
        border: currentTheme.colors.interactive.border,
        hover: currentTheme.colors.interactive.hover,
        selection: currentTheme.colors.interactive.selection,
        focus: currentTheme.colors.interactive.focusRing,
        primary: currentTheme.colors.primary.base,
        mutedSurface: currentTheme.colors.surface.muted,
        elevatedForeground: currentTheme.colors.surface.elevatedForeground,
        active: currentTheme.colors.interactive.active,
        selectionForeground: currentTheme.colors.interactive.selectionForeground,
        // Same fallback the app's CSS generator uses for themes without one.
        primaryForeground: currentTheme.colors.primary.foreground ?? '#ffffff',
        success: currentTheme.colors.status.success,
        warning: currentTheme.colors.status.warning,
        error: currentTheme.colors.status.error,
        info: currentTheme.colors.status.info,
        font: readCssVar('--font-sans', HOST_FONT_FALLBACK),
        mono: readCssVar('--font-mono', HOST_MONO_FALLBACK),
        radius: readCssVar('--radius', HOST_RADIUS_FALLBACK),
      },
    },
    locale,
    directory: directory || null,
    session: sessionSnapshot,
    surface,
    connection: oauthStatus?.connection ?? EMPTY_GUEST_CONNECTION,
    settings: oauthStatus?.settings ?? {},
    item,
  }), [currentTheme, directory, item, locale, oauthStatus, sessionSnapshot, surface]);

  const frameKey = `${guestId}:service-${guest?.service?.granted ? '1' : '0'}`;

  // Minted per mount (and per remount via frameKey): the token in this URL is
  // scoped to the guest's files and short-lived, so it is never reused.
  // The attach dialog may load its own page; the rail always loads panel.entry.
  const guestEntry = guest ? (surface === 'dialog' && guest.attachEntry ? guest.attachEntry : guest.entry) : null;
  const [src, setSrc] = React.useState('');
  React.useEffect(() => {
    if (!guestEntry) {
      setSrc('');
      return;
    }
    let cancelled = false;
    setSrc('');
    resolveGuestFrameUrl(guestId, guestEntry)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        // Leave src empty: the pane shows its failed state instead of an unauthenticated frame.
      });
    return () => {
      cancelled = true;
    };
  }, [guestEntry, guestId, frameKey]);

  const readyRef = React.useRef(ready);
  readyRef.current = ready;
  const directoryRef = React.useRef(directory);
  directoryRef.current = directory;
  const sessionIdRef = React.useRef(currentSessionId);
  sessionIdRef.current = currentSessionId;
  const sessionBusyRef = React.useRef(sessionBusy);
  sessionBusyRef.current = sessionBusy;
  const guestIdRef = React.useRef(guestId);
  guestIdRef.current = guestId;
  const guestEnabledRef = React.useRef(guestEnabled);
  guestEnabledRef.current = guestEnabled;
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
  const oauthPollRef = React.useRef<number | null>(null);
  // Outstanding `resolve` requests this pane sent; answered by `resolve-result`.
  const resolveWaitersRef = React.useRef(new Map<string, (outcome: GuestResolveOutcome) => void>());
  const resolveIdsRef = React.useRef(0);

  const stopOauthPoll = React.useCallback(() => {
    if (oauthPollRef.current != null) {
      window.clearInterval(oauthPollRef.current);
      oauthPollRef.current = null;
    }
  }, []);

  const postToGuest = React.useCallback((message: HostMessage) => {
    iframeRef.current?.contentWindow?.postMessage(message, OPAQUE_FRAME_TARGET_ORIGIN);
  }, []);

  // Registered once the guest has connected (hello or iframe load), so a
  // resolve is never posted into a frame that is not listening yet. The rail
  // pane and a headless pane both register; the composer asks whichever is up.
  const resolverReadyRef = React.useRef(false);
  const unregisterResolverRef = React.useRef<(() => void) | null>(null);
  const registerResolver = React.useCallback(() => {
    if (resolverReadyRef.current || surface !== 'panel') return;
    resolverReadyRef.current = true;
    unregisterResolverRef.current = registerGuestResolver(guestIdRef.current, (request) => new Promise((resolve) => {
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
    }));
  }, [surface]);
  React.useEffect(() => () => {
    unregisterResolverRef.current?.();
    unregisterResolverRef.current = null;
    resolverReadyRef.current = false;
    for (const waiter of resolveWaitersRef.current.values()) {
      waiter({ ok: false, reason: 'unavailable' });
    }
    resolveWaitersRef.current.clear();
  }, [frameKey]);

  const pushHostState = React.useCallback(() => {
    postToGuest(buildReadyMessage(readyRef.current));
    postToGuest(buildDirectoryMessage(directoryRef.current || null));
    postToGuest(buildSessionMessage(readyRef.current.session));
    postToGuest(buildConnectionMessage(readyRef.current.connection));
    postToGuest(buildSettingsMessage(readyRef.current.settings));
    postToGuest(buildItemMessage(readyRef.current.item));
  }, [postToGuest]);

  React.useEffect(() => {
    if (!guest?.integration) {
      return;
    }
    void refreshOauth(guest.id);
  }, [guest?.id, guest?.integration, refreshOauth]);

  React.useEffect(() => {
    if (guest && !guestEnabled) {
      onDismiss?.();
    }
  }, [guest, guestEnabled, onDismiss]);

  // Remount when service grant flips so the guest leaves its "unavailable" empty state.
  // Resolve the frame from the ref on every message: a key remount replaces the
  // element without changing `src`, so a captured contentWindow would go stale.

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const parsed = guestMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      // The frame's identity is the guest id; a payload naming another
      // provider would attach or link under a different guest's name.
      const message = withOwnProviderId(parsed.data, guestIdRef.current);

      if (message.type === 'hello') {
        pushHostState();
        registerResolver();
        return;
      }

      void answerGuestMessage(message, {
        toast: (kind, toastMessage) => {
          // Full pause: a disabled guest must not spam host toasts while the frame tears down.
          if (!guestEnabledRef.current) return;
          if (kind === 'success') toast.success(toastMessage);
          else if (kind === 'error') toast.error(toastMessage);
          else toast.info(toastMessage);
        },
        openUrl: openExternalUrl,
        openSurface: (surfaceMode) => {
          const dir = directoryRef.current || '';
          if (dir) useUIStore.getState().openContextSurface(dir, surfaceMode);
        },
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
          });
          if (started) {
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
          onDismissRef.current?.();
        },
        oauthStart: async () => {
          if (!guestEnabledRef.current) return false;
          const id = guestIdRef.current;
          const previous = useGuestOauthStore.getState().byId[id]?.connection ?? EMPTY_GUEST_CONNECTION;
          const authorizationUrl = await startGuestOauth(id);
          if (!authorizationUrl) {
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
          const status = await disconnectGuestOauth(guestIdRef.current);
          if (!status) {
            return false;
          }
          setOauthStatus(guestIdRef.current, status);
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
          return proxyGuestServiceRequest(guestIdRef.current, request);
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
          // Mirrors the server: the answer it would give comes back without a round trip.
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
        setBadge: (count) => {
          if (!guestEnabledRef.current) return;
          useGuestBadgeStore.getState().setBadge(guestIdRef.current, count);
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
      }).then((reply) => {
        if (reply) postToGuest(reply);
      });
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [frameKey, postToGuest, pushHostState, refreshOauth, registerResolver, setOauthStatus, src, stopOauthPoll]);

  // The OAuth poll outlives listener re-attachment: it only stops when the
  // frame goes away, otherwise a parent re-render mid-authorization would
  // leave the panel reporting "not connected" after the browser round trip.
  React.useEffect(() => () => stopOauthPoll(), [frameKey, stopOauthPoll]);

  React.useEffect(() => {
    pushHostState();
  }, [pushHostState, ready, directory]);

  React.useEffect(() => {
    if (catalogStatus !== 'ready' || guest) {
      return;
    }
    closeGuestTabsEverywhere(mode);
  }, [catalogStatus, guest, mode]);

  React.useEffect(() => {
    if (!currentSessionId || !lifecyclePhase) {
      return;
    }
    postToGuest(buildSessionLifecycleMessage({
      sessionId: currentSessionId,
      phase: lifecyclePhase,
    }));
  }, [currentSessionId, lifecyclePhase, postToGuest]);

  // A persisted plugin tab renders before the catalog answers. Silence until
  // it does; an uninstalled guest's tabs are closed by the effect above.
  if (!guest && catalogStatus !== 'ready' && catalogStatus !== 'error') {
    return null;
  }

  if (!guest || !src) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        {t('contextPanel.plugin.loadFailed')}
      </div>
    );
  }

  if (!guestEnabled) {
    return null;
  }

  return (
    <iframe
      ref={iframeRef}
      key={frameKey}
      title={guest.name}
      src={src}
      sandbox="allow-scripts"
      className={cn(
        'h-full w-full min-h-0 min-w-0 border-0 overflow-hidden',
        surface === 'dialog' ? 'bg-transparent' : 'bg-[var(--surface-background)]',
      )}
      onLoad={() => {
        pushHostState();
        registerResolver();
      }}
    />
  );
};
