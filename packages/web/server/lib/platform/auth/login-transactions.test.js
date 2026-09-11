import { afterEach, describe, expect, it } from 'vitest';

import { createTestPlatformDb } from '../db/test-utils.js';
import {
  LOGIN_TRANSACTION_TTL_MS,
  consumeLoginTransaction,
  createLoginTransaction,
} from './login-transactions.js';

describe('login transactions', () => {
  let db;

  afterEach(async () => {
    await db?.end?.();
    db = undefined;
  });

  it('creates a transaction and consumes it exactly once', async () => {
    db = await createTestPlatformDb();
    await createLoginTransaction(db, {
      state: 'state-1',
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
    });

    const first = await consumeLoginTransaction(db, { state: 'state-1' });
    expect(first).toEqual(expect.objectContaining({ nonce: 'nonce-1', codeVerifier: 'verifier-1' }));

    // Single use: a replayed state finds nothing.
    const second = await consumeLoginTransaction(db, { state: 'state-1' });
    expect(second).toBeNull();
  });

  it('rejects an unknown state', async () => {
    db = await createTestPlatformDb();
    expect(await consumeLoginTransaction(db, { state: 'never-issued' })).toBeNull();
  });

  it('rejects an expired transaction', async () => {
    db = await createTestPlatformDb();
    const now = Date.parse('2026-09-08T00:00:00.000Z');
    await createLoginTransaction(db, {
      state: 'state-exp',
      nonce: 'nonce-exp',
      codeVerifier: 'verifier-exp',
      now,
      ttlMs: LOGIN_TRANSACTION_TTL_MS,
    });

    // Still valid just before expiry.
    const before = await consumeLoginTransaction(db, {
      state: 'state-exp',
      now: now + LOGIN_TRANSACTION_TTL_MS - 1000,
    });
    expect(before).not.toBeNull();

    await createLoginTransaction(db, {
      state: 'state-exp2',
      nonce: 'nonce-exp2',
      codeVerifier: 'verifier-exp2',
      now,
      ttlMs: LOGIN_TRANSACTION_TTL_MS,
    });
    const after = await consumeLoginTransaction(db, {
      state: 'state-exp2',
      now: now + LOGIN_TRANSACTION_TTL_MS + 1000,
    });
    expect(after).toBeNull();
  });

  it('enforces unique state values', async () => {
    db = await createTestPlatformDb();
    await createLoginTransaction(db, { state: 'dup', nonce: 'n1', codeVerifier: 'v1' });
    await expect(
      createLoginTransaction(db, { state: 'dup', nonce: 'n2', codeVerifier: 'v2' }),
    ).rejects.toThrow();
  });

  it('rejects empty material', async () => {
    db = await createTestPlatformDb();
    await expect(createLoginTransaction(db, { state: '', nonce: 'n', codeVerifier: 'v' }))
      .rejects.toThrow(/state/);
    await expect(createLoginTransaction(db, { state: 's', nonce: '', codeVerifier: 'v' }))
      .rejects.toThrow(/nonce/);
    await expect(createLoginTransaction(db, { state: 's', nonce: 'n', codeVerifier: '' }))
      .rejects.toThrow(/verifier/);
  });
});
