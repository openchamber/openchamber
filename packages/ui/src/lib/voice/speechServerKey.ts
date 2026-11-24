import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

const keyIds = new Map<string, string>();

export const rememberSpeechServerKeyId = (runtimeKey: string, keyId: string | undefined): void => {
  if (keyId !== undefined) keyIds.set(runtimeKey, keyId);
};

const answerSchema = z.object({ approval: z.enum(['added', 'kept', 'refused']) });

export const approveSpeechServer = async (baseURL: string): Promise<boolean> => {
  const keyId = keyIds.get(getRuntimeKey());
  if (keyId === undefined) return false;
  try {
    const response = await runtimeFetch('/api/tts/voices/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ baseURL, keyId }),
    });
    const answer = answerSchema.safeParse(await response.json());
    return answer.success && answer.data.approval !== 'kept';
  } catch {
    return false;
  }
};
