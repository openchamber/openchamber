import { describe, expect, it, vi } from 'vitest';
import type { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

describe('createWebOpenCodeProjectImportPromptAPI', () => {
  it('returns claimed only when the active runtime grants the one-time prompt', async () => {
    const { createOpenCodeProjectImportPromptAPI } = await import('./openCodeProjectImportPrompt');
    const fetchRuntime = vi.fn<typeof runtimeFetch>().mockResolvedValue(Response.json({ claimed: true }));
    const api = createOpenCodeProjectImportPromptAPI(fetchRuntime);

    await expect(api.claim()).resolves.toBe('claimed');
    expect(fetchRuntime).toHaveBeenCalledWith('/api/openchamber/project-import-prompt/claim', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
  });

  it('reports an existing runtime marker and rejects failed or malformed responses', async () => {
    const { createOpenCodeProjectImportPromptAPI } = await import('./openCodeProjectImportPrompt');
    const fetchRuntime = vi.fn<typeof runtimeFetch>()
      .mockResolvedValueOnce(Response.json({ claimed: false }))
      .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Unavailable' }))
      .mockResolvedValueOnce(Response.json({ claimed: 'yes' }));
    const api = createOpenCodeProjectImportPromptAPI(fetchRuntime);

    await expect(api.claim()).resolves.toBe('already-claimed');
    await expect(api.claim()).rejects.toThrow('Unavailable');
    await expect(api.claim()).rejects.toThrow('response was invalid');
  });
});
