import { getDb } from './db.js';

export async function appendActivityEvent(data) {
  const db = await getDb();
  
  const { workspaceId, kind, actorLogin, repoFullName, payloadJson, happenedAt } = data;
  
  const info = db.prepare(`
    INSERT INTO activity_events (workspace_id, kind, actor_login, repo_full_name, payload_json, happened_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, kind, actorLogin, repoFullName, payloadJson, happenedAt, Date.now());
  
  return info.lastInsertRowid;
}

export async function getActivityEvents(workspaceId, limit = 50) {
  const db = await getDb();
  
  return db.prepare(`
    SELECT * FROM activity_events 
    WHERE workspace_id = ? 
    ORDER BY happened_at DESC 
    LIMIT ?
  `).all(workspaceId, limit);
}
