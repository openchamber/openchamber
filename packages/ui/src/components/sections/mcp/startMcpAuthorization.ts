import { runtimeFetch } from '@/lib/runtime-fetch';
import { applyPendingOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';
import { focusDesktopWindow, isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
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
  /**
   * True when OpenCode runs the whole flow itself over its fixed loopback
   * listener: it opened the browser, waits for the callback, and exchanges the
   * code. There is no URL to display and no state to correlate — callers watch
   * runtime status until it turns `connected`.
   */
  nativeFlow?: boolean;
  /**
   * Native flow only: resolves when OpenCode finishes the whole exchange (or
   * rejects when it fails) — the precise "authorization is over" signal, since
   * runtime status alone cannot distinguish a completed reauthorization from
   * the still-connected state it started in.
   */
  completion?: Promise<void>;
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

/**
 * One-time migration for the native desktop flow: earlier versions wrote this
 * app's per-launch callback URL into the server's config, and OpenCode derives
 * its listener from that field — pointed at OUR port, it either fails to bind
 * or the callback lands on a flow that never registered it. Clearing the field
 * returns OpenCode to its fixed default port. Applied immediately when the
 * write gets queued behind Apply & Restart, for the same reason as the
 * callback-URL write below: authorization runs against the live runtime.
 */
const clearCustomRedirectUriForNativeFlow = async (name: string): Promise<void> => {
  if (!useMcpConfigStore.getState().getMcpByName(name)) {
    await useMcpConfigStore.getState().loadMcpConfigs();
  }
  const configStore = useMcpConfigStore.getState();
  const existing = configStore.getMcpByName(name);
  const currentOAuth = existing && 'oauth' in existing && existing.oauth ? existing.oauth : null;
  if (!existing || !currentOAuth?.redirectUri) return;

  const saved = await configStore.updateMcp(name, {
    oauthEnabled: true,
    oauthClientId: currentOAuth.clientId ?? '',
    oauthClientSecret: currentOAuth.clientSecret ?? '',
    oauthScope: currentOAuth.scope ?? '',
    oauthRedirectUri: '',
  });
  if (!saved.ok) {
    throw new McpAuthorizationError(saved.message || 'Failed to reset the authorization callback URL');
  }
  if (saved.restartDeferred) {
    const applied = await applyPendingOpenCodeRestart();
    if (!applied.ok) {
      throw new McpAuthorizationError(
        applied.requiresManualRestart
          ? 'The callback settings changed, but OpenCode must be restarted manually before authorization can start.'
          : 'Failed to apply the callback settings. Use Apply & Restart, then authorize again.',
      );
    }
  }
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
}): Promise<McpAuthorizationStart> => {
  const { name, directory } = input;
  let queuedState: string | null = null;

  // Runtimes where the system browser provably lives on the same machine as
  // OpenCode — desktop with the LOCAL embedded server, and VS Code (the
  // extension always spawns its own local OpenCode): OpenCode's own flow works
  // end-to-end over its FIXED loopback port (19876) — no config writes, no
  // OpenCode restarts, no dependence on this app's per-launch port. The custom
  // callback URL below stays for every case where the browser cannot reach
  // OpenCode's loopback: remote instances, hosted web, mobile — and the plain
  // web runtime too, because same-origin says nothing about the browser being
  // on the server's machine.
  if (isVSCodeRuntime() || (isDesktopShell() && getRuntimeKey() === 'local')) {
    await clearCustomRedirectUriForNativeFlow(name);
    const completion = useMcpStore.getState().authenticate(name, directory ?? null);
    completion
      .then(() => focusDesktopWindow())
      .catch(() => {
        // Recorded as a runtime diagnostic by the store; the status card and
        // the caller's completion handling surface it.
      });
    return { authorizationUrl: '', opened: true, nativeFlow: true, completion };
  }

  try {
    {
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
        // Config mutations accumulate behind Apply & Restart now, but the
        // authorization flow runs against the LIVE OpenCode runtime: with the
        // write still queued, OpenCode hands out its own loopback redirect and
        // the callback never reaches us. The user just clicked Authorize —
        // explicit intent — so apply the queued changes right away and start
        // the flow against the runtime that actually has our callback URL.
        if (saved.restartDeferred) {
          const applied = await applyPendingOpenCodeRestart();
          if (applied.requiresManualRestart) {
            throw new McpAuthorizationError(
              'The callback URL was saved, but OpenCode must be restarted manually before authorization can start.',
            );
          }
          if (!applied.ok) {
            throw new McpAuthorizationError(
              'Failed to apply the saved callback URL. Use Apply & Restart, then authorize again.',
            );
          }
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
