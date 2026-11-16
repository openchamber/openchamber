import { isPlainObject, isString } from '../shared/guards.js';
import { parseGiteaVersion } from './verify.js';

const LOCK_VERSION = Object.freeze([1, 24]);
const GITEA_SUFFIX = /\+gitea-(\d+)\.(\d+)/;
const versions = new Map();

export const readInstanceVersion = (client, origin) => {
  const cached = versions.get(origin);
  if (cached) return cached;
  const pending = client.get('/version').then(
    (payload) => (isPlainObject(payload) && isString(payload.version) ? payload.version : null),
  );
  versions.set(origin, pending);
  pending.catch(() => versions.delete(origin));
  return pending.catch(() => null);
};

export const lockCapability = (version, provider) => {
  if (!isString(version)) return null;
  if (provider === 'forgejo' && !GITEA_SUFFIX.test(version)) return false;
  const parsed = parseGiteaVersion(version);
  if (parsed === null) return null;
  return parsed[0] > LOCK_VERSION[0] || (parsed[0] === LOCK_VERSION[0] && parsed[1] >= LOCK_VERSION[1]);
};
export const instanceCapabilities = (client, origin, provider) => async () => ({
  lock: lockCapability(await readInstanceVersion(client, origin), provider),
});
