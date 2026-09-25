import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const openCodeCompatibilitySchema = z.object({
  state: z.enum(['compatible', 'incompatible', 'unavailable']),
  version: z.string().nullable(),
  installation: z.enum(['managed', 'external', 'bundled']),
  // Absent from hosts that predate the minimum-version gate.
  minimumVersion: z.string().optional(),
  canInstall: z.boolean(),
});
export type OpenCodeCompatibility = z.infer<typeof openCodeCompatibilitySchema>;

export const fetchOpenCodeCompatibility = async (): Promise<OpenCodeCompatibility> => {
  const response = await runtimeFetch('/api/opencode/compatibility', { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('Could not check OpenCode compatibility');
  return openCodeCompatibilitySchema.parse(await response.json());
};

export const recoverOpenCode = async (action: 'install-v2' | 'reconnect' = 'reconnect'): Promise<{ state: 'recovered' } | { state: 'incompatible'; compatibility: OpenCodeCompatibility }> => {
  if (action === 'install-v2') {
    const response = await runtimeFetch('/api/opencode/install-v2', { method: 'POST' });
    if (!response.ok) throw new Error('OpenCode v2 installation failed');
    return { state: 'recovered' };
  }
  const compatibility = await fetchOpenCodeCompatibility();
  if (compatibility.state === 'incompatible') return { state: 'incompatible', compatibility };
  if (compatibility.state === 'unavailable') throw new Error('Could not determine OpenCode compatibility');
  const response = await runtimeFetch('/api/config/reload', { method: 'POST' });
  if (!response.ok) throw new Error('OpenCode recovery failed');
  return { state: 'recovered' };
};
