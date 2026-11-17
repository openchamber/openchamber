import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const ObjectiveResponseSchema = z.object({ content: z.string() });


const objectiveUrl = (sessionId: string): string =>
  `/api/goals/objective/${encodeURIComponent(sessionId)}`;

export async function writeGoalObjectiveFile(sessionId: string, content: string): Promise<boolean> {
  try {
    const response = await runtimeFetch(objectiveUrl(sessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function deleteGoalObjectiveFile(sessionId: string): void {
  void runtimeFetch(objectiveUrl(sessionId), { method: 'DELETE' }).catch(() => undefined);
}

export async function fetchGoalObjectiveContent(sessionId: string): Promise<string | null> {
  try {
    const response = await runtimeFetch(objectiveUrl(sessionId));
    if (!response.ok) return null;
    const parsed = ObjectiveResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.content : null;
  } catch {
    return null;
  }
}
