import { createHash } from 'node:crypto';
import type { SessionRecords } from './contracts.js';

const SESSION_KEY_PREFIX = 'sha256:';

export const sessionKeyFor = (key: string) => (key.startsWith(SESSION_KEY_PREFIX)
  ? key
  : `${SESSION_KEY_PREFIX}${createHash('sha256').update(key).digest('hex')}`);

export const clientSessionKeyFor = (clientId: string) => sessionKeyFor(`client:${clientId}`);

export const withHashedSessionKeys = (bySession: SessionRecords) => {
  const hashed: SessionRecords = {};
  let changed = false;
  for (const [key, entries] of Object.entries(bySession)) {
    const hashedKey = sessionKeyFor(key);
    if (hashedKey !== key) changed = true;
    const previous = hashed[hashedKey];
    hashed[hashedKey] = Array.isArray(previous) && Array.isArray(entries)
      ? [...previous, ...entries]
      : entries;
  }
  return { bySession: hashed, changed };
};
