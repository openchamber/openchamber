import path from 'node:path';
import { isRecord, isString } from '../shared/guards.js';

const spaceRoots = ['/spaces', '/var/lib/openchamber-spaces', '/var/lib/private/openchamber-spaces', '/var/lib/openchamber-hostd/spaces'];
const directoryFields = new Set(['directory', 'worktree', 'projectDirectory']);
const sessionFields = new Set(['id', 'sessionId', 'sessionID']);

/** Every directory/session identity the UI or owner observers can consume. */
export function isAgentPayloadAllowed(payload, isSpaceSession = () => false) {
  const pending = [{ value: payload, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (depth > 64) return false;
    if (!isRecord(value) && !Array.isArray(value)) continue;
    for (const [key, entry] of Object.entries(value)) {
      // Session dictionaries (permission modes, statuses) use ids as keys.
      if (isSpaceSession(key)) return false;
      if (isString(entry)) {
        if (sessionFields.has(key) && isSpaceSession(entry)) return false;
        if (directoryFields.has(key)) {
          const normalized = path.posix.normalize(entry.replaceAll('\\', '/')).toLowerCase();
          if (spaceRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))) return false;
        }
      } else if (isRecord(entry) || Array.isArray(entry)) pending.push({ value: entry, depth: depth + 1 });
    }
  }
  return true;
}
