import { opencodeClient } from '@/lib/opencode/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { toast } from '@/components/ui';
import { toastModelSwitchFailed } from '@/sync/model-gesture';
import { deleteSession } from '@/sync/session-actions';
import { removeProjectWorktree, type ProjectRef } from '@/lib/worktrees/worktreeManager';

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

type CreatedWorktreeSession = { id: string; directory: string; path: string; branch: string; previousDirectory: string };

const discardWorktreeSession = async (project: ProjectRef, created: CreatedWorktreeSession): Promise<void> => {
  if (!await deleteSession(created.id).catch(() => false)) {
    toast.error(`The new session (${created.id}) could not be removed. Its worktree was kept.`);
    return;
  }
  try {
    await removeProjectWorktree(
      project,
      { path: created.path, projectDirectory: project.path, branch: created.branch, label: created.branch },
      { deleteLocalBranch: true },
    );
    const directories = useDirectoryStore.getState();
    if (directories.currentDirectory === created.directory) {
      directories.setDirectory(created.previousDirectory || project.path, { showOverlay: false });
    }
  } catch (error) {
    console.warn('[todo-send] the new worktree could not be removed:', error);
    toast.error(`The new worktree (${created.path}) could not be removed.`);
  }
};

export const resolveWorktreeExecution = async (
  project: ProjectRef,
  created: CreatedWorktreeSession,
  execution: TodoSendExecution,
): Promise<TodoSendExecution | null> => {
  const resolved = await resolveExecutionForDirectory(created.directory, execution);
  if (resolved.providerID && resolved.modelID) {
    try {
      await opencodeClient.switchSessionModel(
        created.id,
        { providerID: resolved.providerID, id: resolved.modelID, variant: resolved.variant || undefined },
        created.directory,
      );
    } catch (error) {
      console.warn('[todo-send] the worktree model switch was not applied:', error);
      toastModelSwitchFailed();
      await discardWorktreeSession(project, created);
      return null;
    }
  }
  return resolved;
};
