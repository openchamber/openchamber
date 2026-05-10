import type { ToolsAPI } from '@alias-ade/ui/lib/api/types';

// Use same endpoint as web - fetch interceptor handles URL rewriting
export const createVSCodeToolsAPI = (): ToolsAPI => ({
  async getAvailableTools(): Promise<string[]> {
    const response = await fetch('/api/experimental/tool/ids');

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
