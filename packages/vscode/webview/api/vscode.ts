import type { VSCodeAPI } from '@openchamber/ui/lib/api/types';
import { executeVSCodeCommand, openVSCodeExternalUrl, sendBridgeMessage } from './bridge';

export const createVSCodeActionsAPI = (): VSCodeAPI => ({
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    const result = await executeVSCodeCommand(command, args);
    return result.result;
  },

  async openAgentManager(): Promise<void> {
    await executeVSCodeCommand('openchamber.openAgentManager');
  },

  async openExternalUrl(url: string): Promise<void> {
    await openVSCodeExternalUrl(url);
  },

  async pickFiles(): Promise<unknown> {
    return sendBridgeMessage('api:files/pick');
  },

  async saveImage(payload: unknown): Promise<unknown> {
    return sendBridgeMessage('api:files/save-image', payload);
  },

  async saveMarkdown(payload: unknown): Promise<unknown> {
    return sendBridgeMessage('api:files/save-markdown', payload);
  },
});
