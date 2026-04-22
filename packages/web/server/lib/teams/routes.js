import {
  createWorkspace,
  listWorkspacesForUser,
  getWorkspace,
  deleteWorkspace,
  getWorkspaceMembers,
  updateMemberRole,
} from './workspace.js';
import { getGitHubAuth } from '../github/auth.js';

export function registerTeamsRoutes(app) {
  // Authentication middleware for /api/teams routes
  const requireAuth = (req, res, next) => {
    const auth = getGitHubAuth();
    if (!auth || !auth.user || !auth.user.id) {
      return res.status(401).json({ ok: false, error: { code: 'not_authenticated', message: 'Not authenticated' } });
    }
    req.user = auth.user;
    next();
  };

  // 1. Create a workspace from an installation ID
  app.post('/api/teams/workspaces', requireAuth, async (req, res) => {
    try {
      const { githubOrgLogin, githubInstallationId, displayName } = req.body || {};
      
      if (!githubOrgLogin || !githubInstallationId || !displayName) {
        return res.status(400).json({ ok: false, error: { code: 'bad_input', message: 'Missing required fields' } });
      }

      const workspaceId = await createWorkspace({
        githubOrgLogin,
        githubInstallationId: Number(githubInstallationId),
        displayName,
        creatorUserId: req.user.id,
        creatorUserLogin: req.user.login,
      });

      return res.json({ ok: true, data: { workspaceId } });
    } catch (error) {
      console.error('Failed to create workspace:', error);
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ ok: false, error: { code: 'conflict', message: 'Workspace for this org already exists' } });
      }
      return res.status(500).json({ ok: false, error: { code: 'internal', message: 'Failed to create workspace' } });
    }
  });

  // 2. List workspaces for the authenticated user
  app.get('/api/teams/workspaces', requireAuth, async (req, res) => {
    try {
      const workspaces = await listWorkspacesForUser(req.user.id);
      return res.json({ ok: true, data: { workspaces } });
    } catch (error) {
      console.error('Failed to list workspaces:', error);
      return res.status(500).json({ ok: false, error: { code: 'internal', message: 'Failed to list workspaces' } });
    }
  });

  // 3. Set current active workspace (just returns OK since state is managed client-side in Mode 2)
  app.post('/api/teams/workspaces/:id/activate', requireAuth, async (req, res) => {
    try {
      const workspace = await getWorkspace(req.params.id);
      if (!workspace) {
        return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Workspace not found' } });
      }
      // Validating membership
      const workspaces = await listWorkspacesForUser(req.user.id);
      if (!workspaces.find((w) => w.id === req.params.id)) {
         return res.status(403).json({ ok: false, error: { code: 'forbidden', message: 'You are not a member of this workspace' } });
      }
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to activate workspace:', error);
      return res.status(500).json({ ok: false, error: { code: 'internal', message: 'Failed to activate workspace' } });
    }
  });

  // 4. List members
  app.get('/api/teams/workspaces/:id/members', requireAuth, async (req, res) => {
    try {
      const members = await getWorkspaceMembers(req.params.id);
      return res.json({ ok: true, data: { members } });
    } catch (error) {
      console.error('Failed to list members:', error);
      return res.status(500).json({ ok: false, error: { code: 'internal', message: 'Failed to list members' } });
    }
  });

  // 5. Change member role (owner only)
  app.patch('/api/teams/workspaces/:id/members/:login', requireAuth, async (req, res) => {
    try {
      const { role } = req.body || {};
      if (!role) {
        return res.status(400).json({ ok: false, error: { code: 'bad_input', message: 'Missing role' } });
      }

      // Check if current user is owner
      const workspaces = await listWorkspacesForUser(req.user.id);
      const w = workspaces.find((w) => w.id === req.params.id);
      if (!w || w.role !== 'owner') {
        return res.status(403).json({ ok: false, error: { code: 'forbidden', message: 'Only workspace owners can change roles' } });
      }

      await updateMemberRole(req.params.id, req.params.login, role);
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to update role:', error);
      if (error.message === 'Member not found') {
        return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Member not found' } });
      }
      return res.status(500).json({ ok: false, error: { code: 'internal', message: 'Failed to update role' } });
    }
  });

  // 6. Delete workspace (owner only)
  app.delete('/api/teams/workspaces/:id', requireAuth, async (req, res) => {
    try {
      const workspaces = await listWorkspacesForUser(req.user.id);
      const w = workspaces.find((w) => w.id === req.params.id);
      if (!w || w.role !== 'owner') {
        return res.status(403).json({ ok: false, error: { code: 'forbidden', message: 'Only workspace owners can delete workspaces' } });
      }

      await deleteWorkspace(req.params.id);
      return res.json({ ok: true });
    } catch (error) {
      console.error('Failed to delete workspace:', error);
      return res.status(500).json({ ok: false, error: { code: 'internal', message: 'Failed to delete workspace' } });
    }
  });
}
