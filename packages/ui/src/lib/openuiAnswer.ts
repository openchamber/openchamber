import { z } from 'zod';
import type { JsonValue } from './opencode/model';
import { runtimeFetch } from './runtime-fetch';

type OpenUIAnswer = {
  sessionId: string;
  callId: string;
  summary: string;
  data: JsonValue;
  sourceRevision: string;
};

export const answerOpenUI = async (answer: OpenUIAnswer, directory: string): Promise<void> => {
  const response = await runtimeFetch('/api/openchamber/openui/answer', {
    method: 'POST',
    directory,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(answer),
  });
  if (response.ok) return;
  const payload = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
  const message = payload.success ? payload.data.error : `Could not deliver the answer (${response.status})`;
  throw new Error(message);
};
