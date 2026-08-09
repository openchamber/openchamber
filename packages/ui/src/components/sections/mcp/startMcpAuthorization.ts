import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';
import { focusDesktopWindow, isDesktopShell } from '@/lib/desktop';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { MCP_OAUTH_CALLBACK_PATH, parseMcpOAuthCallbackStateKey } from './mcpOAuth';

/**
 * Starting MCP authorization, for every surface that offers it.
 *
 * A server in `needs_auth` cannot be fixed by reconnecting: `POST /mcp/:name/connect`
 * just repeats the attempt that produced `needs_auth` in the first place. The
 * flow OpenCode expects is explicit — ask for an authorization URL, send the
 * user to it, then hand the returned code back:
 *
 *   POST /mcp/:name/auth           → { authorizationUrl, oauthState }
 *   (user authorises in a browser)
 *   POST /mcp/:name/auth/callback  → status
 *
 * OpenCode does not open the browser for this flow; that is the caller's job.
 *
 * The redirect URI matters as much as the call. Without one of ours in the
 * server's config, OpenCode falls back to its own loopback listener on
 * 127.0.0.1 — which only works when the browser runs on the same machine as
 * the OpenCode process. For a remote or web client the callback would simply
 * never arrive, so the first authorization writes our own callback URL into
 * the config before asking for the URL.
 */

type McpAuthorizationStart = {
  authorizationUrl: string;
  /** False when the runtime refused to open a browser; the caller then offers a manual paste. */
  opened: boolean;
};

class McpAuthorizationError extends Error {}

/**
 * The callback lands in the system browser, which is a different surface from
 * the desktop app. Recording where the flow began lets the callback page hand
 * control back correctly: a browser session returns to the app it is already
 * showing, while the desktop shell has to be raised through its own deep link.
 *
 * This travels with the pending context, not in the redirect URI. That URI is
 * written into the server's config once and never rewritten, so a marker
 * encoded there would be frozen at whatever runtime happened to authorise
 * first — a desktop user would keep being sent to the web UI forever.
 */
export const MCP_OAUTH_ORIGIN_DESKTOP = 'desktop';

/**
 * Stable for a given server, whatever session is open.
 *
 * It used to carry the directory as well, which made the address different for
 * every worktree: switching sessions produced a new value, so the config was
 * rewritten and OpenCode reloaded in front of the user. The directory is not
 * needed here — authorization is not per-directory — and the pending context
 * parked under the OAuth `state` carries it for the completion call.
 *
 * The server name stays. It never varies for a given entry, since the redirect
 * lives in that entry's own config, and it lets the callback page identify the
 * server straight from the URL rather than depending solely on server-side
 * memory surviving the reload this very write triggers.
 */
export const buildMcpAuthorizationRedirectUri = (name: string): string => {
  if (typeof window === 'undefined') {
    throw new McpAuthorizationError('No browser context to build a callback URL from');
  }
  const url = new URL(MCP_OAUTH_CALLBACK_PATH, getRuntimeApiBaseUrl() || window.location.origin);
  url.searchParams.set('server', name);
  return url.toString();
};

/**
 * Correlates the eventual browser redirect with the server it belongs to. The
 * callback page has only the OAuth `state` to go on, so the pair is parked
 * server-side under that key.
 */
const queuePendingContext = async (input: {
  state: string;
  name: string;
  directory?: string | null;
  origin: string | null;
}): Promise<void> => {
  const response = await runtimeFetch('/api/mcp/auth/pending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: input.state,
      name: input.name,
      directory: input.directory?.trim() ? input.directory.trim() : null,
      origin: input.origin,
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new McpAuthorizationError(payload?.error || 'Failed to prepare the MCP authorization callback');
  }
};

const clearPendingContext = async (state: string | null): Promise<void> => {
  if (!state) return;
  await runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(state)}`, { method: 'DELETE' })
    .catch(() => undefined);
};

/** How long the user plausibly spends authorising before giving up on them. */
const AUTHORIZATION_WATCH_MS = 3 * 60_000;
const AUTHORIZATION_POLL_MS = 1_500;

const waitForAuthorizationThenFocus = async (name: string, directory: string | null): Promise<void> => {
  const deadline = Date.now() + AUTHORIZATION_WATCH_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, AUTHORIZATION_POLL_MS));
    try {
      await useMcpStore.getState().refresh({ directory, silent: true });
    } catch {
      continue;
    }
    const status = useMcpStore.getState().getStatusForDirectory(directory)[name]?.status;
    if (status === 'connected') {
      void focusDesktopWindow();
      return;
    }
  }
};

export const startMcpAuthorization = async (input: {
  name: string;
  directory?: string | null;
  /** VS Code cannot receive our callback route, so it keeps OpenCode's own redirect. */
  skipRedirectUriBootstrap?: boolean;
}): Promise<McpAuthorizationStart> => {
  const { name, directory } = input;
  let queuedState: string | null = null;

  try {
    if (!input.skipRedirectUriBootstrap) {
      // The config has to be loaded before its absence can mean anything. On
      // the first authorization after launch the store is often still empty,
      // and reading it then reported "no redirect URI" for a server that had
      // one — so the config was rewritten needlessly and OpenCode reloaded in
      // front of the user for no reason.
      if (!useMcpConfigStore.getState().getMcpByName(name)) {
        await useMcpConfigStore.getState().loadMcpConfigs();
      }

      const configStore = useMcpConfigStore.getState();
      const existing = configStore.getMcpByName(name);
      // `oauth: false` means the user disabled it explicitly.
      const currentOAuth = existing && 'oauth' in existing && existing.oauth
        ? existing.oauth
        : null;

      // Rewritten when it does not match the callback we would receive right
      // now — not merely when it is missing.
      //
      // The desktop app's loopback port changes between launches, so a stored
      // redirect from an earlier session points at a port nothing serves any
      // more: the provider redirects into the void and authorization never
      // completes. Comparing instead of checking for absence also means the
      // config is left alone — and OpenCode is not reloaded — whenever the
      // stored value is already right, which is every run after the first.
      const desiredRedirectUri = buildMcpAuthorizationRedirectUri(name);
      if (existing && currentOAuth?.redirectUri !== desiredRedirectUri) {
        const saved = await configStore.updateMcp(name, {
          oauthEnabled: true,
          oauthClientId: currentOAuth?.clientId ?? '',
          oauthClientSecret: currentOAuth?.clientSecret ?? '',
          oauthScope: currentOAuth?.scope ?? '',
          oauthRedirectUri: desiredRedirectUri,
        });
        if (!saved.ok) {
          throw new McpAuthorizationError(
            saved.message || 'Failed to save the authorization callback URL',
          );
        }
      }
    }

    const authorizationUrl = await useMcpStore.getState().startAuth(name, directory ?? null);

    const state = parseMcpOAuthCallbackStateKey(new URL(authorizationUrl).searchParams);
    if (state) {
      queuedState = state;
      await queuePendingContext({
        state,
        name,
        directory,
        origin: isDesktopShell() ? MCP_OAUTH_ORIGIN_DESKTOP : null,
      });
    }

    const opened = await openExternalUrl(authorizationUrl);

    // The desktop app raises itself once the server reports success, rather
    // than waiting for the browser to hand control back. A browser will not
    // follow a custom-protocol link without a user gesture, and the completion
    // page has none — so the return trip cannot start from there.
    if (opened && isDesktopShell()) {
      void waitForAuthorizationThenFocus(name, directory ?? null);
    }

    return { authorizationUrl, opened };
  } catch (error) {
    // A parked context whose flow never started would later resolve a stale
    // server for an unrelated callback.
    await clearPendingContext(queuedState);
    throw error;
  }
};
