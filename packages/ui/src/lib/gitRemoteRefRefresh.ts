import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const refreshRemoteRefSchema = z.object({
  updated: z.boolean(),
  oid: z.string().optional().default(''),
});

export async function refreshGitRemoteRef(
  directory: string,
  options: { ref: string; force?: boolean },
): Promise<{ updated: boolean; oid: string }> {
  if (!directory || !options.ref) {
    return { updated: false, oid: '' };
  }

  const response = await runtimeFetch('/api/git/refresh-remote-ref', {
    query: { directory },
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: options.ref, force: options.force === true }),
  });

  if (!response.ok) {
    return { updated: false, oid: '' };
  }

  return refreshRemoteRefSchema.parse(await response.json());
}
