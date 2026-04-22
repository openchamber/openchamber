import crypto from 'crypto';
import { getDb } from './db.js';

export async function createWorkspace(payload) {
  const db = await getDb();
  
  const id = crypto.randomUUID();
  const { githubOrgLogin, githubInstallationId, displayName, creatorUserId, creatorUserLogin } = payload;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO workspaces (id, github_org_login, github_installation_id, display_name, created_at, settings_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, githubOrgLogin, githubInstallationId, displayName, Date.now(), '{}');

    // Add creator as owner
    db.prepare(`
      INSERT INTO workspace_members (workspace_id, github_user_id, github_user_login, role, joined_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, creatorUserId, creatorUserLogin, 'owner', Date.now());

    // Audit log
    db.prepare(`
      INSERT INTO activity_events (workspace_id, kind, actor_login, repo_full_name, payload_json, happened_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, 'workspace.created', creatorUserLogin, '', '{}', Date.now(), Date.now());
  });

  tx();

  return id;
}

export async function listWorkspacesForUser(githubUserId) {
  const db = await getDb();
  
  return db.prepare(`
    SELECT w.*, m.role
    FROM workspaces w
    JOIN workspace_members m ON w.id = m.workspace_id
    WHERE m.github_user_id = ?
  `).all(githubUserId);
}

export async function getWorkspace(id) {
  const db = await getDb();
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) || null;
}

export async function deleteWorkspace(id) {
  const db = await getDb();
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
}

export async function getWorkspaceMembers(workspaceId) {
  const db = await getDb();
  return db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ?').all(workspaceId);
}

export async function updateMemberRole(workspaceId, githubUserLogin, role) {
  const db = await getDb();
  const info = db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND github_user_login = ?').run(role, workspaceId, githubUserLogin);
  if (info.changes === 0) {
    throw new Error('Member not found');
  }
}
