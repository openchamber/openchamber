/**
 * Auth steps shared by the legacy `/api/linear/*` routes and the tracker
 * adapter (`tracker.js`), so both answer from one code path. Each takes the
 * lazily loaded `linearLibraries` of `./index.js` instead of importing it, so
 * callers keep Linear's libraries out of server startup.
 */

/** Persists a finished OAuth exchange, with the identity when Linear answers it. */
export async function storeLinearAuthorization(libraries, result) {
  const { setLinearAuth, fetchLinearIdentity } = libraries;
  let user = null;
  let organization = null;
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

/**
 * The public auth status (`toLinearPublicStatus` shape). Claims a finished
 * broker result first, then refreshes the current workspace's identity. A 401
 * drops that workspace only; a network failure keeps the last known identity.
 */
export async function readLinearAuthStatus(libraries) {
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
    if (error?.status === 401) {
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

/** Revokes the current workspace's grant, then drops that workspace only. */
export async function disconnectCurrentLinearWorkspace(libraries) {
  const { getLinearAuth, clearLinearAuth, revokeToken } = libraries;
  const auth = getLinearAuth();
  if (auth?.refreshToken) {
    await revokeToken(auth.refreshToken, 'refresh_token');
  } else if (auth?.accessToken) {
    await revokeToken(auth.accessToken, 'access_token');
  }
  return clearLinearAuth(auth?.workspaceId);
}
