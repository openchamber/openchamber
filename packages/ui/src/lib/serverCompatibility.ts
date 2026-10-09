import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';

const versionResponse = z.object({ openchamberVersion: z.string() });

/**
 * The OpenChamber version the connected server reports, over whatever
 * transport the app uses for it (direct, tunnel, relay). `null` when the
 * server does not say, which is not evidence of an old server.
 */
export const fetchConnectedServerVersion = async (
  signal: AbortSignal,
  request: typeof runtimeFetch = runtimeFetch,
): Promise<string | null> => {
  const response = await request('/api/version', {
    signal,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const parsed = versionResponse.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.openchamberVersion.trim() || null : null;
};

/**
 * A server before 2.0 runs OpenCode 1.x and answers the 2.x routes this app
 * calls with its web page. A version that does not parse says nothing.
 */
export const isServerBeforeOpenCode2 = (version: string): boolean => {
  const major = /^(\d+)\./.exec(version)?.[1];
  return major !== undefined && Number(major) < 2;
};
