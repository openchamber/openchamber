import { describe, expect, it } from 'vitest';

import { createTestPlatformDb } from '../db/test-utils.js';
import { changeUserHome, importUser, normalizeHomePath } from './user-import.js';

const ISSUER = 'https://idp.example.test';

function binding(overrides = {}) {
  return {
    issuer: ISSUER,
    subject: 'subject-alice',
    displayName: 'Alice',
    linuxUid: 2001,
    linuxGid: 2001,
    homePath: '/home/alice',
    ...overrides,
  };
}

describe('normalizeHomePath', () => {
  it('resolves and strips trailing slashes', () => {
    expect(normalizeHomePath('/home/alice/')).toBe('/home/alice');
    expect(normalizeHomePath('/home/alice///')).toBe('/home/alice');
    expect(normalizeHomePath('/home/alice/../alice')).toBe('/home/alice');
  });

  it('rejects empty, relative, and filesystem-root paths', () => {
    for (const bad of ['', '   ', 'home/alice', './alice', '/']) {
      expect(() => normalizeHomePath(bad)).toThrow();
    }
  });
});

describe('importUser', () => {
  it('creates a user with a normalized home path', async () => {
    const db = await createTestPlatformDb();
    const { user, created } = await importUser(db, binding({ homePath: '/home/alice/' }));
    expect(created).toBe(true);
    expect(user.home_path).toBe('/home/alice');
    expect(user.linux_uid).toBe(2001);
    expect(user.role).toBe('user');
    expect(user.status).toBe('active');
  });

  it('rejects root uid, root gid, and unprivileged-invalid values', async () => {
    const db = await createTestPlatformDb();
    await expect(importUser(db, binding({ linuxUid: 0 }))).rejects.toThrow(/linux_uid/);
    await expect(importUser(db, binding({ linuxUid: -1 }))).rejects.toThrow(/linux_uid/);
    await expect(importUser(db, binding({ linuxUid: 2001.5 }))).rejects.toThrow(/linux_uid/);
    await expect(importUser(db, binding({ linuxGid: 0 }))).rejects.toThrow(/linux_gid/);
    await expect(importUser(db, binding({ homePath: '' }))).rejects.toThrow(/home_path/);
    await expect(importUser(db, binding({ homePath: 'alice' }))).rejects.toThrow(/home_path/);
    await expect(importUser(db, binding({ homePath: '/' }))).rejects.toThrow(/filesystem root/);
    await expect(importUser(db, binding({ issuer: '' }))).rejects.toThrow(/issuer/);
    await expect(importUser(db, binding({ subject: ' ' }))).rejects.toThrow(/subject/);
  });

  it('is idempotent per identity and never changes ownership on re-import', async () => {
    const db = await createTestPlatformDb();
    const first = await importUser(db, binding());
    const second = await importUser(db, binding({ displayName: 'Ignored Rename' }));
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.home_path).toBe('/home/alice');
    expect(second.user.display_name).toBe('Alice');

    const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM users');
    expect(rows[0].count).toBe(1);
  });

  it('rejects re-importing an identity with a different binding', async () => {
    const db = await createTestPlatformDb();
    await importUser(db, binding());
    await expect(importUser(db, binding({ homePath: '/home/bob' }))).rejects.toThrow(/use changeUserHome/);
  });

  it('rejects binding a linux account owned by another identity', async () => {
    const db = await createTestPlatformDb();
    await importUser(db, binding());
    await expect(
      importUser(db, binding({ subject: 'subject-bob', displayName: 'Bob' })),
    ).rejects.toThrow(/already bound/);
    // The same account with the same identity is fine (idempotent).
    const again = await importUser(db, binding({ displayName: 'Alice Again' }));
    expect(again.created).toBe(false);
  });
});

describe('changeUserHome', () => {
  it('rebinds an existing user explicitly', async () => {
    const db = await createTestPlatformDb();
    const { user } = await importUser(db, binding());

    const result = await changeUserHome(db, { userId: user.id, linuxUid: 2002, linuxGid: 2002, homePath: '/home/alice-v2/' });
    expect(result.changed).toBe(true);
    expect(result.user.home_path).toBe('/home/alice-v2');
    expect(result.user.linux_uid).toBe(2002);

    // The new binding is what import now resolves to idempotently.
    const reimported = await importUser(db, binding({ linuxUid: 2002, linuxGid: 2002, homePath: '/home/alice-v2' }));
    expect(reimported.created).toBe(false);
    expect(reimported.user.id).toBe(user.id);
  });

  it('allows gid-only changes on the same account', async () => {
    const db = await createTestPlatformDb();
    const { user } = await importUser(db, binding());
    const result = await changeUserHome(db, { userId: user.id, linuxUid: 2001, linuxGid: 3001, homePath: '/home/alice' });
    expect(result.changed).toBe(true);
    expect(result.user.linux_gid).toBe(3001);
  });

  it('is a no-op when nothing changes', async () => {
    const db = await createTestPlatformDb();
    const { user } = await importUser(db, binding());
    const result = await changeUserHome(db, { userId: user.id, linuxUid: 2001, linuxGid: 2001, homePath: '/home/alice' });
    expect(result.changed).toBe(false);
  });

  it('rejects unknown users, taken accounts, and invalid values', async () => {
    const db = await createTestPlatformDb();
    const { user } = await importUser(db, binding());
    await importUser(db, binding({ subject: 'subject-bob', displayName: 'Bob', linuxUid: 2002, linuxGid: 2002, homePath: '/home/bob' }));

    await expect(
      changeUserHome(db, { userId: '00000000-0000-0000-0000-000000000000', linuxUid: 2003, linuxGid: 2003, homePath: '/home/nope' }),
    ).rejects.toThrow(/no user with id/);
    await expect(
      changeUserHome(db, { userId: user.id, linuxUid: 2002, linuxGid: 2002, homePath: '/home/bob' }),
    ).rejects.toThrow(/already bound/);
    await expect(
      changeUserHome(db, { userId: user.id, linuxUid: 0, linuxGid: 2003, homePath: '/home/nope' }),
    ).rejects.toThrow(/linux_uid/);
  });
});
