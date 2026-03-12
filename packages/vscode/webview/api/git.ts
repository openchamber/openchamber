/**
 * VS Code Git API implementation
 * Uses bridge messages to communicate with the extension host
 */

import { sendBridgeMessage } from './bridge';
import type {
  GitAPI,
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GitFileDiffResponse,
  GetGitFileDiffOptions,
  GitBranch,
  GitDeleteBranchPayload,
  GitDeleteRemoteBranchPayload,
  GeneratedCommitMessage,
  GeneratedPullRequestDescription,
  GitWorktreeInfo,
  CreateGitWorktreePayload,
  GitWorktreeValidationResult,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitCommitResult,
  CreateGitCommitOptions,
  GitPushResult,
  GitPullResult,
  GitLogResponse,
  GitLogOptions,
  GitCommitFilesResponse,
  GitIdentitySummary,
  GitIdentityProfile,
  GitRemote,
  GitRebaseResult,
  GitMergeResult,
} from '@openchamber/ui/lib/api/types';

export const createVSCodeGitAPI = (): GitAPI => ({
  checkIsGitRepository: async (directory: string): Promise<boolean> => {
    return sendBridgeMessage<boolean>('api:git/check', { directory });
  },

  getGitStatus: async (directory: string): Promise<GitStatus> => {
    return sendBridgeMessage<GitStatus>('api:git/status', { directory });
  },

  getGitDiff: async (directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse> => {
    return sendBridgeMessage<GitDiffResponse>('api:git/diff', {
      directory,
      path: options.path,
      staged: options.staged,
      contextLines: options.contextLines,
    });
  },

  getGitFileDiff: async (directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse> => {
    return sendBridgeMessage<GitFileDiffResponse>('api:git/file-diff', {
      directory,
      path: options.path,
      staged: options.staged,
    });
  },

  revertGitFile: async (directory: string, filePath: string): Promise<void> => {
    await sendBridgeMessage('api:git/revert', { directory, path: filePath });
  },

  isLinkedWorktree: async (directory: string): Promise<boolean> => {
    return sendBridgeMessage<boolean>('api:git/worktree-type', { directory });
  },

  getGitBranches: async (directory: string): Promise<GitBranch> => {
    return sendBridgeMessage<GitBranch>('api:git/branches', { directory, method: 'GET' });
  },

  deleteGitBranch: async (directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/branches', {
      directory,
      method: 'DELETE',
      name: payload.branch,
      force: payload.force,
    });
  },

  deleteRemoteBranch: async (directory: string, payload: GitDeleteRemoteBranchPayload): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/remote-branches', {
      directory,
      branch: payload.branch,
      remote: payload.remote,
    });
  },

  generateCommitMessage: async (
    directory: string,
    files: string[],
    options?: { zenModel?: string; providerId?: string; modelId?: string }
  ): Promise<{ message: GeneratedCommitMessage }> => {
    // This requires AI integration - stubbed for now
    void directory; // Unused for now
    void files; // Unused for now
    void options; // Unused for now
    return {
      message: {
        subject: '',
        highlights: [],
      },
    };
  },

  generatePullRequestDescription: async (
    directory: string,
    payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
  ): Promise<GeneratedPullRequestDescription> => {
    return sendBridgeMessage<GeneratedPullRequestDescription>('api:git/pr-description', {
      directory,
      base: payload.base,
      head: payload.head,
      context: payload.context,
      zenModel: payload.zenModel,
      providerId: payload.providerId,
      modelId: payload.modelId,
    });
  },

  listGitWorktrees: async (directory: string): Promise<GitWorktreeInfo[]> => {
    return sendBridgeMessage<GitWorktreeInfo[]>('api:git/worktrees', { directory, method: 'GET' });
  },

  validateGitWorktree: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> => {
    return sendBridgeMessage<GitWorktreeValidationResult>('api:git/worktrees/validate', {
      directory,
      ...(payload || {}),
    });
  },

  createGitWorktree: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
    return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees', {
      directory,
      method: 'POST',
      ...(payload || {}),
    });
  },

  deleteGitWorktree: async (directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/worktrees', {
      directory,
      method: 'DELETE',
      body: {
        directory: payload.directory,
        deleteLocalBranch: payload.deleteLocalBranch === true,
      },
    });
  },

  createGitCommit: async (directory: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult> => {
    return sendBridgeMessage<GitCommitResult>('api:git/commit', {
      directory,
      message,
      addAll: options?.addAll,
      files: options?.files,
    });
  },

  gitPush: async (directory: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult> => {
    return sendBridgeMessage<GitPushResult>('api:git/push', {
      directory,
      remote: options?.remote,
      branch: options?.branch,
      options: options?.options,
    });
  },

  gitPull: async (directory: string, options?: { remote?: string; branch?: string }): Promise<GitPullResult> => {
    return sendBridgeMessage<GitPullResult>('api:git/pull', {
      directory,
      remote: options?.remote,
      branch: options?.branch,
    });
  },

  gitFetch: async (directory: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/fetch', {
      directory,
      remote: options?.remote,
      branch: options?.branch,
    });
  },

  checkoutBranch: async (directory: string, branch: string): Promise<{ success: boolean; branch: string }> => {
    return sendBridgeMessage<{ success: boolean; branch: string }>('api:git/checkout', {
      directory,
      branch,
    });
  },

  createBranch: async (directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }> => {
    return sendBridgeMessage<{ success: boolean; branch: string }>('api:git/branches', {
      directory,
      method: 'POST',
      name,
      startPoint,
    });
  },

  renameBranch: async (directory: string, oldName: string, newName: string): Promise<{ success: boolean; branch: string }> => {
    return sendBridgeMessage<{ success: boolean; branch: string }>('api:git/branches/rename', {
      directory,
      method: 'PUT',
      oldName,
      newName,
    });
  },

  getGitLog: async (directory: string, options?: GitLogOptions): Promise<GitLogResponse> => {
    return sendBridgeMessage<GitLogResponse>('api:git/log', {
      directory,
      maxCount: options?.maxCount,
      from: options?.from,
      to: options?.to,
      file: options?.file,
    });
  },

  getCommitFiles: async (directory: string, hash: string): Promise<GitCommitFilesResponse> => {
    return sendBridgeMessage<GitCommitFilesResponse>('api:git/commit-files', {
      directory,
      hash,
    });
  },

  getCurrentGitIdentity: async (directory: string): Promise<GitIdentitySummary | null> => {
    return sendBridgeMessage<GitIdentitySummary | null>('api:git/identity', {
      directory,
      method: 'GET',
    });
  },

  setGitIdentity: async (directory: string, profileId: string): Promise<{ success: boolean; profile: GitIdentityProfile }> => {
    // For VS Code, we need to resolve the profile from the store
    // This is a simplified implementation - the full implementation would need profile lookup
    return {
      success: false,
      profile: { id: profileId, name: '', userName: '', userEmail: '' },
    };
  },

  // Git identity profile management - these are stored in extension settings
  // For simplicity, return empty arrays/objects as these are managed through the settings UI
  getGitIdentities: async (): Promise<GitIdentityProfile[]> => {
    return [];
  },

  createGitIdentity: async (profile: GitIdentityProfile): Promise<GitIdentityProfile> => {
    return profile;
  },

  updateGitIdentity: async (id: string, profile: GitIdentityProfile): Promise<GitIdentityProfile> => {
    void id; // Unused for now
    return profile;
  },

  deleteGitIdentity: async (id: string): Promise<void> => {
    void id; // Unused for now
  },

  getRemotes: async (directory: string): Promise<GitRemote[]> => {
    return sendBridgeMessage<GitRemote[]>('api:git/remotes', { directory });
  },

  rebase: async (directory: string, options: { onto: string }): Promise<GitRebaseResult> => {
    return sendBridgeMessage<GitRebaseResult>('api:git/rebase', {
      directory,
      onto: options.onto,
    });
  },

  abortRebase: async (directory: string): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/rebase/abort', { directory });
  },

  merge: async (directory: string, options: { branch: string }): Promise<GitMergeResult> => {
    return sendBridgeMessage<GitMergeResult>('api:git/merge', {
      directory,
      branch: options.branch,
    });
  },

  abortMerge: async (directory: string): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/merge/abort', { directory });
  },

  continueRebase: async (directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> => {
    return sendBridgeMessage<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>('api:git/rebase/continue', { directory });
  },

  continueMerge: async (directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> => {
    return sendBridgeMessage<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>('api:git/merge/continue', { directory });
  },

  stash: async (
    directory: string,
    options?: { message?: string; includeUntracked?: boolean }
  ): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/stash', {
      directory,
      ...options,
    });
  },

  stashPop: async (directory: string): Promise<{ success: boolean }> => {
    return sendBridgeMessage<{ success: boolean }>('api:git/stash/pop', { directory });
  },

  getConflictDetails: async (directory: string) => {
    return sendBridgeMessage<{
      statusPorcelain: string;
      unmergedFiles: string[];
      diff: string;
      headInfo: string;
      operation: 'merge' | 'rebase';
    }>('api:git/conflict-details', { directory });
  },

  worktree: {
    list: async (directory: string): Promise<GitWorktreeInfo[]> => {
      return sendBridgeMessage<GitWorktreeInfo[]>('api:git/worktrees', { directory, method: 'GET' });
    },
    validate: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> => {
      return sendBridgeMessage<GitWorktreeValidationResult>('api:git/worktrees/validate', {
        directory,
        ...(payload || {}),
      });
    },
    create: async (directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> => {
      return sendBridgeMessage<GitWorktreeCreateResult>('api:git/worktrees', {
        directory,
        method: 'POST',
        ...(payload || {}),
      });
    },
    remove: async (directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> => {
      return sendBridgeMessage<{ success: boolean }>('api:git/worktrees', {
        directory,
        method: 'DELETE',
        body: {
          directory: payload.directory,
          deleteLocalBranch: payload.deleteLocalBranch === true,
        },
      });
    },
  },
});
