import type { ToolsAPI } from '@openchamber/ui/lib/api/types';
import { opencodeClient } from '@openchamber/ui/lib/opencode/client';

export const createVSCodeToolsAPI = (): ToolsAPI => ({
  async getAvailableTools(): Promise<string[]> {
    const data = await opencodeClient.listToolIds();
    if (!Array.isArray(data)) {
      throw new Error('Tools API returned invalid data format');
    }

    return data
      .filter((tool: unknown): tool is string => typeof tool === 'string' && tool !== 'invalid')
      .sort();
  },
});
