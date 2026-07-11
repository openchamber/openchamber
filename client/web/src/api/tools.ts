import type { ToolsAPI } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

export const createWebToolsAPI = (): ToolsAPI => ({
  async getAvailableTools(): Promise<string[]> {

    const response = await runtimeFetch('/api/experimental/tool/ids');

    if (!response.ok) {
      throw new Error(`Tools API returned ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error('Tools API returned invalid data format');
    }

    return data
      .filter((tool: unknown): tool is string => typeof tool === 'string' && tool !== 'invalid')
      .sort();
  },
});
