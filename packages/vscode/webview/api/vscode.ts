import type { VSCodeAPI } from '@openchamber/ui/lib/api/types';
import { executeVSCodeCommand, openVSCodeExternalUrl, sendBridgeMessage, sendBridgeMessageWithOptions } from './bridge';

export const createVSCodeActionsAPI = (): VSCodeAPI => ({
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    const result = await executeVSCodeCommand(command, args);
    return result.result;
  },

  async openExternalUrl(url: string): Promise<void> {
    await openVSCodeExternalUrl(url);
  },

  async addWorkspaceFolder(path: string): Promise<Array<{ name: string; path: string }>> {
    const result = await sendBridgeMessage<{ workspaceFolders: Array<{ name: string; path: string }> }>(
      'api:workspace:addFolder',
      { path },
    );
    return Array.isArray(result?.workspaceFolders) ? result.workspaceFolders : [];
  },

  async pickFiles(options): Promise<unknown> {
    return sendBridgeMessageWithOptions('api:files/pick', options, { timeoutMs: 0 });
  },

  async saveImage(payload: unknown): Promise<unknown> {
    return sendBridgeMessageWithOptions('api:files/save-image', payload, { timeoutMs: 0 });
  },

  async saveMarkdown(payload: unknown): Promise<unknown> {
    return sendBridgeMessageWithOptions('api:files/save-markdown', payload, { timeoutMs: 0 });
  },
});
