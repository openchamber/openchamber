import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const disabledProvidersSchema = z.object({ providers: z.array(z.string()) });
const errorSchema = z.object({ error: z.string().min(1) });

/**
 * Providers turned off in the user's OpenCode config (`disabled_providers`).
 * OpenCode leaves them out of its provider list entirely, so this is the only
 * way Settings can show them again. Null where the runtime has no OpenChamber
 * server to ask (VS Code): the feature is not offered there.
 */
export const fetchDisabledProviders = async (): Promise<string[] | null> => {
  const response = await runtimeFetch('/api/provider/disabled');
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read disabled providers (${response.status})`);
  return disabledProvidersSchema.parse(await response.json()).providers;
};

/** Turns a provider off or back on; answers with the new list. */
export const setProviderDisabled = async (providerId: string, disabled: boolean): Promise<string[]> => {
  const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/disabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Could not update the provider (${response.status})`);
  }
  return disabledProvidersSchema.parse(payload).providers;
};
