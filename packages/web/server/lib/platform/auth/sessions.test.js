import { afterEach, describe, expect, it } from 'vitest';

import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';
import {
  SESSION_COOKIE_NAME,
  buildClearedSessionCookie,
  buildSessionCookie,
  createPlatformSession,
  hashSessionToken,
  readSessionCookie,
  resolvePlatformSession,
  revokePlatformSession,
} from './sessions.js';

const ISSUER = 'https://idp.example.com';

describe('platform sessions', () => {
  let db;

  afterEach(async () => {
    await db?.end?.();
    db = undefined;
  });

  const seedUser = async () => {
    const { user } = await importUser(db, {
      issuer: ISSUER,
      subject: 'subject-1',
      displayName: 'User One',
      linuxUid: 1001,
      linuxGid: 1001,
      homePath: '/home/user1',
    });
    return user;
  };

  it('creates a session and resolves it with the user binding', async () => {
    db = await createTestPlatformDb();
    const user = await seedUser();

    const { token, expiresAt } = await createPlatformSession(db, { userId: user.id });
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const resolved = await resolvePlatformSession(db, { token });
    expect(resolved.user.id).toBe(user.id);
    expect(resolved.user.displayName).toBe('User One');
    expect(resolved.user.linuxUid).toBe(1001);
    expect(resolved.user.homePath).toBe('/home/user1');
  });

  it('never stores the raw token: only its sha256 digest', async () => {
    db = await createTestPlatformDb();
    const user = await seedUser();
    const { token } = await createPlatformSession(db, { userId: user.id });

    const { rows } = await db.query('SELECT token_hash FROM auth_sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashSessionToken(token));
    expect(rows[0].token_hash).not.toContain(token);
  });

  it('rejects unknown, revoked and expired tokens identically (null)', async () => {
    db = await createTestPlatformDb();
    const user = await seedUser();
    const { token } = await createPlatformSession(db, { userId: user.id });

    expect(await resolvePlatformSession(db, { token: 'no-such-token' })).toBeNull();

    expect(await revokePlatformSession(db, { token })).toBe(true);
    // Revocation is idempotent.
    expect(await revokePlatformSession(db, { token })).toBe(false);
    expect(await resolvePlatformSession(db, { token })).toBeNull();

    const short = await createPlatformSession(db, { userId: user.id, ttlMs: 60_000, now: Date.now() - 120_000 });
    expect(await resolvePlatformSession(db, { token: short.token })).toBeNull();
  });

  it('slides last_seen_at on activity, throttled', async () => {
    db = await createTestPlatformDb();
    const user = await seedUser();
    const t0 = Date.parse('2026-09-08T00:00:00.000Z');
    const { token } = await createPlatformSession(db, { userId: user.id, now: t0 });

    // First activity after 2 minutes: last_seen_at moves.
    await resolvePlatformSession(db, { token, now: t0 + 120_000 });
    let { rows } = await db.query('SELECT last_seen_at FROM auth_sessions');
    expect(rows[0].last_seen_at.getTime()).toBe(t0 + 120_000);

    // Second activity 10 seconds later: within the throttle window, untouched.
    await resolvePlatformSession(db, { token, now: t0 + 130_000 });
    ({ rows } = await db.query('SELECT last_seen_at FROM auth_sessions'));
    expect(rows[0].last_seen_at.getTime()).toBe(t0 + 120_000);
  });

  it('parses only the platform cookie from a Cookie header', () => {
    expect(readSessionCookie({ headers: { cookie: 'a=1; oc_platform_session=tok; b=2' } })).toBe('tok');
    expect(readSessionCookie({ headers: { cookie: 'oc_platform_session=tok' } })).toBe('tok');
    expect(readSessionCookie({ headers: { cookie: 'other=1' } })).toBeNull();
    expect(readSessionCookie({ headers: {} })).toBeNull();
    expect(readSessionCookie({ headers: { cookie: 'oc_platform_session=' } })).toBeNull();
  });

  it('builds cookies with HttpOnly, SameSite=Lax, Path=/ and conditional Secure', () => {
    const secure = buildSessionCookie('tok', { secure: true, ttlMs: 60_000 });
    expect(secure).toContain(`${SESSION_COOKIE_NAME}=tok`);
    expect(secure).toContain('HttpOnly');
    expect(secure).toContain('SameSite=Lax');
    expect(secure).toContain('Path=/');
    expect(secure).toContain('Secure');
    expect(secure).toContain('Max-Age=60');

    const insecure = buildSessionCookie('tok', { secure: false, ttlMs: 60_000 });
    expect(insecure).not.toContain('Secure');

    const cleared = buildClearedSessionCookie({ secure: true });
    expect(cleared).toContain('Max-Age=0');
  });
});
