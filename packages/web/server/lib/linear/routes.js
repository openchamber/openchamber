import express from 'express';
import { readTrimmedString } from './parse.js';

const PENDING_JSON_LIMIT = '16kb';
const parseJsonBody = express.json({ limit: PENDING_JSON_LIMIT });

function queryValue(req, key) {
  const raw = req.query?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return readTrimmedString(value);
}

function isLinearUserError(error) {
  return error?.code === 'INVALID' || error?.userError === true;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLinearOAuthCallbackPage({ title, message, desktopReturn }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — OpenChamber</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2.5rem 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0; line-height: 1.5; opacity: 0.85; }
  a.return { display: inline-block; margin-top: 1.5rem; padding: 0.5rem 1.25rem; border-radius: 0.5rem;
             border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); color: inherit; text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${desktopReturn ? `<a class="return" href="openchamber://focus/linear-auth">Return to OpenChamber</a>
<script>window.location.href = 'openchamber://focus/linear-auth';</script>` : ''}
</main>
</body>
</html>`;
}

async function storeAuthorizationResult(libraries, result) {
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

export function registerLinearRoutes(app) {
  let linearLibraries = null;
  const getLinearLibraries = async () => {
    if (!linearLibraries) {
      linearLibraries = await import('./index.js');
    }
    return linearLibraries;
  };

  app.get('/linear/oauth/callback', async (req, res) => {
    const finish = (status, { title, message, desktopReturn = false }) => {
      res.status(status).type('html').send(renderLinearOAuthCallbackPage({ title, message, desktopReturn }));
    };

    try {
      const libraries = await getLinearLibraries();
      const { consumeAuthorizationCallback } = libraries;
      const result = await consumeAuthorizationCallback({
        code: queryValue(req, 'code'),
        state: queryValue(req, 'state'),
        error: queryValue(req, 'error'),
        errorDescription: queryValue(req, 'error_description'),
      });

      await storeAuthorizationResult(libraries, result);

      return finish(200, {
        title: 'Authorization Complete',
        message: 'You can close this tab and return to OpenChamber.',
        desktopReturn: result.origin === 'desktop',
      });
    } catch (error) {
      const code = error instanceof Error ? error.code : '';
      const status = code === 'UNKNOWN_STATE' || code === 'MISSING_CODE' || code === 'ACCESS_DENIED'
        ? 400
        : 502;
      return finish(status, {
        title: 'Authorization Failed',
        message: error instanceof Error ? error.message : 'Linear authorization failed. Return to OpenChamber and click Connect again.',
        desktopReturn: error?.origin === 'desktop',
      });
    }
  });

  // The account operations below are shared by the routes and the
  // `openchamber` agent tool (../openchamber-control/integration-service-actions.js).
  // Each answers like its route; a refusal is `{ status, body }`.
  const readStatus = async () => {
    const libraries = await getLinearLibraries();
    const {
      getLinearAuth,
      getLinearAuthWorkspaces,
      getValidLinearAuthorization,
      fetchLinearIdentity,
      setLinearAuth,
      clearLinearAuth,
      activateLinearAuth,
      toLinearPublicStatus,
      pollAuthorizationBroker,
      completeAuthorizationBroker,
    } = libraries;

    try {
      const result = await pollAuthorizationBroker();
      if (result) {
        await storeAuthorizationResult(libraries, result);
        await completeAuthorizationBroker(result.brokerReceipt).catch((error) => {
          console.warn('Failed to acknowledge Linear authorization broker result:', error);
        });
      }
    } catch (error) {
      console.error('Failed to complete Linear authorization through broker:', error);
    }

    const savedBefore = getLinearAuth();
    let authorization = null;
    try {
      authorization = await getValidLinearAuthorization(savedBefore?.workspaceId);
    } catch {
      // A vault credential that cannot be resolved right now is a connect
      // error, not a disconnect: keep the stored reference and report the
      // workspace as it was saved (#304).
      const saved = getLinearAuth();
      if (saved) {
        return toLinearPublicStatus(saved, getLinearAuthWorkspaces());
      }
      throw new Error('Linear is not connected');
    }
    if (!authorization) {
      // Route the disconnected answer through the public-status shape so a
      // malformed auth file reports MALFORMED instead of looking like a
      // never-connected account.
      return toLinearPublicStatus(null);
    }

    const auth = getLinearAuth();
    if (
      !auth
      || auth.workspaceId !== authorization.workspaceId
      || (auth.tokenReference ?? null) !== (savedBefore?.tokenReference ?? null)
    ) {
      // The saved credential was switched, replaced, or disconnected while
      // the authorization was being resolved: discard this refresh rather
      // than writing one workspace's identity (or resolved secret) into
      // another workspace's credential.
      return auth ? toLinearPublicStatus(auth, getLinearAuthWorkspaces()) : toLinearPublicStatus(null);
    }
    try {
      const identity = await fetchLinearIdentity(authorization);
      const current = getLinearAuth();
      if (
        !current
        || current.workspaceId !== auth.workspaceId
        || (current.tokenReference ?? null) !== (auth.tokenReference ?? null)
      ) {
        // The saved credential was switched, replaced, or disconnected
        // while the identity request was in flight: discard this refresh
        // rather than recreating a deleted credential (or writing this
        // workspace's identity into another workspace's credential).
        return current ? toLinearPublicStatus(current, getLinearAuthWorkspaces()) : toLinearPublicStatus(null);
      }
      // A vault workspace keeps only its reference: the resolved key is
      // never written back as an accessToken (#304).
      const next = auth?.tokenReference
        ? setLinearAuth({
          tokenReference: auth.tokenReference,
          user: identity.user,
          organization: identity.organization,
          workspaceId: auth?.workspaceId,
        }, { activate: false })
        : setLinearAuth({
          accessToken: authorization.token,
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
        if (auth?.tokenReference) {
          // A rejected vault key may be a stale cached read of a rotated
          // key: keep the reference so a later read can recover. When
          // another workspace is saved, make it current instead of
          // reporting disconnected: { connected: false } would hide every
          // workspace from Settings, including the controls to switch
          // away from or remove the rejected one.
          const fallback = getLinearAuthWorkspaces().find((workspace) => !workspace.current);
          if (fallback && activateLinearAuth(fallback.id)) {
            const remaining = getLinearAuth();
            if (remaining) {
              return toLinearPublicStatus(remaining, getLinearAuthWorkspaces());
            }
          }
          return { connected: false };
        }
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
  };

  app.get('/api/linear/auth/status', async (_req, res) => {
    try {
      return res.json(await readStatus());
    } catch (error) {
      console.error('Failed to get Linear auth status:', error);
      return res.status(500).json({ error: error.message || 'Failed to get Linear auth status' });
    }
  });

  app.post('/api/linear/auth/start', parseJsonBody, async (req, res) => {
    try {
      const { startAuthorization } = await getLinearLibraries();
      const origin = req.body?.origin === 'desktop' ? 'desktop' : 'web';
      const payload = await startAuthorization({ origin });
      return res.json(payload);
    } catch (error) {
      const status = error?.code === 'LINEAR_CLIENT_ID_MISSING' ? 400 : 500;
      console.error('Failed to start Linear authorization:', error);
      return res.status(status).json({ error: error.message || 'Failed to start Linear authorization' });
    }
  });

  app.post('/api/linear/auth/vault', parseJsonBody, async (req, res) => {
    try {
      const {
        readLinearVaultToken,
        fetchLinearIdentity,
        setLinearAuth,
        getLinearAuthWorkspaces,
        toLinearPublicStatus,
      } = await getLinearLibraries();
      const { isVaultReference } = await import('../environment/vault.js');
      const tokenReference = readTrimmedString(req.body?.tokenReference)
        || readTrimmedString(req.body?.reference);
      if (!tokenReference || !isVaultReference(tokenReference)) {
        return res.status(400).json({
          error: 'tokenReference must be a 1Password reference such as op://Vault/item/field',
          code: 'INVALID_REFERENCE',
        });
      }
      const read = await readLinearVaultToken(tokenReference);
      if (!read?.ok) {
        return res.status(400).json({
          error: `The API key could not be read from 1Password (${read?.reason || 'vault-unavailable'})`,
          code: 'VAULT_READ_FAILED',
          reason: read?.reason || 'vault-unavailable',
        });
      }
      let identity;
      try {
        identity = await fetchLinearIdentity({ token: read.value, source: 'vault' });
      } catch (error) {
        if (error?.status === 401) {
          return res.status(400).json({
            error: 'Linear refused the API key from 1Password',
            code: 'INVALID_TOKEN',
          });
        }
        return res.status(502).json({
          error: 'Linear could not be reached to verify the API key from 1Password',
          code: 'LINEAR_UNREACHABLE',
        });
      }
      // Only a key Linear accepted is saved, and only as its reference.
      const saved = setLinearAuth({
        tokenReference,
        user: identity.user,
        organization: identity.organization,
      });
      return res.json(toLinearPublicStatus(saved, getLinearAuthWorkspaces()));
    } catch (error) {
      console.error('Failed to add a Linear account from 1Password:', error);
      return res.status(500).json({ error: error.message || 'Failed to add the Linear account' });
    }
  });

  app.get('/api/linear/issues/list', async (req, res) => {
    try {
      const { listLinearIssues } = await getLinearLibraries();
      const result = await listLinearIssues({
        query: queryValue(req, 'query'),
        cursor: queryValue(req, 'cursor'),
        status: queryValue(req, 'status'),
        assignee: queryValue(req, 'assignee'),
        teamId: queryValue(req, 'teamId'),
        priority: queryValue(req, 'priority'),
      });
      return res.json(result);
    } catch (error) {
      console.error('Failed to list Linear issues:', error);
      return res.status(500).json({ error: error.message || 'Failed to list Linear issues' });
    }
  });

  app.get('/api/linear/issues/get', async (req, res) => {
    try {
      const id = queryValue(req, 'id');
      if (!id) {
        return res.status(400).json({ error: 'id is required' });
      }
      const { getLinearIssue } = await getLinearLibraries();
      const result = await getLinearIssue(id);
      return res.json(result);
    } catch (error) {
      console.error('Failed to load Linear issue:', error);
      return res.status(500).json({ error: error.message || 'Failed to load Linear issue' });
    }
  });

  app.get('/api/linear/issues/states', async (req, res) => {
    try {
      const teamId = queryValue(req, 'teamId');
      if (!teamId) {
        return res.status(400).json({ error: 'teamId is required' });
      }
      const { listLinearIssueStates } = await getLinearLibraries();
      const result = await listLinearIssueStates(teamId);
      return res.json(result);
    } catch (error) {
      if (isLinearUserError(error)) {
        return res.status(400).json({ error: error.message });
      }
      console.error('Failed to load Linear workflow states:', error);
      return res.status(500).json({ error: error.message || 'Failed to load Linear workflow states' });
    }
  });

  app.post('/api/linear/issues/update', parseJsonBody, async (req, res) => {
    try {
      const { updateLinearIssue } = await getLinearLibraries();
      const result = await updateLinearIssue({
        id: req.body?.id,
        stateId: req.body?.stateId,
      });
      return res.json(result);
    } catch (error) {
      if (isLinearUserError(error)) {
        return res.status(400).json({ error: error.message });
      }
      console.error('Failed to update Linear issue:', error);
      return res.status(500).json({ error: error.message || 'Failed to update Linear issue' });
    }
  });

  const readMapping = async () => {
    const {
      listLinearTeams,
      readStoredLinearMapping,
      mergeLinearMappingView,
      LinearMappingError,
    } = await getLinearLibraries();
    const teamsResult = await listLinearTeams();
    if (teamsResult.connected === false) {
      return { status: 200, body: { connected: false } };
    }
    let stored;
    try {
      stored = readStoredLinearMapping();
    } catch (error) {
      if (error instanceof LinearMappingError && error.code === 'MALFORMED') {
        return { status: 500, body: { error: error.message } };
      }
      throw error;
    }
    return {
      status: 200,
      body: {
        connected: true,
        teamsMore: teamsResult.teamsMore === true,
        ...mergeLinearMappingView(stored, teamsResult.teams),
      },
    };
  };

  app.get('/api/linear/mapping', async (_req, res) => {
    try {
      const { status, body } = await readMapping();
      return res.status(status).json(body);
    } catch (error) {
      console.error('Failed to load Linear mapping:', error);
      return res.status(500).json({ error: error.message || 'Failed to load Linear mapping' });
    }
  });

  const writeMapping = async (mapping) => {
    const {
      getValidLinearAccessToken,
      listLinearTeams,
      setStoredLinearMapping,
      mergeLinearMappingView,
      LinearMappingError,
    } = await getLinearLibraries();
    const accessToken = await getValidLinearAccessToken();
    if (!accessToken) {
      return { status: 200, body: { connected: false } };
    }
    let stored;
    try {
      stored = setStoredLinearMapping(mapping);
    } catch (error) {
      if (error instanceof LinearMappingError && error.code === 'INVALID') {
        return { status: 400, body: { error: error.message } };
      }
      throw error;
    }
    const teamsResult = await listLinearTeams();
    if (teamsResult.connected === false) {
      return {
        status: 200,
        body: {
          connected: true,
          teamsMore: teamsResult.teamsMore === true,
          ...mergeLinearMappingView(stored, []),
        },
      };
    }
    return {
      status: 200,
      body: {
        connected: true,
        teamsMore: teamsResult.teamsMore === true,
        ...mergeLinearMappingView(stored, teamsResult.teams),
      },
    };
  };

  app.put('/api/linear/mapping', parseJsonBody, async (req, res) => {
    try {
      const { status, body } = await writeMapping(req.body);
      return res.status(status).json(body);
    } catch (error) {
      console.error('Failed to save Linear mapping:', error);
      return res.status(500).json({ error: error.message || 'Failed to save Linear mapping' });
    }
  });

  app.post('/api/linear/session-status', parseJsonBody, async (req, res) => {
    try {
      const { postLinearSessionStatus, LinearSessionStatusError } = await getLinearLibraries();
      try {
        const result = await postLinearSessionStatus({
          kind: req.body?.kind,
          sessionId: req.body?.sessionId,
          issueIdentifier: req.body?.issueIdentifier,
          sessionOrigin: req.body?.sessionOrigin,
        });
        return res.json(result);
      } catch (error) {
        if (error instanceof LinearSessionStatusError && error.code === 'INVALID') {
          return res.status(400).json({ error: error.message });
        }
        if (error instanceof LinearSessionStatusError && error.code === 'MALFORMED') {
          return res.status(500).json({ error: error.message });
        }
        throw error;
      }
    } catch (error) {
      console.error('Failed to post Linear session status:', error);
      return res.status(500).json({ error: error.message || 'Failed to post Linear session status' });
    }
  });

  const readPreferences = async () => {
    const { getLinearSessionCommentsEnabled } = await getLinearLibraries();
    return { sessionComments: getLinearSessionCommentsEnabled() };
  };

  app.get('/api/linear/preferences', async (_req, res) => {
    try {
      return res.json(await readPreferences());
    } catch (error) {
      console.error('Failed to load Linear preferences:', error);
      return res.status(500).json({ error: error.message || 'Failed to load Linear preferences' });
    }
  });

  const writePreferences = async (sessionComments) => {
    if (sessionComments !== true && sessionComments !== false) {
      return { status: 400, body: { error: 'sessionComments must be a boolean' } };
    }
    const { setLinearSessionCommentsEnabled } = await getLinearLibraries();
    return { status: 200, body: { sessionComments: setLinearSessionCommentsEnabled(sessionComments) } };
  };

  app.put('/api/linear/preferences', parseJsonBody, async (req, res) => {
    try {
      const { status, body } = await writePreferences(req.body?.sessionComments);
      return res.status(status).json(body);
    } catch (error) {
      console.error('Failed to save Linear preferences:', error);
      return res.status(500).json({ error: error.message || 'Failed to save Linear preferences' });
    }
  });

  const activateWorkspace = async (requested) => {
    const {
      activateLinearAuth,
      getLinearAuth,
      getLinearAuthWorkspaces,
      toLinearPublicStatus,
    } = await getLinearLibraries();
    const organizationId = readTrimmedString(requested);
    if (!organizationId) {
      return { status: 400, body: { error: 'organizationId is required' } };
    }
    const activated = activateLinearAuth(organizationId);
    if (!activated) {
      return { status: 404, body: { error: 'Linear workspace not found' } };
    }
    const auth = getLinearAuth();
    if (!auth) {
      return { status: 200, body: { connected: false } };
    }
    return { status: 200, body: toLinearPublicStatus(auth, getLinearAuthWorkspaces()) };
  };

  app.post('/api/linear/auth/activate', parseJsonBody, async (req, res) => {
    try {
      const { status, body } = await activateWorkspace(req.body?.organizationId);
      return res.status(status).json(body);
    } catch (error) {
      console.error('Failed to switch Linear workspace:', error);
      return res.status(500).json({ error: error.message || 'Failed to switch Linear workspace' });
    }
  });

  /** Revokes and drops the current workspace only; other workspaces and the mapping stay. */
  const disconnectCurrent = async () => {
    const { getLinearAuth, clearLinearAuth, revokeToken } = await getLinearLibraries();
    const auth = getLinearAuth();
    if (auth?.refreshToken) {
      await revokeToken(auth.refreshToken, 'refresh_token');
    } else if (auth?.accessToken) {
      await revokeToken(auth.accessToken, 'access_token');
    }
    const removed = clearLinearAuth(auth?.workspaceId);
    return { success: true, removed };
  };

  app.delete('/api/linear/auth', async (_req, res) => {
    try {
      return res.json(await disconnectCurrent());
    } catch (error) {
      console.error('Failed to disconnect Linear:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect Linear' });
    }
  });

  return Object.freeze({
    status: readStatus,
    activate: activateWorkspace,
    disconnect: disconnectCurrent,
    readMapping,
    writeMapping,
    readPreferences,
    writePreferences,
  });
}
