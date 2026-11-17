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

export const pickCredentials = (auth, providerIds) => Object.fromEntries(
  providerIds.filter((providerId) => Object.hasOwn(auth, providerId) && auth[providerId]).map((providerId) => [providerId, auth[providerId]]),
);

const toWindow = (wire) => {
  const window = toUsageWindow({
    usedPercent: wire.usedPercent,
    windowSeconds: wire.windowSeconds ?? null,
    resetAt: wire.resetAt ?? null,
    valueLabel: wire.valueLabel ?? null,
    creditsUsed: wire.creditsUsed,
  });
  if (wire.value) window.value = wire.value;
  return window;
};
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

  const failure = (configured, error) => buildResult({ providerId, providerName, ok: false, configured, error });

  const eligibleGuest = async () => {
    const current = await currentGuest(guest.id);
    if (current && isQuotaGuest(current)) return current;
    void Promise.resolve().then(reconcile).catch((error) => {
      warn('[quota] Failed to withdraw an extension usage provider:', error?.message ?? error);
    });
    return null;
  };

  const fetchQuota = async () => {
    const auth = await readCredentials();

    let current;
    try {
      current = await eligibleGuest();
    } catch (error) {
      return failure(true, `${providerName} could not answer: the extension catalog could not be read: ${error?.message ?? error}`);
    }
    if (!current) return failure(true, `${providerName} could not answer: the extension may no longer report usage`);

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
    const normalizedUsage = usage && { windows: toWindows(usage.windows) };
    if (usage?.models) {
      normalizedUsage.models = Object.fromEntries(Object.entries(usage.models).map(([model, { windows }]) => [model, { windows: toWindows(windows) }]));
    }
    return buildResult({
      providerId,
      providerName,
      ok,
      configured,
      error,
      planLabel,
      usage: normalizedUsage,
    });
  };

  return Object.freeze({
    providerId,
    providerName,
    icon: guest.icon,
    guestId: guest.id,
    isConfigured: (auth) => providerIds.length === 0 || Object.keys(pickCredentials(auth, providerIds)).length > 0,
    fetchQuota,
  });
}
