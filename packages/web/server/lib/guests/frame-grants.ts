import crypto from 'node:crypto';

const FRAME_GRANT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
const FRAME_GRANT_MAX_ENTRIES = 512;
const FRAME_GRANT_PATTERN = /^[A-Za-z0-9_-]{32}$/;

type FrameGrantOptions = { now?: () => number; randomGrant?: () => string };

export const createGuestFrameGrants = ({ now = () => Date.now(), randomGrant = () => crypto.randomBytes(24).toString('base64url') }: FrameGrantOptions = {}) => {
  const grants = new Map<string, { guestId: string; expiresAt: number }>();

  const prune = () => {
    const at = now();
    for (const [grant, entry] of grants.entries()) {
      if (entry.expiresAt <= at) grants.delete(grant);
    }
    while (grants.size >= FRAME_GRANT_MAX_ENTRIES) {
      for (const grant of grants.keys()) {
        grants.delete(grant);
        break;
      }
    }
  };

  return {
    mint: (guestId: string) => {
      prune();
      const grant = randomGrant();
      const expiresAt = now() + FRAME_GRANT_IDLE_TTL_MS;
      grants.set(grant, { guestId, expiresAt });
      return { grant, expiresAt };
    },
    use: (grant: string) => {
      if (!FRAME_GRANT_PATTERN.test(grant)) return null;
      const entry = grants.get(grant);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        grants.delete(grant);
        return null;
      }
      entry.expiresAt = now() + FRAME_GRANT_IDLE_TTL_MS;
      return entry.guestId;
    },
  };
};
