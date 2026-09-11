import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { writeAuditEvent } from './audit-writer.js';
import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';

async function seedUserAndWorkspace(db) {
  const { user } = await importUser(db, {
    issuer: 'https://idp.example.test',
    subject: 'subject-alice',
    displayName: 'Alice',
    linuxUid: 2001,
    linuxGid: 2001,
    homePath: '/home/alice',
  });
  const workspaceId = randomUUID();
  await db.query('INSERT INTO workspaces (id, owner_user_id) VALUES ($1, $2)', [workspaceId, user.id]);
  return { user, workspaceId };
}

describe('writeAuditEvent', () => {
  it('round-trips an audit event with all metadata fields', async () => {
    const db = await createTestPlatformDb();
    const { user, workspaceId } = await seedUserAndWorkspace(db);

    const event = await writeAuditEvent(db, {
      actorUserId: user.id,
      targetUserId: user.id,
      workspaceId,
      action: 'workspace.start',
      requestId: 'req-123',
      outcome: 'allowed',
    });
    expect(event.id).toBeTruthy();
    expect(event.createdAt).toBeTruthy();

    const { rows } = await db.query('SELECT * FROM audit_events WHERE id = $1', [event.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: event.id,
      actor_user_id: user.id,
      target_user_id: user.id,
      workspace_id: workspaceId,
      action: 'workspace.start',
      request_id: 'req-123',
      outcome: 'allowed',
    });
  });

  it('allows system events without actor, target, workspace, or request', async () => {
    const db = await createTestPlatformDb();
    const event = await writeAuditEvent(db, { action: 'platform.startup', outcome: 'success' });
    const { rows } = await db.query('SELECT * FROM audit_events WHERE id = $1', [event.id]);
    expect(rows[0].actor_user_id).toBeNull();
    expect(rows[0].workspace_id).toBeNull();
    expect(rows[0].request_id).toBeNull();
  });

  it('requires action and outcome', async () => {
    const db = await createTestPlatformDb();
    await expect(writeAuditEvent(db, { outcome: 'allowed' })).rejects.toThrow(/action/);
    await expect(writeAuditEvent(db, { action: 'workspace.start' })).rejects.toThrow(/outcome/);
  });

  it('enforces foreign keys on actor, target, and workspace', async () => {
    const db = await createTestPlatformDb();
    const bogus = randomUUID();
    await expect(
      writeAuditEvent(db, { actorUserId: bogus, action: 'a', outcome: 'b' }),
    ).rejects.toThrow();
  });

  it('stores metadata only: no prompt or content columns exist', async () => {
    const db = await createTestPlatformDb();
    const { rows: columns } = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'audit_events'
       ORDER BY ordinal_position`,
    );
    expect(columns.map((row) => row.column_name)).toEqual([
      'id', 'actor_user_id', 'target_user_id', 'workspace_id',
      'action', 'request_id', 'outcome', 'created_at',
    ]);
  });
});
