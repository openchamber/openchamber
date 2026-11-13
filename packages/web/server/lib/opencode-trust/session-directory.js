import { z } from 'zod';

// A session's folder rarely changes (a move), so a short cache spares the
// lookup on every prompt.
const SESSION_DIRECTORY_CACHE_MS = 60 * 1000;
const SESSION_DIRECTORY_CACHE_LIMIT = 500;
const SESSION_LOOKUP_TIMEOUT_MS = 15 * 1000;

const sessionRecordSchema = z.object({ location: z.object({ directory: z.string() }) });
const sessionResponseSchema = z.union([
  z.object({ data: sessionRecordSchema }).transform((payload) => payload.data.location.directory),
  sessionRecordSchema.transform((record) => record.location.directory),
]);

/**
 * The folder a session runs in, read from OpenCode's global session route,
 * which starts no location. Null for a session OpenCode does not know;
 * throws when OpenCode cannot answer. `fresh` skips the cache, for a check
 * that resolves another folder against this one (a relative move).
 */
export const createSessionDirectoryResolver = ({ fetchImpl, buildOpenCodeUrl, getOpenCodeAuthHeaders, now = Date.now }) => {
  const cache = new Map();
  return async (sessionID, { fresh = false } = {}) => {
    const cached = cache.get(sessionID);
    if (!fresh && cached && now() - cached.at < SESSION_DIRECTORY_CACHE_MS) return cached.directory;
    const response = await fetchImpl(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionID)}`, ''), {
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(SESSION_LOOKUP_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Session lookup answered ${response.status}`);
    const directory = sessionResponseSchema.parse(await response.json());
    cache.delete(sessionID);
    cache.set(sessionID, { at: now(), directory });
    if (cache.size > SESSION_DIRECTORY_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return directory;
  };
};
