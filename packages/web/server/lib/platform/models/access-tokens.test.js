// Model access token lifecycle (plan sections 7.3 and 11.1): digest-only
// storage, scoped revocation, resolution with the workspace's current
// generation.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';
import { ensureWorkspaceForUser } from '../workspaces/operations-service.js';
import {
  hashModelAccessToken,
  issueModelAccessToken,
  resolveModelAccessToken,
  revokeModelAccessTokens,
} from './access-tokens.js';

let db;
let user;
let workspace;

beforeEach(async () => {
  db = await createTestPlatformDb();
  const imported = await importUser(db, {
    issuer: 'https://idp.example.com',
    subject: 'token-user',
    displayName: 'Token User',
    linuxUid: 4242,
    linuxGid: 4242,
    homePath: '/home/token-user',
  });
  user = imported.user;
  workspace = await ensureWorkspaceForUser(db, { userId: user.id });
});

afterEach(async () => {
  await db?.end?.();
  db = undefined;
});

describe('issueModelAccessToken', () => {
  it('returns a random token and stores only its sha256 digest', async () => {
    const issued = await issueModelAccessToken(db, {
      userId: user.id, workspaceId: workspace.id, generation: 0,
    });
    expect(typeof issued.token).toBe('string');
    expect(issued.token.length).toBeGreaterThanOrEqual(32);
    expect(issued.tokenDigest).toBe(hashModelAccessToken(issued.token));

    const { rows } = await db.query('SELECT * FROM model_access_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(issued.tokenDigest);
    expect(rows[0].token_hash).not.toBe(issued.token);
    expect(rows[0].status).toBe('active');
    expect(rows[0].generation).toBe(0);
  });

  it('issues distinct tokens per call', async () => {
    const a = await issueModelAccessToken(db, { userId: user.id, workspaceId: workspace.id, generation: 0 });
    const b = await issueModelAccessToken(db, { userId: user.id, workspaceId: workspace.id, generation: 0 });
    expect(a.token).not.toBe(b.token);
    const { rows } = await db.query('SELECT * FROM model_access_tokens');
    expect(rows).toHaveLength(2);
  });

  it('validates its inputs', async () => {
    await expect(issueModelAccessToken(db, { workspaceId: workspace.id, generation: 0 }))
      .rejects.toThrow(/userId/);
    await expect(issueModelAccessToken(db, { userId: user.id, generation: 0 }))
      .rejects.toThrow(/workspaceId/);
    await expect(issueModelAccessToken(db, { userId: user.id, workspaceId: workspace.id, generation: -1 }))
      .rejects.toThrow(/generation/);
  });
});

describe('revokeModelAccessTokens', () => {
  it('revokes by user scope', async () => {
    await issueModelAccessToken(db, { userId: user.id, workspaceId: workspace.id, generation: 0 });
    const result = await revokeModelAccessTokens(db, { userId: user.id });
    expect(result.revoked).toBe(1);
    const resolved = await resolveModelAccessToken(db, {
      tokenDigest: hashModelAccessToken('unused'),
    });
    expect(resolved).toBeNull();
    const { rows } = await db.query('SELECT status FROM model_access_tokens');
    expect(rows[0].status).toBe('revoked');
  });

  it('revokes by workspace scope', async () => {
    await issueModelAccessToken(db, { userId: user.id, workspaceId: workspace.id, generation: 0 });
    const result = await revokeModelAccessTokens(db, { workspaceId: workspace.id });
    expect(result.revoked).toBe(1);
  });

  it('revokes by generation scope only', async () => {
    await issueModelAccessToken(db, { userId: user.id, workspaceId: workspace.id, generation: 0 });
    await issueModelAccessToken(db, { userId: user.id, workspaceId: workspace.id, generation: 1 });
    const result = await revokeModelAccessTokens(db, { generation: 0 });
    expect(result.revoked).toBe(1);
    const { rows } = await db.query('SELECT generation, status FROM model_access_tokens ORDER BY generation');
    expect(rows).toEqual([
      { generation: 0, status: 'revoked' },
      { generation: 1, status: 'active' },
    ]);
  });

  it('requires at least one scope', async () => {
    await expect(revokeModelAccessTokens(db, {})).rejects.toThrow(/at least one scope/);
  });

  it('is a no-op on already-revoked tokens', async () => {
    await issueModelAccessToken(db, { userId: user.id, workspaceId: workspace.id, generation: 0 });
    await revokeModelAccessTokens(db, { userId: user.id });
    const again = await revokeModelAccessTokens(db, { userId: user.id });
    expect(again.revoked).toBe(0);
  });
});

describe('resolveModelAccessToken', () => {
  it('returns the record with the workspace generation, null for unknown digests', async () => {
    const issued = await issueModelAccessToken(db, {
      userId: user.id, workspaceId: workspace.id, generation: workspace.generation,
    });
    const resolved = await resolveModelAccessToken(db, { tokenDigest: issued.tokenDigest });
    expect(resolved.userId).toBe(user.id);
    expect(resolved.workspaceId).toBe(workspace.id);
    expect(resolved.generation).toBe(workspace.generation);
    expect(resolved.workspaceGeneration).toBe(workspace.generation);
    expect(resolved.status).toBe('active');

    expect(await resolveModelAccessToken(db, { tokenDigest: 'unknown' })).toBeNull();
    expect(await resolveModelAccessToken(db, { tokenDigest: '' })).toBeNull();
  });

  it('surfaces revoked status so validation can reject old credentials', async () => {
    const issued = await issueModelAccessToken(db, { userId: user.id, workspaceId: workspace.id, generation: 0 });
    await revokeModelAccessTokens(db, { userId: user.id });
    const resolved = await resolveModelAccessToken(db, { tokenDigest: issued.tokenDigest });
    expect(resolved.status).toBe('revoked');
  });
});
