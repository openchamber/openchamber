import { createHash } from 'node:crypto';

// Push stores group device registrations by the UI session that made them.
// The key is a hash of that session's token: the token is a credential and
// must not sit in a file that outlives it. Nothing looks a session up by key,
// so the hash only has to be stable.
const SESSION_KEY_PREFIX = 'sha256:';

export const sessionKeyFor = (key) => (key.startsWith(SESSION_KEY_PREFIX)
  ? key
  : `${SESSION_KEY_PREFIX}${createHash('sha256').update(key).digest('hex')}`);

/**
 * Files written before the hashing keyed entries by the raw token. Returns the
 * same record under hashed keys and whether anything had to change.
 */
export const withHashedSessionKeys = (bySession) => {
  const hashed = {};
  let changed = false;
  for (const [key, entries] of Object.entries(bySession)) {
    const hashedKey = sessionKeyFor(key);
    if (hashedKey !== key) changed = true;
    hashed[hashedKey] = Array.isArray(hashed[hashedKey]) && Array.isArray(entries)
      ? [...hashed[hashedKey], ...entries]
      : entries;
  }
  return { bySession: hashed, changed };
};
