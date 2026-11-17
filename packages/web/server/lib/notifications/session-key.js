import { createHash } from 'node:crypto';

const SESSION_KEY_PREFIX = 'sha256:';

export const sessionKeyFor = (key) => (key.startsWith(SESSION_KEY_PREFIX)
  ? key
  : `${SESSION_KEY_PREFIX}${createHash('sha256').update(key).digest('hex')}`);

export const clientSessionKeyFor = (clientId) => sessionKeyFor(`client:${clientId}`);

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
