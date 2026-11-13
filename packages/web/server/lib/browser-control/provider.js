/**
 * Chooses who answers the agent's `browser.*` actions: the in-app browser view
 * (through the broker) or an extension service that provides the browser
 * (`contributes.service.provides: ["browser"]`).
 *
 * The choice is the `browserProvider` setting: `builtin`, or the id of an
 * installed extension. Unset resolves to the built-in Server Browser
 * extension (`openchamber-builtin-server-browser`), so a fresh instance can
 * browse with no client open; `builtin` keeps meaning the in-app webview.
 * It is read for every action, so a change in Settings applies to the next
 * action without a restart. A selected extension that can no longer serve —
 * paused, removed, approval withdrawn, or a newer version without the role —
 * is not silently kept: the setting goes back to `builtin`, every client is
 * told so it can say so, and the action runs in-app. Doing that at the
 * moment the extension is deactivated (`handleGuestDeactivated`) gives the
 * user the notice right away; doing it again on the next action covers
 * everything else, such as a folder install that went missing.
 *
 * The service is a host-spawned loopback process, so the proxy that panels
 * use serves here too. It starts the process on the first action, which is
 * what lets an agent browse with no panel open, and stops it after
 * `BROWSER_PROVIDER_IDLE_MS` without actions.
 */

import {
  BROWSER_PROVIDER_ACTION_TIMEOUT_MS,
  BROWSER_PROVIDER_IDLE_MS,
  BROWSER_PROVIDER_OPEN_TIMEOUT_MS,
  BROWSER_PROVIDER_PATH,
  BROWSER_PROVIDER_RESPONSE_MAX,
  isGuestApproved,
  requestedGuestCapabilities,
  serviceProvides,
} from '@openchamber/sdk';
import { browserProviderResultSchema } from '@openchamber/sdk/schemas';

import { GuestServiceError, proxyGuestServiceRequest } from '../guests/service.js';
import { BrowserControlError } from './broker.js';

const BUILTIN_BROWSER_PROVIDER = 'builtin';
/**
 * Unset `browserProvider` resolves to the built-in Server Browser extension,
 * not the in-app webview/iframe: a fresh instance can browse from no client
 * at all. `builtin` keeps its own meaning and is still what a broken or
 * disabled provider resets to.
 */
const DEFAULT_BROWSER_PROVIDER = 'openchamber-builtin-server-browser';

/**
 * `browser.requestHelp` hands a person a picture of the page, so it needs a
 * provider with a shared surface to draw it in; the in-app browser view has
 * no such surface, and neither does a selected extension without one.
 */
const BROWSER_REQUEST_HELP_NO_SURFACE_ERROR = 'Asking for help needs a browser provider extension with a shared surface (Settings → OpenChamber Tools → Browser provider).';

/** The in-app browser has one shared, un-copied session; there is no saved profile to write. */
const BROWSER_SAVE_PROFILE_NO_PROVIDER_ERROR = 'Saving a browser profile needs the Server Browser extension (Settings → OpenChamber Tools → Browser provider).';
// The in-app view answers a page's dialogs itself, so it never has one waiting.
const BROWSER_DIALOG_NO_PROVIDER_ERROR = 'No dialog is waiting in the in-app browser: its pages answer their own dialogs. browser.dialog is for the Server Browser extension (Settings → OpenChamber Tools → Browser provider).';

/**
 * Whether this catalog row can answer browser actions right now. Mirrors what
 * the Settings dropdown offers: enabled, fully approved, and declaring the
 * role. The `service` grant is implied by full approval.
 */
/** The control service builds the caller's scope; a caller without one (tests, CLI) means unknown. */
const UNKNOWN_CONTEXT = Object.freeze({ directory: null, sessionId: null });

export const isBrowserProviderGuest = (guest) => (
  Boolean(guest)
  && guest.enabled !== false
  && serviceProvides(guest.service, 'browser')
  && isGuestApproved({
    requested: requestedGuestCapabilities(guest),
    granted: Array.isArray(guest.capabilityGrants) ? guest.capabilityGrants : [],
  })
);

/**
 * @param {{
 *   broker: { request: Function },
 *   readSettings: () => Promise<Record<string, unknown> | null>,
 *   persistSettings: (changes: Record<string, unknown>) => Promise<unknown>,
 *   findGuest: (id: string) => Promise<object | null>,
 *   persistPath: string,
 *   emitProviderReset: (event: { guestId: string, guestName: string }) => void,
 *   createId: () => string,
 *   proxyServiceRequest?: typeof proxyGuestServiceRequest,
 *   surfaceControl?: { userControls: (guestId: string) => boolean, noteAgentActivity: (guestId: string) => void },
 *   notifyBrowserHelp?: (event: { guestId: string, guestName: string, reason: string, kind: 'login' | 'page' | 'profile' | undefined, context: { directory: string | null, sessionId: string | null } }) => Promise<unknown>,
 *   announceAgentActivity?: (event: { guestId: string, action: string, context: { directory: string | null, sessionId: string | null } }) => void,
 * }} deps `surfaceControl` is the shared-surface lease: an action is refused
 * while the user is driving the extension's surface, and every action the
 * provider runs counts as agent activity there. `notifyBrowserHelp` tells the
 * person a `browser.requestHelp` needs them; its failure is logged, never
 * raised, because a lost notification must not also lose the action.
 * `announceAgentActivity` tells the clients a chat's agent is about to use
 * its browser, so one following the agent can open the Browser panel.
 */
export const createBrowserControlRouter = ({
  broker,
  readSettings,
  persistSettings,
  findGuest,
  persistPath,
  emitProviderReset,
  createId,
  proxyServiceRequest = proxyGuestServiceRequest,
  surfaceControl = { userControls: () => false, noteAgentActivity: () => undefined },
  notifyBrowserHelp = async () => undefined,
  announceAgentActivity = () => undefined,
}) => {
  // `browserProvider` was sanitized on write (settings-helpers.js keeps a
  // trimmed non-empty string), so the only decision left is builtin or not.
  // A read that fails is not "builtin": the action must not run somewhere
  // the user did not choose.
  const selectedProviderId = async () => {
    let settings;
    try {
      settings = await readSettings();
    } catch {
      throw new BrowserControlError(
        'OpenChamber could not read which browser answers agent actions, so the action was not run. Try again.',
        503,
      );
    }
    const value = settings?.browserProvider ?? DEFAULT_BROWSER_PROVIDER;
    return value === BUILTIN_BROWSER_PROVIDER ? null : String(value);
  };

  const resetToBuiltin = async ({ guestId, guestName }) => {
    await persistSettings({ browserProvider: BUILTIN_BROWSER_PROVIDER });
    emitProviderReset({ guestId, guestName });
  };

  const requestFromProvider = async (guest, action, parameters, { signal, timeoutMs, context }) => {
    if (surfaceControl.userControls(guest.id)) {
      // Read by the agent: the page is being used by a person right now.
      throw new BrowserControlError(
        'The user is interacting with this page in the panel right now, so the action was not run. '
        + 'Wait for them to hand control back, or ask them to. Nothing was changed.',
        409,
      );
    }
    if (action === 'browser.requestHelp') {
      // Best-effort: the person seeing the notification matters, but a
      // notification failure must not also fail the help request itself.
      try {
        await notifyBrowserHelp({
          guestId: guest.id,
          guestName: guest.name,
          reason: parameters?.reason,
          kind: parameters?.kind,
          context: context ?? UNKNOWN_CONTEXT,
        });
      } catch (error) {
        console.warn('[browser-provider] could not notify the user about a help request:', error instanceof Error ? error.message : error);
      }
    }
    surfaceControl.noteAgentActivity(guest.id);
    // Closing a tab is no reason to bring the browser in front.
    if (action !== 'browser.close') {
      announceAgentActivity({ guestId: guest.id, action, context: context ?? UNKNOWN_CONTEXT });
    }
    const requestId = createId();
    let proxied;
    try {
      proxied = await proxyServiceRequest({
        guestId: guest.id,
        guestName: guest.name,
        packageRoot: guest.packageRoot,
        service: guest.service,
        granted: guest.capabilityGrants,
        persistPath,
        method: 'POST',
        path: BROWSER_PROVIDER_PATH,
        body: JSON.stringify({ requestId, action, parameters, context: context ?? UNKNOWN_CONTEXT }),
        timeoutMs: timeoutMs ?? (action === 'browser.open' ? BROWSER_PROVIDER_OPEN_TIMEOUT_MS : BROWSER_PROVIDER_ACTION_TIMEOUT_MS),
        responseMax: BROWSER_PROVIDER_RESPONSE_MAX,
        idleStopMs: BROWSER_PROVIDER_IDLE_MS,
        signal,
      });
    } catch (error) {
      if (error instanceof GuestServiceError) {
        // Read by the agent. A request that was sent and lost may have been
        // acted on; only a service that never took it leaves the page as it was.
        const outcome = error.code === 'RESPONSE_TOO_LARGE'
          ? 'The action ran, but its answer was too large to read; read the page before repeating it.'
          : error.code === 'REQUEST_FAILED' || error.code === 'CANCELLED'
            ? 'The action was sent but no answer came back, so it may or may not have run; read the page before repeating it.'
            : 'Nothing was changed.';
        throw new BrowserControlError(
          `The browser provider "${guest.name}" could not complete this action (${error.code}): ${error.message} ${outcome}`,
          error.code === 'REQUEST_FAILED' ? 504 : error.code === 'RESPONSE_TOO_LARGE' ? 502 : 503,
        );
      }
      throw error;
    }
    if (proxied.status !== 200) {
      throw new BrowserControlError(
        `The browser provider "${guest.name}" answered HTTP ${proxied.status} instead of a result. Nothing is known about the page.`,
        502,
      );
    }
    let parsed;
    try {
      parsed = browserProviderResultSchema.safeParse(JSON.parse(proxied.body));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success) {
      throw new BrowserControlError(
        `The browser provider "${guest.name}" answered something that is not a browser result. Nothing is known about the page.`,
        502,
      );
    }
    if (!parsed.data.ok) {
      throw new BrowserControlError(parsed.data.error, 400);
    }
    return parsed.data.data;
  };

  return {
    /** Same signature as the broker; the control service does not know which path ran. */
    async request(action, parameters = {}, options = {}) {
      const providerId = await selectedProviderId();
      if (!providerId) {
        if (action === 'browser.requestHelp') {
          throw new BrowserControlError(BROWSER_REQUEST_HELP_NO_SURFACE_ERROR, 400);
        }
        if (action === 'browser.saveProfile') {
          throw new BrowserControlError(BROWSER_SAVE_PROFILE_NO_PROVIDER_ERROR, 400);
        }
        if (action === 'browser.dialog') {
          throw new BrowserControlError(BROWSER_DIALOG_NO_PROVIDER_ERROR, 400);
        }
        return broker.request(action, parameters, options);
      }
      let guest;
      try {
        guest = await findGuest(providerId);
      } catch {
        // The catalog could not be read; that says nothing about the
        // extension, so neither the choice nor the target browser changes.
        throw new BrowserControlError(
          'OpenChamber could not read the extension catalog, so the action was not run. Try again.',
          503,
        );
      }
      if (!isBrowserProviderGuest(guest)) {
        await resetToBuiltin({ guestId: providerId, guestName: guest?.name ?? providerId });
        if (action === 'browser.requestHelp') {
          throw new BrowserControlError(BROWSER_REQUEST_HELP_NO_SURFACE_ERROR, 400);
        }
        if (action === 'browser.saveProfile') {
          throw new BrowserControlError(BROWSER_SAVE_PROFILE_NO_PROVIDER_ERROR, 400);
        }
        if (action === 'browser.dialog') {
          throw new BrowserControlError(BROWSER_DIALOG_NO_PROVIDER_ERROR, 400);
        }
        return broker.request(action, parameters, options);
      }
      if (action === 'browser.requestHelp' && guest.service?.surface !== true) {
        throw new BrowserControlError(BROWSER_REQUEST_HELP_NO_SURFACE_ERROR, 400);
      }
      return requestFromProvider(guest, action, parameters, options);
    },

    /**
     * Called when an extension is paused, removed, or loses approval. The
     * catalog may not reflect the change yet, so this does not re-check it:
     * the selection alone decides.
     */
    async handleGuestDeactivated({ guestId, guestName }) {
      // The pause or removal already happened; a failure here must not turn
      // it into an error response. The next action re-checks the catalog
      // and resets the setting then.
      try {
        const providerId = await selectedProviderId();
        if (providerId !== guestId) return false;
        await resetToBuiltin({ guestId, guestName: guestName || guestId });
        return true;
      } catch (error) {
        console.warn('[browser-provider] could not reset the provider after a deactivation:', error instanceof Error ? error.message : error);
        return false;
      }
    },
  };
};
