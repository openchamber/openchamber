// Model request validation and recording (plan sections 11.1 and 11.2):
// token/generation/whitelist/capacity enforcement order, revoked and
// stale-generation credential rejection, usage passthrough with unknown
// staying unknown.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';
import { ensureWorkspaceForUser, getWorkspaceById } from '../workspaces/operations-service.js';
import { issueModelAccessToken } from './access-tokens.js';
import { createConcurrencyGovernor } from './governor.js';
import {
  failModelRequest,
  finishModelRequest,
  startModelRequest,
  validateModelRequest,
} from './model-service.js';
import { resolveAllowedModels } from './runtime-config.js';

const ALLOWED = resolveAllowedModels({ OPENCHAMBER_PLATFORM_ALLOWED_MODELS: 'gpt-4o:openai' });

let db;
let user;
let workspace;

beforeEach(async () => {
  db = await createTestPlatformDb();
  const imported = await importUser(db, {
    issuer: 'https://idp.example.com',
    subject: 'model-user',
    displayName: 'Model User',
    linuxUid: 4343,
    linuxGid: 4343,
    homePath: '/home/model-user',
  });
  user = imported.user;
  workspace = await ensureWorkspaceForUser(db, { userId: user.id });
});

afterEach(async () => {
  await db?.end?.();
  db = undefined;
});

async function issueForCurrentGeneration() {
  return issueModelAccessToken(db, {
    userId: user.id, workspaceId: workspace.id, generation: workspace.generation,
  });
}

describe('validateModelRequest', () => {
  it('accepts a valid request and acquires capacity (released by the caller/proxy)', async () => {
    const issued = await issueForCurrentGeneration();
    const governor = createConcurrencyGovernor({ maxPerUser: 2 });
    const result = await validateModelRequest(db, {
      user,
      workspace,
      model: 'gpt-4o',
      tokenDigest: issued.tokenDigest,
      governor,
      allowedModels: ALLOWED,
    });
    expect(result.ok).toBe(true);
    expect(result.token.userId).toBe(user.id);
    expect(governor.count(user.id)).toBe(1);
  });

  it('rejects an unknown token digest', async () => {
    const governor = createConcurrencyGovernor();
    const result = await validateModelRequest(db, {
      user, workspace, model: 'gpt-4o', tokenDigest: 'nope', governor, allowedModels: ALLOWED,
    });
    expect(result).toEqual({ ok: false, code: 'token_invalid' });
    expect(governor.count(user.id)).toBe(0);
  });

  it('rejects a revoked token (old credentials must fail)', async () => {
    const issued = await issueForCurrentGeneration();
    await db.query("UPDATE model_access_tokens SET status = 'revoked' WHERE token_hash = $1", [
      issued.tokenDigest,
    ]);
    const governor = createConcurrencyGovernor();
    const result = await validateModelRequest(db, {
      user, workspace, model: 'gpt-4o', tokenDigest: issued.tokenDigest, governor, allowedModels: ALLOWED,
    });
    expect(result).toEqual({ ok: false, code: 'token_revoked' });
    expect(governor.count(user.id)).toBe(0);
  });

  it('rejects an expired token', async () => {
    const issued = await issueModelAccessToken(db, {
      userId: user.id, workspaceId: workspace.id, generation: 0, now: 1000, ttlMs: 5000,
    });
    const governor = createConcurrencyGovernor();
    const result = await validateModelRequest(db, {
      user,
      workspace,
      model: 'gpt-4o',
      tokenDigest: issued.tokenDigest,
      governor,
      allowedModels: ALLOWED,
      now: 6001,
    });
    expect(result).toEqual({ ok: false, code: 'token_expired' });
  });

  it('rejects a token from an older workspace generation (rebuild invalidates credentials)', async () => {
    const issued = await issueForCurrentGeneration();
    // The workspace is rebuilt: generation bumps, token stays at the old one.
    await db.query('UPDATE workspaces SET generation = generation + 1 WHERE id = $1', [workspace.id]);
    const fresh = await getWorkspaceById(db, { workspaceId: workspace.id });
    const governor = createConcurrencyGovernor();
    const result = await validateModelRequest(db, {
      user, workspace: fresh, model: 'gpt-4o', tokenDigest: issued.tokenDigest,
      governor, allowedModels: ALLOWED,
    });
    expect(result).toEqual({ ok: false, code: 'generation_mismatch' });
    expect(governor.count(user.id)).toBe(0);

    // A token issued for the new generation validates again.
    const reissued = await issueModelAccessToken(db, {
      userId: user.id, workspaceId: workspace.id, generation: fresh.generation,
    });
    const ok = await validateModelRequest(db, {
      user, workspace: fresh, model: 'gpt-4o', tokenDigest: reissued.tokenDigest,
      governor, allowedModels: ALLOWED,
    });
    expect(ok.ok).toBe(true);
  });

  it('rejects a model outside the whitelist (and allows nothing on an empty whitelist)', async () => {
    const issued = await issueForCurrentGeneration();
    const governor = createConcurrencyGovernor();
    const rejected = await validateModelRequest(db, {
      user, workspace, model: 'not-allowed', tokenDigest: issued.tokenDigest,
      governor, allowedModels: ALLOWED,
    });
    expect(rejected).toEqual({ ok: false, code: 'model_not_allowed' });
    expect(governor.count(user.id)).toBe(0);

    const empty = await validateModelRequest(db, {
      user, workspace, model: 'gpt-4o', tokenDigest: issued.tokenDigest,
      governor, allowedModels: [],
    });
    expect(empty).toEqual({ ok: false, code: 'model_not_allowed' });
  });

  it('rejects when the per-user capacity is exhausted (429-shaped signal)', async () => {
    const issued = await issueForCurrentGeneration();
    const governor = createConcurrencyGovernor({ maxPerUser: 1 });
    expect(governor.acquire(user.id)).toEqual({ ok: true });
    const result = await validateModelRequest(db, {
      user, workspace, model: 'gpt-4o', tokenDigest: issued.tokenDigest,
      governor, allowedModels: ALLOWED,
    });
    expect(result).toEqual({ ok: false, code: 'concurrency_limited' });
  });

  it('rejects a token belonging to another user or workspace', async () => {
    const other = await importUser(db, {
      issuer: 'https://idp.example.com',
      subject: 'model-other',
      displayName: 'Model Other',
      linuxUid: 4444,
      linuxGid: 4444,
      homePath: '/home/model-other',
    });
    const otherToken = await issueModelAccessToken(db, {
      userId: other.user.id, workspaceId: workspace.id, generation: workspace.generation,
    });
    const governor = createConcurrencyGovernor();
    const wrongUser = await validateModelRequest(db, {
      user, workspace, model: 'gpt-4o', tokenDigest: otherToken.tokenDigest,
      governor, allowedModels: ALLOWED,
    });
    expect(wrongUser).toEqual({ ok: false, code: 'token_invalid' });

    const foreignWorkspace = await ensureWorkspaceForUser(db, { userId: other.user.id });
    const otherWorkspaceToken = await issueModelAccessToken(db, {
      userId: user.id, workspaceId: foreignWorkspace.id, generation: foreignWorkspace.generation,
    });
    const wrongWorkspace = await validateModelRequest(db, {
      user, workspace, model: 'gpt-4o', tokenDigest: otherWorkspaceToken.tokenDigest,
      governor, allowedModels: ALLOWED,
    });
    expect(wrongWorkspace).toEqual({ ok: false, code: 'token_invalid' });
  });
});

describe('model request recording', () => {
  it('records start, finish with verbatim usage, and failure with an error code', async () => {
    const started = await startModelRequest(db, {
      userId: user.id, workspaceId: workspace.id, model: 'gpt-4o',
    });
    const { rows: startedRows } = await db.query('SELECT * FROM model_requests WHERE id = $1', [started.id]);
    expect(startedRows[0].status).toBe('started');
    expect(startedRows[0].usage).toEqual({});

    const finished = await finishModelRequest(db, {
      id: started.id, usage: { input_tokens: 12, output_tokens: 34 },
    });
    expect(finished.status).toBe('completed');
    expect(finished.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(finished.finished_at).toBeTruthy();

    const failed = await startModelRequest(db, {
      userId: user.id, workspaceId: workspace.id, model: 'gpt-4o',
    });
    const failedRow = await failModelRequest(db, { id: failed.id, errorCode: 'upstream_unavailable' });
    expect(failedRow.status).toBe('failed');
    expect(failedRow.error_code).toBe('upstream_unavailable');
  });

  it('keeps usage unknown when the provider reported none (never zero-filled)', async () => {
    const started = await startModelRequest(db, { userId: user.id, model: 'gpt-4o' });
    const finished = await finishModelRequest(db, { id: started.id });
    expect(finished.status).toBe('completed');
    expect(finished.usage).toEqual({});
    const zeroFilled = await db.query(
      "SELECT COUNT(*) AS n FROM model_requests WHERE usage::text NOT IN ('{}')",
    );
    expect(Number(zeroFilled.rows[0].n)).toBe(0);
  });

  it('throws for unknown records and invalid input', async () => {
    await expect(finishModelRequest(db, { id: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toThrow(/not found/);
    const started = await startModelRequest(db, { userId: user.id, model: 'gpt-4o' });
    await expect(failModelRequest(db, { id: started.id, errorCode: '' })).rejects.toThrow(/errorCode/);
    await expect(startModelRequest(db, { model: 'gpt-4o' })).rejects.toThrow(/userId/);
  });
});
