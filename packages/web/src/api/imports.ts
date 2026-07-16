import type { CodexImportPreview, CodexImportResult, ImportsAPI } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const readJson = async <T,>(response: Response): Promise<T | null> => {
  return await response.json().catch(() => null) as T | null;
};

export const createWebImportsAPI = (): ImportsAPI => ({
  async inspectCodex(): Promise<CodexImportPreview> {
    const response = await runtimeFetch('/api/import/codex/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await readJson<CodexImportPreview & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to inspect Codex data');
    }
    return payload;
  },

  async applyCodex(input): Promise<CodexImportResult> {
    const response = await runtimeFetch('/api/import/codex/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await readJson<CodexImportResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to import Codex data');
    }
    return payload;
  },
});
