import { z } from 'zod';
import type { SessionDirectoryOptions, SessionDirectoryResolver } from './contracts.js';

const SESSION_DIRECTORY_CACHE_MS = 60 * 1000;
const SESSION_DIRECTORY_CACHE_LIMIT = 500;
const SESSION_LOOKUP_TIMEOUT_MS = 15 * 1000;

const sessionRecordSchema = z.object({ location: z.object({ directory: z.string() }) });
const sessionResponseSchema = z.union([
  z.object({ data: sessionRecordSchema }).transform((payload) => payload.data.location.directory),
  sessionRecordSchema.transform((record) => record.location.directory),
]);

export const createSessionDirectoryResolver = ({ fetchImpl, buildOpenCodeUrl, getOpenCodeAuthHeaders, now = Date.now }: SessionDirectoryOptions): SessionDirectoryResolver => {
  const cache = new Map<string, { at: number; directory: string }>();
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
    if (cache.size > SESSION_DIRECTORY_CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return directory;
  };
};
