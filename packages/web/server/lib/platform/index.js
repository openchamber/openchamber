// Platform module entry point.
//
// The platform layer is disabled unless OPENCHAMBER_PLATFORM_DATABASE_URL is
// set. When disabled, the module still imports cleanly (so the rest of the
// server is unaffected) but exposes `disabled: true` and registers nothing;
// this is the default-behavior-unchanged seam used by all later platform
// tasks. When enabled, createMigratedPlatformDb() is the single entry point
// used at deploy/startup to obtain a migrated database handle.

import { createPlatformDb } from './db/client.js';
import { migrate } from './db/migrate.js';

const connectionString = process.env.OPENCHAMBER_PLATFORM_DATABASE_URL ?? null;

export const platformState = Object.freeze({
  disabled: !connectionString,
  connectionString,
});

export function isPlatformEnabled() {
  return !platformState.disabled;
}

export { createPlatformDb } from './db/client.js';
export { migrate } from './db/migrate.js';
export { importUser, changeUserHome, normalizeHomePath } from './users/user-import.js';
export { writeAuditEvent } from './audit/audit-writer.js';

export async function createMigratedPlatformDb() {
  if (platformState.disabled) {
    throw new Error(
      'platform database is disabled: set OPENCHAMBER_PLATFORM_DATABASE_URL to enable it',
    );
  }
  const db = createPlatformDb({ connectionString: platformState.connectionString });
  await migrate(db);
  return db;
}
