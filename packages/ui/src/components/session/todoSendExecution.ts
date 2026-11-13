import { useConfigStore } from '@/stores/useConfigStore';

export type TodoSendExecution = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  runAsGoal?: boolean;
  /** What the user chose in the dialog. The rest follows the defaults of the directory the session runs in. */
  picked: { model: boolean; variant: boolean; agent: boolean };
};

/**
 * The selection a new session in `directory` sends its first message with.
 * The dialog shows the defaults of the project it was opened for; a new
 * worktree session runs in another directory, whose own defaults apply to
 * everything the user did not pick. A picked model keeps the effort the
 * dialog chose for it. When the directory resolves no model, the dialog's
 * values stand.
 */
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
