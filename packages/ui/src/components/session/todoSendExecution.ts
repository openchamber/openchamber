import { useConfigStore } from '@/stores/useConfigStore';

export type TodoSendExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  runAsGoal?: boolean;
  picked: { model: boolean; variant: boolean; agent: boolean };
};

export const resolveExecutionForDirectory = async (
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
