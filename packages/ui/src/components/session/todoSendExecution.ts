import { opencodeClient } from '@/lib/opencode/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { toastModelSwitchFailed } from '@/sync/model-gesture';

export type TodoSendExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  runAsGoal?: boolean;
  picked: { model: boolean; variant: boolean; agent: boolean };
};

const resolveExecutionForDirectory = async (
  directory: string,
  execution: TodoSendExecution,
): Promise<TodoSendExecution> => {
  const { picked } = execution;
  if (picked.model && picked.agent) return execution;
  const defaults = await useConfigStore.getState().resolveDirectoryDefaultSelection(directory);
  if (!defaults) return execution;

  const providerID = picked.model ? execution.providerID : defaults.providerId;
  const modelID = picked.model ? execution.modelID : defaults.modelId;
  const sameModel = providerID === execution.providerID && modelID === execution.modelID;
  return {
    ...execution,
    providerID,
    modelID,
    variant: picked.model || (picked.variant && sameModel) ? execution.variant : (defaults.variant ?? ''),
    agent: picked.agent ? execution.agent : (defaults.agentName ?? ''),
  };
};

export const resolveWorktreeExecution = async (
  sessionId: string,
  directory: string,
  execution: TodoSendExecution,
): Promise<TodoSendExecution | null> => {
  const resolved = await resolveExecutionForDirectory(directory, execution);
  if (resolved.providerID && resolved.modelID) {
    try {
      await opencodeClient.switchSessionModel(
        sessionId,
        { providerID: resolved.providerID, id: resolved.modelID, variant: resolved.variant || undefined },
        directory,
      );
    } catch (error) {
      console.warn('[todo-send] the worktree model switch was not applied:', error);
      toastModelSwitchFailed();
      return null;
    }
  }
  return resolved;
};
