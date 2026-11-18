import type { linearLibraries } from './index.js';

type LinearLibraries = typeof linearLibraries;
type LinearAuthorization = Awaited<ReturnType<LinearLibraries['consumeAuthorizationCallback']>>;
type LinearIdentity = Awaited<ReturnType<LinearLibraries['fetchLinearIdentity']>>;

function hasStatus(value: unknown): value is { status: unknown } {
  return value != null && 'status' in Object(value);
}

export async function storeLinearAuthorization(libraries: LinearLibraries, result: LinearAuthorization) {
  const { setLinearAuth, fetchLinearIdentity } = libraries;
  let user: LinearIdentity['user'] | null = null;
  let organization: LinearIdentity['organization'] | null = null;
  try {
    const identity = await fetchLinearIdentity(result.accessToken);
    user = identity.user;
    organization = identity.organization;
  } catch (error) {
    console.error('Failed to load Linear identity after OAuth:', error);
  }
  return setLinearAuth({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    tokenType: result.tokenType,
    expiresAt: result.expiresAt,
    scope: result.scope,
    user,
    organization,
  });
}

export async function readLinearAuthStatus(libraries: LinearLibraries) {
  const {
    getLinearAuth,
    getLinearAuthWorkspaces,
    getValidLinearAccessToken,
    fetchLinearIdentity,
    setLinearAuth,
    clearLinearAuth,
    toLinearPublicStatus,
    pollAuthorizationBroker,
    completeAuthorizationBroker,
  } = libraries;

  try {
    const result = await pollAuthorizationBroker();
    if (result) {
      await storeLinearAuthorization(libraries, result);
      await completeAuthorizationBroker(result.brokerReceipt).catch((error) => {
        console.warn('Failed to acknowledge Linear authorization broker result:', error);
      });
    }
  } catch (error) {
    console.error('Failed to complete Linear authorization through broker:', error);
  }

  const accessToken = await getValidLinearAccessToken();
  if (!accessToken) {
    return { connected: false };
  }

  const auth = getLinearAuth();
  try {
    const identity = await fetchLinearIdentity(accessToken);
    const next = setLinearAuth({
      accessToken,
      refreshToken: auth?.refreshToken,
      tokenType: auth?.tokenType,
      expiresAt: auth?.expiresAt,
      scope: auth?.scope,
      user: identity.user,
      organization: identity.organization,
      workspaceId: auth?.workspaceId,
    }, { activate: false });
    return toLinearPublicStatus(next, getLinearAuthWorkspaces());
  } catch (error) {
    if (hasStatus(error) && error.status === 401) {
      clearLinearAuth(auth?.workspaceId);
      const remaining = getLinearAuth();
      if (!remaining) {
        return { connected: false };
      }
      return toLinearPublicStatus(remaining, getLinearAuthWorkspaces());
    }
    if (auth) {
      return toLinearPublicStatus(auth, getLinearAuthWorkspaces());
    }
    throw error;
  }
}

export async function disconnectCurrentLinearWorkspace(libraries: LinearLibraries) {
  const { getLinearAuth, clearLinearAuth, revokeToken } = libraries;
  const auth = getLinearAuth();
  if (auth?.refreshToken) {
    await revokeToken(auth.refreshToken, 'refresh_token');
  } else if (auth?.accessToken) {
    await revokeToken(auth.accessToken, 'access_token');
  }
  return clearLinearAuth(auth?.workspaceId);
}
