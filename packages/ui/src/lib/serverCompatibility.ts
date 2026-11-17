import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';

const versionResponse = z.object({ openchamberVersion: z.string() });

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

export const isServerBeforeOpenCode2 = (version: string): boolean => {
  const major = /^(\d+)\./.exec(version)?.[1];
  return major !== undefined && Number(major) < 2;
};
