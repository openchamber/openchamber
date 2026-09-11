import { afterEach, describe, expect, it } from 'vitest';

import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';
import { buildMeView, capabilitiesForRole } from './me-view.js';

const ISSUER = 'https://idp.example.com';

describe('me view', () => {
  let db;

  afterEach(async () => {
    await db?.end?.();
    db = undefined;
  });

  it('grants the admin superset of the user capabilities', () => {
    const userCaps = capabilitiesForRole('user');
    const adminCaps = capabilitiesForRole('admin');
    expect(userCaps).not.toContain('admin.users.read');
    for (const cap of userCaps) {
      expect(adminCaps).toContain(cap);
    }
    expect(adminCaps).toContain('admin.audit.read');
  });

  it('returns the user view with locale preference and no internals', async () => {
    db = await createTestPlatformDb();
    const { user } = await importUser(db, {
      issuer: ISSUER,
      subject: 'subject-1',
      displayName: 'User One',
      linuxUid: 1001,
      linuxGid: 1001,
      homePath: '/home/user1',
    });
    await db.query(
      'INSERT INTO user_preferences (user_id, locale) VALUES ($1, $2)',
      [user.id, 'zh-CN'],
    );

    const view = await buildMeView(db, {
      user: {
        id: user.id,
        displayName: user.display_name,
        role: user.role,
        status: user.status,
        linuxUid: user.linux_uid,
        linuxGid: user.linux_gid,
        homePath: user.home_path,
      },
    });

    expect(view.user).toEqual({
      id: user.id,
      display_name: 'User One',
      role: 'user',
      status: 'active',
      linux_identity: { bound: true },
    });
    expect(view.locale).toBe('zh-CN');
    expect(view.capabilities).toContain('workspace.start');
    expect(view.workspace).toBeNull();

    // Plan section 7.3: never expose uid/gid/home or credentials upstream.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('/home/user1');
    expect(serialized).not.toContain('1001');
  });

  it('defaults the locale and reports an unbound linux identity', async () => {
    db = await createTestPlatformDb();
    const view = await buildMeView(db, {
      user: {
        id: '00000000-0000-0000-0000-000000000000',
        displayName: 'X',
        role: 'user',
        status: 'active',
        linuxUid: 0,
        linuxGid: 0,
        homePath: '/',
      },
    });
    expect(view.locale).toBe('en');
    expect(view.user.linux_identity.bound).toBe(false);
  });
});
