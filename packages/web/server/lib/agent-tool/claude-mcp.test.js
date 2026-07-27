import { describe, expect, it, mock } from 'bun:test';
import { createClaudeOpenChamberMcpAdapter } from './claude-mcp.js';

describe('createClaudeOpenChamberMcpAdapter', () => {
  it('builds an SDK MCP server that executes OpenChamber actions', async () => {
    const executeAction = mock(async (action, input, contextDirectory) => ({
      action,
      input,
      contextDirectory,
      projects: [{ id: 'p1' }],
    }));
    const tool = mock((_name, _description, _schema, handler) => ({ handler }));
    const createSdkMcpServer = mock(({ name, tools }) => ({
      type: 'sdk',
      name,
      tools,
      instance: {},
    }));

    const adapter = createClaudeOpenChamberMcpAdapter({
      executeAction,
      isEnabled: async () => true,
      loadSdk: async () => ({ createSdkMcpServer, tool }),
    });

    const servers = await adapter.createMcpServers({ contextDirectory: '/repo' });
    expect(servers).toBeTruthy();
    expect(servers.openchamber.name).toBe('openchamber');
    expect(tool).toHaveBeenCalled();

    const registered = tool.mock.calls[0][3];
    const result = await registered({ action: 'projects.list', parameters: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      ok: true,
      action: 'projects.list',
    });
    expect(executeAction).toHaveBeenCalledWith(
      'projects.list',
      { action: 'projects.list' },
      '/repo',
      expect.objectContaining({}),
    );
  });

  it('returns null when the agent control tool is disabled', async () => {
    const adapter = createClaudeOpenChamberMcpAdapter({
      executeAction: async () => ({}),
      isEnabled: async () => false,
      loadSdk: async () => {
        throw new Error('should not load');
      },
    });
    await expect(adapter.createMcpServers()).resolves.toBeNull();
  });
});
