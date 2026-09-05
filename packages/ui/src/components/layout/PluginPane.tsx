import React from 'react';
import { toast } from 'sonner';
import {
  EMPTY_GUEST_CONNECTION,
  guestMessageSchema,
  type AttachIssueRequest,
  type GuestHostSurface,
  type HostMessage,
  type HostReadyContext,
} from '@openchamber/sdk';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import {
  answerGuestMessage,
  buildConnectionMessage,
  buildDirectoryMessage,
  buildReadyMessage,
  buildSessionLifecycleMessage,
  buildSessionMessage,
  buildSettingsMessage,
  guestSessionLifecyclePhase,
  guestSessionModelId,
  toGuestSessionSnapshot,
} from '@/lib/guests/host-bridge';
import { fetchHostLinearIssueGet } from '@/lib/guests/host-linear-request';
import { loadGuestAgentStatus, proxyGuestAgentRequest } from '@/lib/guests/agent';
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
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { useUIStore } from '@/stores/useUIStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession, useSessionStatus } from '@/sync/sync-context';

type PluginPaneProps = {
  mode: PluginContextPanelMode;
  surface?: GuestHostSurface;
  onDismiss?: () => void;
  onAttach?: (issue: AttachIssueRequest) => void;
  onSessionStarted?: () => void;
};

// Sandboxed frames without allow-same-origin have an opaque origin.
// The string "null" is not a legal postMessage targetOrigin; browsers throw.
// Isolation is the unique contentWindow plus event.source on receive.
const OPAQUE_FRAME_TARGET_ORIGIN = '*';

const HOST_FONT_FALLBACK = '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const HOST_RADIUS_FALLBACK = '0.5625rem';

const readCssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
};

export const PluginPane: React.FC<PluginPaneProps> = ({
  mode,
  surface = 'panel',
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
  const oauthStatus = useGuestOauthStore((state) => state.byId[guestId]);
  const setOauthStatus = useGuestOauthStore((state) => state.setStatus);
  const refreshOauth = useGuestOauthStore((state) => state.refresh);
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
        font: readCssVar('--font-sans', HOST_FONT_FALLBACK),
        radius: readCssVar('--radius', HOST_RADIUS_FALLBACK),
      },
    },
    locale,
    directory: directory || null,
    session: sessionSnapshot,
    surface,
    connection: oauthStatus?.connection ?? EMPTY_GUEST_CONNECTION,
    settings: oauthStatus?.settings ?? {},
  }), [currentTheme, directory, locale, oauthStatus, sessionSnapshot, surface]);

  const src = React.useMemo(() => {
    if (!guest) return '';
    return getRuntimeUrlResolver().authenticatedAsset(`/api/guests/${guest.id}/${guest.entry}?oc_ui=issue-page`);
  }, [guest]);

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
  const guestAuthRef = React.useRef(guest?.integration?.auth);
  guestAuthRef.current = guest?.integration?.auth;
  const translateRef = React.useRef(t);
  translateRef.current = t;
  const onAttachRef = React.useRef(onAttach);
  onAttachRef.current = onAttach;
  const onSessionStartedRef = React.useRef(onSessionStarted);
  onSessionStartedRef.current = onSessionStarted;
  const oauthPollRef = React.useRef<number | null>(null);

  const stopOauthPoll = React.useCallback(() => {
    if (oauthPollRef.current != null) {
      window.clearInterval(oauthPollRef.current);
      oauthPollRef.current = null;
    }
  }, []);

  const postToGuest = React.useCallback((message: HostMessage) => {
    iframeRef.current?.contentWindow?.postMessage(message, OPAQUE_FRAME_TARGET_ORIGIN);
  }, []);

  const pushHostState = React.useCallback(() => {
    postToGuest(buildReadyMessage(readyRef.current));
    postToGuest(buildDirectoryMessage(directoryRef.current || null));
    postToGuest(buildSessionMessage(readyRef.current.session));
    postToGuest(buildConnectionMessage(readyRef.current.connection));
    postToGuest(buildSettingsMessage(readyRef.current.settings));
  }, [postToGuest]);

  React.useEffect(() => {
    if (!guest?.integration) {
      return;
    }
    void refreshOauth(guest.id);
  }, [guest?.id, guest?.integration, refreshOauth]);

  // Remount when agent grant flips so the guest leaves its "unavailable" empty state.
  // Resolve the frame from the ref on every message: a key remount replaces the
  // element without changing `src`, so a captured contentWindow would go stale.
  const frameKey = `${guestId}:agent-${guest?.agent?.granted ? '1' : '0'}`;

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const parsed = guestMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;

      if (message.type === 'hello') {
        pushHostState();
        return;
      }

      void answerGuestMessage(message, {
        toast: (kind, toastMessage) => {
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
          const started = await startGuestSession({
            request,
            directory: directoryRef.current || null,
            t: translateRef.current,
          });
          if (started) {
            onSessionStartedRef.current?.();
            onDismiss?.();
          }
          return started;
        },
        prompt: (request) => promptGuestSession({
          request,
          sessionId: sessionIdRef.current,
          directory: directoryRef.current || null,
          busy: sessionBusyRef.current,
          compose: (text, composeMode) => {
            useInputStore.getState().setPendingInputText(text, composeMode);
          },
          t: translateRef.current,
        }),
        sessionLink: (issue) => linkGuestSession({
          request: issue,
          sessionId: sessionIdRef.current,
          directory: directoryRef.current || null,
          t: translateRef.current,
        }),
        close: () => {
          onDismiss?.();
        },
        oauthStart: async () => {
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
        agentRequest: (request) => proxyGuestAgentRequest(guestIdRef.current, request),
        agentStatus: () => loadGuestAgentStatus(guestIdRef.current),
      }).then((reply) => {
        if (reply) postToGuest(reply);
      });
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      stopOauthPoll();
    };
  }, [frameKey, onDismiss, postToGuest, pushHostState, refreshOauth, setOauthStatus, src, stopOauthPoll]);

  React.useEffect(() => {
    pushHostState();
  }, [pushHostState, ready, directory]);

  React.useEffect(() => {
    if (!currentSessionId || !lifecyclePhase) {
      return;
    }
    postToGuest(buildSessionLifecycleMessage({
      sessionId: currentSessionId,
      phase: lifecyclePhase,
    }));
  }, [currentSessionId, lifecyclePhase, postToGuest]);

  if (!guest || !src) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
        {t('contextPanel.plugin.loadFailed')}
      </div>
    );
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
      onLoad={pushHostState}
    />
  );
};
