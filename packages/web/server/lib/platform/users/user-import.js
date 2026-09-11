import { randomUUID } from 'node:crypto';
import path from 'node:path';

// User identity import: binds an OIDC identity (issuer, subject) to a host
// linux account (linux_uid, linux_gid, home_path). The mapping is admin-curated
// material (plan section 7.4): importing is idempotent per identity, and
// changing the linux binding of an existing user is a separate explicit
// operation (changeUserHome), never a silent upsert.

export function normalizeHomePath(homePath) {
  if (typeof homePath !== 'string' || homePath.trim() === '') {
    throw new Error('home_path must be a non-empty absolute path');
  }
  if (!path.isAbsolute(homePath)) {
    throw new Error(`home_path must be absolute, got relative path: ${homePath}`);
  }
  const resolved = path.resolve(homePath);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`home_path must not be the filesystem root: ${homePath}`);
  }
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

export async function importUser(db, { issuer, subject, displayName, linuxUid, linuxGid, homePath }) {
  const normalized = validateBinding({ issuer, subject, displayName, linuxUid, linuxGid, homePath });

  const byIdentity = await findUserByIdentity(db, issuer, subject);
  if (byIdentity) {
    const sameBinding =
      byIdentity.linux_uid === linuxUid &&
      byIdentity.linux_gid === linuxGid &&
      byIdentity.home_path === normalized;
    if (!sameBinding) {
      throw new Error(
        `user import conflict: identity (${issuer}, ${subject}) is already bound to ` +
        `uid=${byIdentity.linux_uid} home=${byIdentity.home_path}; ` +
        'use changeUserHome for an explicit rebind',
      );
    }
    // Idempotent re-import: ownership must not change.
    return { user: byIdentity, created: false };
  }

  await assertLinuxAccountFree(db, { linuxUid, homePath: normalized, issuer, subject });

  const id = randomUUID();
  try {
    const { rows } = await db.query(
      `INSERT INTO users (id, issuer, subject, display_name, linux_uid, linux_gid, home_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, issuer, subject, displayName, linuxUid, linuxGid, normalized],
    );
    return { user: rows[0], created: true };
  } catch (error) {
    throw toImportConflictError(error, { linuxUid, homePath: normalized, issuer, subject });
  }
}

// Explicit rebind of an existing user to a different linux account.
export async function changeUserHome(db, { userId, linuxUid, linuxGid, homePath }) {
  const normalized = validateLinuxAccount({ linuxUid, linuxGid, homePath });
  if (typeof userId !== 'string' || userId === '') {
    throw new Error('userId is required');
  }

  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) {
    throw new Error(`cannot change home: no user with id ${userId}`);
  }

  const unchanged =
    user.linux_uid === linuxUid && user.linux_gid === linuxGid && user.home_path === normalized;
  if (unchanged) {
    return { user, changed: false };
  }

  await assertLinuxAccountFree(db, { linuxUid, homePath: normalized, excludeUserId: userId });

  try {
    const { rows: updated } = await db.query(
      `UPDATE users SET linux_uid = $2, linux_gid = $3, home_path = $4 WHERE id = $1 RETURNING *`,
      [userId, linuxUid, linuxGid, normalized],
    );
    return { user: updated[0], changed: true };
  } catch (error) {
    throw toImportConflictError(error, { linuxUid, homePath: normalized });
  }
}

function validateBinding({ issuer, subject, displayName, linuxUid, linuxGid, homePath }) {
  for (const [field, value] of [['issuer', issuer], ['subject', subject], ['displayName', displayName]]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  return validateLinuxAccount({ linuxUid, linuxGid, homePath });
}

function validateLinuxAccount({ linuxUid, linuxGid, homePath }) {
  if (!Number.isInteger(linuxUid) || linuxUid <= 0) {
    throw new Error(`linux_uid must be a positive integer, got ${linuxUid} (root binding is rejected)`);
  }
  if (!Number.isInteger(linuxGid) || linuxGid <= 0) {
    throw new Error(`linux_gid must be a positive integer, got ${linuxGid} (root group binding is rejected)`);
  }
  return normalizeHomePath(homePath);
}

async function findUserByIdentity(db, issuer, subject) {
  const { rows } = await db.query('SELECT * FROM users WHERE issuer = $1 AND subject = $2', [issuer, subject]);
  return rows[0] ?? null;
}

async function assertLinuxAccountFree(db, { linuxUid, homePath, issuer, subject, excludeUserId }) {
  const { rows } = await db.query('SELECT * FROM users WHERE linux_uid = $1 AND home_path = $2', [linuxUid, homePath]);
  const owner = rows[0];
  if (owner && owner.id === excludeUserId) {
    return;
  }
  const sameIdentity = owner && owner.issuer === issuer && owner.subject === subject;
  if (owner && !sameIdentity) {
    // An exact identity match cannot reach here: the caller already looked up
    // the identity first. Any row found belongs to a different identity.
    throw new Error(
      `user import conflict: linux account uid=${linuxUid} home=${homePath} is already bound to ` +
      `identity (${owner.issuer}, ${owner.subject})`,
    );
  }
}

function toImportConflictError(error, { linuxUid, homePath }) {
  if (error && error.code === '23505') {
    return new Error(
      `user import conflict: the database rejected a unique constraint for uid=${linuxUid} home=${homePath}: ${error.message}`,
    );
  }
  return error;
}
