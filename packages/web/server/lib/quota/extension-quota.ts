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
import type { GuestRecord } from '../guests/contracts.js';
import type { LegacyAuthFile } from '../opencode/auth.js';
import type { ProviderUsage } from './utils/contracts.js';

export type QuotaGuest = GuestRecord & Required<Pick<GuestRecord, 'quota' | 'service' | 'capabilityGrants'>>;
type WireUsage = NonNullable<ReturnType<typeof schemas.usage.parse>['usage']>;
type WireWindow = WireUsage['windows'][string];

export interface ExtensionQuotaProviderDependencies {
  guest: Pick<QuotaGuest, 'id' | 'name' | 'icon' | 'packageRoot' | 'service' | 'capabilityGrants'>;
  contribution: QuotaGuest['quota'];
  currentGuest: (guestId: string) => Promise<GuestRecord | null>;
  reconcile: () => void | Promise<void>;
  persistPath: string;
  proxy?: typeof proxyGuestServiceRequest;
  readCredentials?: typeof readOpenCodeCredentials;
  createId?: () => string;
  warn?: (...args: unknown[]) => void;
}

const hasOptionalErrorFields = (value: unknown): value is { message?: unknown; code?: unknown } =>
  value !== null && value !== undefined;

export const isQuotaGuest = (guest: GuestRecord | null | undefined): guest is QuotaGuest => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return Boolean(guest
    && guest.enabled !== false
    && serviceProvides(guest.service, 'quota')
    && Boolean(guest.quota)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted })
    && extensionProviderId(guest.id) !== null);
};

export const pickCredentials = (auth: LegacyAuthFile, providerIds: string[]) => Object.fromEntries(
  providerIds.filter((providerId) => Object.hasOwn(auth, providerId) && auth[providerId]).map((providerId) => [providerId, auth[providerId]]),
);

const toWindow = (wire: WireWindow) => {
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
const toWindows = (windows: WireUsage['windows']) => Object.fromEntries(Object.entries(windows).map(([name, window]) => [name, toWindow(window)]));

export function createExtensionQuotaProvider({
  guest, contribution, currentGuest, reconcile, persistPath,
  proxy = proxyGuestServiceRequest, readCredentials = readOpenCodeCredentials,
  createId = () => crypto.randomUUID(), warn = (...args) => console.warn(...args),
}: ExtensionQuotaProviderDependencies) {
  const providerId = extensionProviderId(guest.id);
  const providerName = guest.name;
  const providerIds = contribution.providers;

  const failure = (configured: boolean, error: string) => buildResult({ providerId, providerName, ok: false, configured, error });

  const eligibleGuest = async () => {
    const current = await currentGuest(guest.id);
    if (current && isQuotaGuest(current)) return current;
    void Promise.resolve().then(reconcile).catch((error) => {
      warn('[quota] Failed to withdraw an extension usage provider:', (hasOptionalErrorFields(error) ? error.message : undefined) ?? error);
    });
    return null;
  };

  const fetchQuota = async () => {
    const auth = await readCredentials();

    let current;
    try {
      current = await eligibleGuest();
    } catch (error) {
      return failure(true, `${providerName} could not answer: the extension catalog could not be read: ${(hasOptionalErrorFields(error) ? error.message : undefined) ?? error}`);
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
      return failure(true, `${providerName} could not answer (${(hasOptionalErrorFields(error) ? error.code : undefined) ?? 'error'}): ${(hasOptionalErrorFields(error) ? error.message : undefined) ?? error}`);
    }

    const malformed = (detail: string) => new QuotaRouteError(502, 'MALFORMED_PROVIDER_RESPONSE', `${providerName} answered something OpenChamber cannot use: ${detail}`);
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
    const normalizedUsage: ProviderUsage | null = usage && { windows: toWindows(usage.windows) };
    if (usage?.models && normalizedUsage) {
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
    isConfigured: (auth: LegacyAuthFile) => providerIds.length === 0 || Object.keys(pickCredentials(auth, providerIds)).length > 0,
    fetchQuota,
  });
}
