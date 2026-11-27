import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const SHARED_SERVICE_RESTART_COMMAND = 'opencode service restart';

const healthSchema = z.object({ opencodeBinarySource: z.string().nullish() });

export async function isConnectedToSharedOpenCodeService(signal?: AbortSignal): Promise<boolean> {
  const response = await runtimeFetch('/health', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`Failed to read server health (${response.status})`);
  return healthSchema.parse(await response.json()).opencodeBinarySource === 'shared-service';
}
