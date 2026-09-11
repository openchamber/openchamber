import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createTestPlatformDb } from './test-utils.js';

async function insertUser(db, overrides = {}) {
  const user = {
    id: randomUUID(),
    issuer: 'https://idp.example.test',
    subject: randomUUID(),
    display_name: 'Test User',
    linux_uid: 2000,
    linux_gid: 2000,
    home_path: `/home/test-${randomUUID().slice(0, 8)}`,
    ...overrides,
  };
  await db.query(
    `INSERT INTO users (id, issuer, subject, display_name, linux_uid, linux_gid, home_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [user.id, user.issuer, user.subject, user.display_name, user.linux_uid, user.linux_gid, user.home_path],
  );
  return user;
}

async function insertWorkspace(db, ownerUserId, overrides = {}) {
  const workspace = {
    id: randomUUID(),
    owner_user_id: ownerUserId,
    ...overrides,
  };
  await db.query('INSERT INTO workspaces (id, owner_user_id) VALUES ($1, $2)', [workspace.id, workspace.owner_user_id]);
  return workspace;
}

describe('platform schema constraints', () => {
  it('enforces unique (issuer, subject) on users', async () => {
    const db = await createTestPlatformDb();
    const first = await insertUser(db);
    await expect(
      insertUser(db, { issuer: first.issuer, subject: first.subject, linux_uid: 3000, home_path: '/home/other' }),
    ).rejects.toThrow();
  });

  it('enforces unique (linux_uid, home_path) on users', async () => {
    const db = await createTestPlatformDb();
    const first = await insertUser(db);
    await expect(
      insertUser(db, { linux_uid: first.linux_uid, home_path: first.home_path }),
    ).rejects.toThrow();
  });

  it('rejects root and unnormalized bindings at the database level', async () => {
    const db = await createTestPlatformDb();
    await expect(insertUser(db, { linux_uid: 0 })).rejects.toThrow();
    await expect(insertUser(db, { linux_gid: 0 })).rejects.toThrow();
    await expect(insertUser(db, { home_path: 'home/relative' })).rejects.toThrow();
    await expect(insertUser(db, { home_path: '/home/trailing/' })).rejects.toThrow();
    await expect(insertUser(db, { home_path: '/' })).rejects.toThrow();
  });

  it('enforces foreign keys', async () => {
    const db = await createTestPlatformDb();
    await expect(
      db.query(
        `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, 'hash', now())`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it('enforces unique token_hash on auth_sessions', async () => {
    const db = await createTestPlatformDb();
    const user = await insertUser(db);
    await db.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, 'same-hash', now())`,
      [randomUUID(), user.id],
    );
    await expect(
      db.query(
        `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, 'same-hash', now())`,
        [randomUUID(), user.id],
      ),
    ).rejects.toThrow();
  });

  it('enforces one workspace per owner', async () => {
    const db = await createTestPlatformDb();
    const user = await insertUser(db);
    await insertWorkspace(db, user.id);
    await expect(insertWorkspace(db, user.id)).rejects.toThrow();
  });

  it('stores workspace limits as jsonb with an empty object default', async () => {
    const db = await createTestPlatformDb();
    const user = await insertUser(db);
    const workspace = await insertWorkspace(db, user.id);
    const { rows } = await db.query('SELECT limits FROM workspaces WHERE id = $1', [workspace.id]);
    expect(rows[0].limits).toEqual({});
  });

  it('enforces unique (workspace_id, idempotency_key) on runtime_operations', async () => {
    const db = await createTestPlatformDb();
    const user = await insertUser(db);
    const workspace = await insertWorkspace(db, user.id);
    const insert = (key) => db.query(
      `INSERT INTO runtime_operations (id, workspace_id, generation, kind, idempotency_key, requested_by)
       VALUES ($1, $2, 1, 'start', $3, $4)`,
      [randomUUID(), workspace.id, key, user.id],
    );
    await insert('key-1');
    await insert('key-2');
    await expect(insert('key-1')).rejects.toThrow();
  });

  it('enforces unique (workspace_id, opencode_session_id) on agent_sessions', async () => {
    const db = await createTestPlatformDb();
    const user = await insertUser(db);
    const workspace = await insertWorkspace(db, user.id);
    const insert = (opencodeSessionId) => db.query(
      `INSERT INTO agent_sessions (id, workspace_id, execution_mode, opencode_session_id, work_dir)
       VALUES ($1, $2, 'native', $3, '/project')`,
      [randomUUID(), workspace.id, opencodeSessionId],
    );
    await insert('ses_1');
    await expect(insert('ses_1')).rejects.toThrow();
    await insert('ses_2');
  });

  it('uses user_preferences.user_id as primary key', async () => {
    const db = await createTestPlatformDb();
    const user = await insertUser(db);
    await db.query('INSERT INTO user_preferences (user_id, locale) VALUES ($1, $2)', [user.id, 'en']);
    await expect(
      db.query('INSERT INTO user_preferences (user_id, locale) VALUES ($1, $2)', [user.id, 'de']),
    ).rejects.toThrow();
  });

  it('enforces unique token_hash on model_access_tokens', async () => {
    const db = await createTestPlatformDb();
    const user = await insertUser(db);
    await db.query(
      `INSERT INTO model_access_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, 'tok', now())`,
      [randomUUID(), user.id],
    );
    await expect(
      db.query(
        `INSERT INTO model_access_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, 'tok', now())`,
        [randomUUID(), user.id],
      ),
    ).rejects.toThrow();
  });

  it('stores model_requests.usage as jsonb with an empty object default', async () => {
    const db = await createTestPlatformDb();
    const user = await insertUser(db);
    const { rows } = await db.query(
      `INSERT INTO model_requests (id, user_id, model, status) VALUES ($1, $2, 'test-model', 'ok') RETURNING usage`,
      [randomUUID(), user.id],
    );
    expect(rows[0].usage).toEqual({});
  });
});
