import { resolveIntegrationAuth } from '@openchamber/sdk';

import { readTrimmedString } from '../linear/parse.js';
import { GuestOAuthError, toPublicGuestAuth } from './oauth.js';

const isHostLinear = (integration) => (
  resolveIntegrationAuth(integration ?? {}) === 'host'
  && integration?.host?.provider === 'linear'
);

const linearAccountLabel = (auth) => (
  readTrimmedString(auth?.user?.displayName)
  || readTrimmedString(auth?.user?.name)
  || readTrimmedString(auth?.organization?.name)
);

export const toGuestAuthResponse = async (integration, stored) => {
  const published = toPublicGuestAuth(stored);
  if (!isHostLinear(integration)) {
    return published;
  }
  const { getLinearAuth } = await import('../linear/index.js');
  const auth = getLinearAuth();
  return {
    ...published,
    connected: Boolean(auth?.accessToken),
    account: linearAccountLabel(auth),
    hasClient: true,
  };
};

export const startHostGuestAuthorization = async (integration) => {
  if (!isHostLinear(integration)) {
    return null;
  }
  try {
    const { startAuthorization } = await import('../linear/index.js');
    return await startAuthorization({ origin: 'web' });
  } catch (error) {
    if (error instanceof GuestOAuthError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Could not start Linear.';
    throw new GuestOAuthError(message, 'HOST_AUTH_FAILED');
  }
};

export const disconnectHostGuest = async (integration) => {
  if (!isHostLinear(integration)) {
    return false;
  }
  const { getLinearAuth, clearLinearAuth, revokeToken } = await import('../linear/index.js');
  const auth = getLinearAuth();
  if (auth?.refreshToken) {
    await revokeToken(auth.refreshToken, 'refresh_token').catch(() => undefined);
  } else if (auth?.accessToken) {
    await revokeToken(auth.accessToken, 'access_token').catch(() => undefined);
  }
  clearLinearAuth(auth?.workspaceId);
  return true;
};

export const resolveHostAccessToken = async (integration) => {
  if (!isHostLinear(integration)) {
    return null;
  }
  try {
    const { getValidLinearAccessToken } = await import('../linear/index.js');
    return await getValidLinearAccessToken();
  } catch {
    return null;
  }
};
