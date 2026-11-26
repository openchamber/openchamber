import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { speechServerOrigin } from '@/lib/voiceKeysApi';

const keyProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  keyId: z.string(),
  matches: z.boolean(),
  approved: z.boolean(),
});

const answerSchema = z.object({ providers: z.array(keyProviderSchema) });

export type KeyProvider = z.infer<typeof keyProviderSchema>;

const approvalSchema = z.object({ approval: z.enum(['added', 'kept', 'refused']) });

export const fetchKeyProviders = async (baseURL: string, signal: AbortSignal): Promise<KeyProvider[] | null> => {
  const response = await runtimeFetch('/api/voice/key-providers', {
    query: { baseURL: speechServerOrigin(baseURL) },
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) return null;
  const answer = answerSchema.safeParse(await response.json());
  return answer.success ? answer.data.providers : null;
};

type KeyApproval = z.infer<typeof approvalSchema>['approval'] | 'failed';

export const approveKeyProvider = async (baseURL: string, provider: KeyProvider): Promise<KeyApproval> => {
  try {
    const response = await runtimeFetch('/api/tts/voices/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ baseURL, keyId: provider.keyId, keyProvider: provider.id }),
    });
    const answer = approvalSchema.safeParse(await response.json());
    return answer.success ? answer.data.approval : 'failed';
  } catch {
    return 'failed';
  }
};

export const originOf = (address: string) => {
  try {
    return new URL(address).origin;
  } catch {
    return null;
  }
};

const staleListeners = new Set<(grantedOrigin: string | null) => void>();

export const subscribeKeyProvidersStale = (listener: (grantedOrigin: string | null) => void) => {
  staleListeners.add(listener);
  return () => { staleListeners.delete(listener); };
};

export const markKeyProvidersStale = (grantedOrigin: string | null = null) => {
  for (const listener of staleListeners) listener(grantedOrigin);
};

export const autoSelectedKeyProvider = (providers: readonly KeyProvider[]): KeyProvider | null => {
  const matching = providers.filter((provider) => provider.matches);
  return matching.length === 1 ? (matching[0] ?? null) : null;
};

export const withoutAddress = (providers: readonly KeyProvider[]): KeyProvider[] =>
  providers.map((provider) => ({ ...provider, matches: false, approved: false }));
