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

  app.get('/api/linear/auth/status', async (_req, res) => {
    try {
      const libraries = await getLinearLibraries();
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
          await storeAuthorizationResult(libraries, result);
          await completeAuthorizationBroker(result.brokerReceipt).catch((error) => {
            console.warn('Failed to acknowledge Linear authorization broker result:', error);
          });
        }
      } catch (error) {
        console.error('Failed to complete Linear authorization through broker:', error);
      }

      const accessToken = await getValidLinearAccessToken();
      if (!accessToken) {
        return res.json({ connected: false });
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
        return res.json(toLinearPublicStatus(next, getLinearAuthWorkspaces()));
      } catch (error) {
        if (error?.status === 401) {
          clearLinearAuth(auth?.workspaceId);
          const remaining = getLinearAuth();
          if (!remaining) {
            return res.json({ connected: false });
          }
          return res.json(toLinearPublicStatus(remaining, getLinearAuthWorkspaces()));
        }
        if (auth) {
          return res.json(toLinearPublicStatus(auth, getLinearAuthWorkspaces()));
        }
        throw error;
      }
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

  app.get('/api/linear/mapping', async (_req, res) => {
    try {
      const {
        listLinearTeams,
        readStoredLinearMapping,
        mergeLinearMappingView,
        LinearMappingError,
      } = await getLinearLibraries();
      const teamsResult = await listLinearTeams();
      if (teamsResult.connected === false) {
        return res.json({ connected: false });
      }
      let stored;
      try {
        stored = readStoredLinearMapping();
      } catch (error) {
        if (error instanceof LinearMappingError && error.code === 'MALFORMED') {
          return res.status(500).json({ error: error.message });
        }
        throw error;
      }
      return res.json({
        connected: true,
        ...mergeLinearMappingView(stored, teamsResult.teams),
      });
    } catch (error) {
      console.error('Failed to load Linear mapping:', error);
      return res.status(500).json({ error: error.message || 'Failed to load Linear mapping' });
    }
  });

  app.put('/api/linear/mapping', parseJsonBody, async (req, res) => {
    try {
      const {
        getValidLinearAccessToken,
        listLinearTeams,
        setStoredLinearMapping,
        mergeLinearMappingView,
        LinearMappingError,
      } = await getLinearLibraries();
      const accessToken = await getValidLinearAccessToken();
      if (!accessToken) {
        return res.json({ connected: false });
      }
      let stored;
      try {
        stored = setStoredLinearMapping(req.body);
      } catch (error) {
        if (error instanceof LinearMappingError && error.code === 'INVALID') {
          return res.status(400).json({ error: error.message });
        }
        throw error;
      }
      const teamsResult = await listLinearTeams();
      if (teamsResult.connected === false) {
        return res.json({
          connected: true,
          ...mergeLinearMappingView(stored, []),
        });
      }
      return res.json({
        connected: true,
        ...mergeLinearMappingView(stored, teamsResult.teams),
      });
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

  app.get('/api/linear/preferences', async (_req, res) => {
    try {
      const { getLinearSessionCommentsEnabled } = await getLinearLibraries();
      return res.json({ sessionComments: getLinearSessionCommentsEnabled() });
    } catch (error) {
      console.error('Failed to load Linear preferences:', error);
      return res.status(500).json({ error: error.message || 'Failed to load Linear preferences' });
    }
  });

  app.put('/api/linear/preferences', parseJsonBody, async (req, res) => {
    try {
      const sessionComments = req.body?.sessionComments;
      if (sessionComments !== true && sessionComments !== false) {
        return res.status(400).json({ error: 'sessionComments must be a boolean' });
      }
      const { setLinearSessionCommentsEnabled } = await getLinearLibraries();
      return res.json({ sessionComments: setLinearSessionCommentsEnabled(sessionComments) });
    } catch (error) {
      console.error('Failed to save Linear preferences:', error);
      return res.status(500).json({ error: error.message || 'Failed to save Linear preferences' });
    }
  });

  app.post('/api/linear/auth/activate', parseJsonBody, async (req, res) => {
    try {
      const {
        activateLinearAuth,
        getLinearAuth,
        getLinearAuthWorkspaces,
        toLinearPublicStatus,
      } = await getLinearLibraries();
      const organizationId = readTrimmedString(req.body?.organizationId);
      if (!organizationId) {
        return res.status(400).json({ error: 'organizationId is required' });
      }
      const activated = activateLinearAuth(organizationId);
      if (!activated) {
        return res.status(404).json({ error: 'Linear workspace not found' });
      }
      const auth = getLinearAuth();
      if (!auth) {
        return res.json({ connected: false });
      }
      return res.json(toLinearPublicStatus(auth, getLinearAuthWorkspaces()));
    } catch (error) {
      console.error('Failed to switch Linear workspace:', error);
      return res.status(500).json({ error: error.message || 'Failed to switch Linear workspace' });
    }
  });

  app.delete('/api/linear/auth', async (_req, res) => {
    try {
      const { getLinearAuth, clearLinearAuth, revokeToken } = await getLinearLibraries();
      const auth = getLinearAuth();
      if (auth?.refreshToken) {
        await revokeToken(auth.refreshToken, 'refresh_token');
      } else if (auth?.accessToken) {
        await revokeToken(auth.accessToken, 'access_token');
      }
      const removed = clearLinearAuth(auth?.workspaceId);
      return res.json({ success: true, removed });
    } catch (error) {
      console.error('Failed to disconnect Linear:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect Linear' });
    }
  });
}
