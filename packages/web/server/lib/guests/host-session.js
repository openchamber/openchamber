import { resolveIntegrationAuth } from '@openchamber/sdk';

import { GuestOAuthError, toPublicGuestAuth } from './oauth.js';

const hostAccessOf = async (integration, trackers) => {
  if (resolveIntegrationAuth(integration ?? {}) !== 'host') return null;
  const provider = integration?.host?.provider;
  const descriptor = trackers?.descriptor(provider) ?? null;
  if (!descriptor?.capabilities.hostAccess) return null;
  const tracker = await trackers.implementation(provider);
  return tracker?.hostAccess ? { name: descriptor.name, access: tracker.hostAccess } : null;
};

export const toGuestAuthResponse = async (integration, stored, trackers) => {
  const published = toPublicGuestAuth(stored, integration);
  const host = await hostAccessOf(integration, trackers);
  if (!host) {
    return published;
  }
  const { connected, label } = await host.access.account();
  return { ...published, connected, account: label, hasClient: true };
};

export const startHostGuestAuthorization = async (integration, trackers) => {
  let host = null;
  try {
    host = await hostAccessOf(integration, trackers);
    return host ? await host.access.start() : null;
  } catch (error) {
    if (error instanceof GuestOAuthError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : `Could not start ${host?.name ?? 'the host sign-in'}.`;
    throw new GuestOAuthError(message, 'HOST_AUTH_FAILED');
  }
};

export const disconnectHostGuest = async (integration, trackers) => {
  const host = await hostAccessOf(integration, trackers);
  if (!host) {
    return false;
  }
  await host.access.disconnect();
  return true;
};

export const resolveHostAccessToken = async (integration, trackers) => {
  const host = await hostAccessOf(integration, trackers).catch(() => null);
  return host ? host.access.accessToken() : null;
};
