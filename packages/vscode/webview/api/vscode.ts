import type { VSCodeAPI } from '@alias-ade/ui/lib/api/types';
import { executeVSCodeCommand, openVSCodeExternalUrl } from './bridge';

export const createVSCodeActionsAPI = (): VSCodeAPI => ({
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    const result = await executeVSCodeCommand(command, args);
    return result.result;
  },

  async openAgentManager(): Promise<void> {
    await executeVSCodeCommand('aliasAde.openAgentManager');
  },

  async openExternalUrl(url: string): Promise<void> {
    await openVSCodeExternalUrl(url);
  },
});
