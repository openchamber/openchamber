import crypto from 'node:crypto';

// A rail panel stays open for hours and may load a lazy chunk or one of its
// own files long after it mounted, so a grant lives while the panel keeps
// using it and lapses after a long idle stretch. What it opens is one
// installed extension's own package files, which that extension's page
// already holds.
const FRAME_GRANT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
const FRAME_GRANT_MAX_ENTRIES = 512;
const FRAME_GRANT_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/**
 * Grants for extension frames. A frame loads its package from
 * `/api/guest-files/<grant>/…`: the grant names one extension and is the only
 * credential that path takes, so relative URLs (scripts, module imports,
 * `fetch('./data.json')`, CSS `url()`) keep it without anything appended, and
 * a sign-in proxy can leave that prefix alone without opening anything else.
 */
export const createGuestFrameGrants = ({ now = () => Date.now(), randomGrant = () => crypto.randomBytes(24).toString('base64url') } = {}) => {
  const grants = new Map();

  const prune = () => {
    const at = now();
    for (const [grant, entry] of grants.entries()) {
      if (entry.expiresAt <= at) grants.delete(grant);
    }
    while (grants.size >= FRAME_GRANT_MAX_ENTRIES) {
      grants.delete(grants.keys().next().value);
    }
  };

  return {
    mint: (guestId) => {
      prune();
      const grant = randomGrant();
      const expiresAt = now() + FRAME_GRANT_IDLE_TTL_MS;
      grants.set(grant, { guestId, expiresAt });
      return { grant, expiresAt };
    },
    /** The extension a grant opens, extending its life, or null. */
    use: (grant) => {
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
