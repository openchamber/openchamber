import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getDb, closeDb, _setDbPathOverrideForTest } from '../db.js';
import { createWorkspace, listWorkspacesForUser, getWorkspace, deleteWorkspace, getWorkspaceMembers, updateMemberRole } from '../workspace.js';

describe('workspace.js', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-teams-workspace-test-'));
    _setDbPathOverrideForTest(path.join(tempDir, 'team.db'));
  });

  afterEach(async () => {
    closeDb();
    _setDbPathOverrideForTest(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates and lists workspaces', async () => {
    const id = await createWorkspace({
      githubOrgLogin: 'acme-corp',
      githubInstallationId: 12345,
      displayName: 'Acme Corp',
      creatorUserId: 999,
      creatorUserLogin: 'alice'
    });

    expect(id).toBeDefined();

    const w1 = await getWorkspace(id);
    expect(w1.display_name).toBe('Acme Corp');

    const workspaces = await listWorkspacesForUser(999);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].role).toBe('owner');
    
    const members = await getWorkspaceMembers(id);
    expect(members).toHaveLength(1);
    expect(members[0].github_user_login).toBe('alice');

    await updateMemberRole(id, 'alice', 'maintainer');
    const workspacesUpdated = await listWorkspacesForUser(999);
    expect(workspacesUpdated[0].role).toBe('maintainer');

    await deleteWorkspace(id);
    const workspacesDeleted = await listWorkspacesForUser(999);
    expect(workspacesDeleted).toHaveLength(0);
  });
});
