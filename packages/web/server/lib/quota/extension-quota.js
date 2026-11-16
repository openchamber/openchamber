import crypto from 'node:crypto';

import {
  QUOTA_PROVIDER_IDLE_MS,
  QUOTA_PROVIDER_PATH,
  QUOTA_PROVIDER_RESPONSE_MAX,
  QUOTA_PROVIDER_TIMEOUT_MS,
  QUOTA_PROVIDER_WIRE_VERSION,
  isGuestApproved,
  requestedGuestCapabilities,
  serviceProvides,
} from '@openchamber/sdk';
import { quotaProviderSchemasV1 as schemas } from '@openchamber/sdk/schemas';

import { proxyGuestServiceRequest } from '../guests/service.js';
import { readOpenCodeCredentials } from '../opencode/auth.js';
import { extensionProviderId } from '../source-control/provider-id.js';
import { QuotaRouteError } from './route-error.js';
import { buildResult, toUsageWindow } from './utils/formatters.js';

/**
 * An installed extension's usage provider (`ext-<guestId>`) as a registry
 * entry beside the built-ins (`providers/index.js`): the same `isConfigured`
 * and `fetchQuota` a built-in module exports, answered by the extension's
 * service (`POST /quota` on its loopback, the SDK's wire 1).
 *
 * The service receives, on every read, the entries OpenCode holds for the
 * provider ids the current catalog row lists, as `readOpenCodeCredentials` answers them,
 * and nothing else of the map: the hand-over the user approved in the dialog.
 * A listed credential OpenCode does not hold is the "not configured" state a
 * built-in answers for its own missing key, and the service is not called.
 *
 * Every call reads the guest's current catalog row (`currentGuest`), which
 * applies enterprise policy on each read: a guest that is no longer eligible
 * (paused, unapproved, refused by policy) is refused before anything is sent,
 * and the registered set is reconciled. Answers are checked with the SDK's
 * `quotaProviderSchemasV1`; one that does not parse is `502
 * MALFORMED_PROVIDER_RESPONSE`, never an empty result. The host adds the
 * provider id, the name and the time of the read, and derives each window's
 * remaining share and formatted strings (`toUsageWindow`), so the result
 * matches a built-in's field for field.
 */

/** Whether a catalog row may serve usage; the adapter asks again on every call. */
export const isQuotaGuest = (guest) => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return Boolean(guest)
    && guest.enabled !== false
    && serviceProvides(guest.service, 'quota')
    && Boolean(guest.quota)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted })
    && extensionProviderId(guest.id) !== null;
};

/** The listed entries OpenCode holds now, keyed by provider id; a listed id OpenCode has no credential for is absent. */
export const pickCredentials = (auth, providerIds) => Object.fromEntries(
  providerIds.filter((providerId) => Object.hasOwn(auth, providerId) && auth[providerId]).map((providerId) => [providerId, auth[providerId]]),
);

/** A wire window as the UI draws it: the derived shares and formatted strings of `toUsageWindow`, the structured `value` kept. */
const toWindow = (wire) => ({
  ...toUsageWindow({
    usedPercent: wire.usedPercent,
    windowSeconds: wire.windowSeconds ?? null,
    resetAt: wire.resetAt ?? null,
    valueLabel: wire.valueLabel ?? null,
    creditsUsed: wire.creditsUsed,
  }),
  ...(wire.value ? { value: wire.value } : {}),
});
const toWindows = (windows) => Object.fromEntries(Object.entries(windows).map(([name, window]) => [name, toWindow(window)]));

/**
 * @param {{
 *   guest: { id: string, name: string, icon: string, packageRoot: string, service: object, capabilityGrants: string[] },
 *   contribution: { providers: string[] },
 *   currentGuest: (guestId: string) => Promise<object | null>,
 *   reconcile: () => unknown,
 *   persistPath: string,
 *   proxy?: typeof proxyGuestServiceRequest,
 *   readCredentials?: typeof readOpenCodeCredentials,
 *   createId?: () => string,
 *   warn?: (...args: unknown[]) => void,
 * }} deps `persistPath` is the extension store the guest service proxy reads
 * its enabled flag from. `reconcile` brings the registered set in step with
 * the catalog when a call finds the guest no longer eligible.
 */
export function createExtensionQuotaProvider({
  guest, contribution, currentGuest, reconcile, persistPath,
  proxy = proxyGuestServiceRequest, readCredentials = readOpenCodeCredentials,
  createId = () => crypto.randomUUID(), warn = (...args) => console.warn(...args),
}) {
  const providerId = extensionProviderId(guest.id);
  const providerName = guest.name;
  const providerIds = contribution.providers;

  /** A built-in's failed result: the card shows `error` and keeps its last sample while `configured`. */
  const failure = (configured, error) => buildResult({ providerId, providerName, ok: false, configured, error });

  /** The guest as the catalog has it now, or null once it may no longer serve; the set is then reconciled. */
  const eligibleGuest = async () => {
    const current = await currentGuest(guest.id);
    if (current && isQuotaGuest(current)) return current;
    void Promise.resolve().then(reconcile).catch((error) => {
      warn('[quota] Failed to withdraw an extension usage provider:', error?.message ?? error);
    });
    return null;
  };

  const fetchQuota = async () => {
    // Thrown when OpenCode cannot be asked; the registry reports that as it does a built-in's throw.
    const auth = await readCredentials();

    // After the read, so nothing withdrawn while it ran is handed over.
    let current;
    try {
      current = await eligibleGuest();
    } catch (error) {
      return failure(true, `${providerName} could not answer: the extension catalog could not be read: ${error?.message ?? error}`);
    }
    if (!current) return failure(true, `${providerName} could not answer: the extension may no longer report usage`);

    // The list the catalog holds now: a re-approval can narrow it before this adapter is replaced.
    const listed = current.quota.providers;
    const credentials = pickCredentials(auth, listed);
    if (listed.length > 0 && Object.keys(credentials).length === 0) return failure(false, 'Not configured');

    let proxied;
    try {
      proxied = await proxy({
        guestId: guest.id,
        guestName: guest.name,
        packageRoot: guest.packageRoot,
        service: guest.service,
        granted: current.capabilityGrants,
        persistPath,
        method: 'POST',
        path: QUOTA_PROVIDER_PATH,
        body: JSON.stringify({
          v: QUOTA_PROVIDER_WIRE_VERSION,
          requestId: createId(),
          method: 'usage.read',
          provider: providerId,
          input: { credentials },
        }),
        timeoutMs: QUOTA_PROVIDER_TIMEOUT_MS,
        responseMax: QUOTA_PROVIDER_RESPONSE_MAX,
        idleStopMs: QUOTA_PROVIDER_IDLE_MS,
      });
    } catch (error) {
      // The service was not reached or did not answer in time: unavailable, as a built-in's API outage reads.
      return failure(true, `${providerName} could not answer (${error?.code ?? 'error'}): ${error?.message ?? error}`);
    }

    const malformed = (detail) => new QuotaRouteError(502, 'MALFORMED_PROVIDER_RESPONSE', `${providerName} answered something OpenChamber cannot use: ${detail}`);
    if (proxied.status !== 200) throw malformed(`HTTP ${proxied.status}`);
    let envelope;
    try {
      envelope = schemas.envelope.safeParse(JSON.parse(proxied.body));
    } catch {
      throw malformed('not JSON');
    }
    if (!envelope.success) throw malformed('not a usage answer');
    if (!envelope.data.ok) return failure(true, envelope.data.error.message);
    const data = schemas.data['usage.read'].safeParse(envelope.data.data);
    if (!data.success) throw malformed('usage.read does not match its schema');

    const { ok, configured, error, planLabel, usage } = data.data;
    return buildResult({
      providerId,
      providerName,
      ok,
      configured,
      error,
      planLabel,
      usage: usage && {
        windows: toWindows(usage.windows),
        ...(usage.models
          ? { models: Object.fromEntries(Object.entries(usage.models).map(([model, { windows }]) => [model, { windows: toWindows(windows) }])) }
          : {}),
      },
    });
  };

  return Object.freeze({
    providerId,
    providerName,
    /** The extension's icon (a Remixicon name or a package SVG path) and id, for the UI's card. */
    icon: guest.icon,
    guestId: guest.id,
    /** Configured when OpenCode holds at least one listed credential, and always when the list is empty. */
    isConfigured: (auth) => providerIds.length === 0 || Object.keys(pickCredentials(auth, providerIds)).length > 0,
    fetchQuota,
  });
}
