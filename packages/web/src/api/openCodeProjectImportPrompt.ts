import type { OpenCodeProjectImportPromptAPI } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { z } from 'zod';

const claimResponseSchema = z.object({ claimed: z.boolean() });

export const createOpenCodeProjectImportPromptAPI = (
  fetchRuntime: typeof runtimeFetch,
): OpenCodeProjectImportPromptAPI => ({
  async claim() {
    const response = await fetchRuntime('/api/openchamber/project-import-prompt/claim', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(response.statusText || 'Failed to claim the project import prompt');
    }

    const parsed = claimResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new Error('The project import prompt claim response was invalid');
    }

    return parsed.data.claimed ? 'claimed' : 'already-claimed';
  },
});

export const createWebOpenCodeProjectImportPromptAPI = (): OpenCodeProjectImportPromptAPI =>
  createOpenCodeProjectImportPromptAPI(runtimeFetch);
