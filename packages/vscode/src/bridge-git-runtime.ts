import * as gitService from './gitService';
import type { BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

const requireDirectory = (id: string, type: string, directory?: string): BridgeResponse | null => {
  if (!directory) {
    return { id, type, success: false, error: 'Directory is required' };
  }
  return null;
};

export async function handleStandardGitBridgeMessage(message: BridgeMessageInput): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:git/check': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const isRepo = await gitService.checkIsGitRepository(directory!);
      return { id, type, success: true, data: isRepo };
    }

    case 'api:git/worktree-type': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const isLinked = await gitService.isLinkedWorktree(directory!);
      return { id, type, success: true, data: isLinked };
    }

    case 'api:git/status': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const status = await gitService.getGitStatus(directory!);
      return { id, type, success: true, data: status };
    }

    case 'api:git/branches': {
      const { directory, method, name, startPoint, force } = (payload || {}) as {
        directory?: string;
        method?: string;
        name?: string;
        startPoint?: string;
        force?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        const branches = await gitService.getGitBranches(directory!);
        return { id, type, success: true, data: branches };
      }

      if (normalizedMethod === 'POST') {
        if (!name) {
          return { id, type, success: false, error: 'Branch name is required' };
        }
        const result = await gitService.createBranch(directory!, name, startPoint);
        return { id, type, success: true, data: result };
      }

      if (normalizedMethod === 'DELETE') {
        if (!name) {
          return { id, type, success: false, error: 'Branch name is required' };
        }
        const result = await gitService.deleteGitBranch(directory!, name, force);
        return { id, type, success: true, data: result };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:git/remote-branches': {
      const { directory, branch, remote } = (payload || {}) as {
        directory?: string;
        branch?: string;
        remote?: string;
      };
      if (!directory || !branch) {
        return { id, type, success: false, error: 'Directory and branch are required' };
      }
      const result = await gitService.deleteRemoteBranch(directory, branch, remote);
      return { id, type, success: true, data: result };
    }

    case 'api:git/checkout': {
      const { directory, branch } = (payload || {}) as { directory?: string; branch?: string };
      if (!directory || !branch) {
        return { id, type, success: false, error: 'Directory and branch are required' };
      }
      const result = await gitService.checkoutBranch(directory, branch);
      return { id, type, success: true, data: result };
    }

    case 'api:git/worktrees': {
      const { directory, method } = (payload || {}) as {
        directory?: string;
        method?: string;
        body?: unknown;
        directoryPath?: string;
        deleteLocalBranch?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        const worktrees = await gitService.listGitWorktrees(directory!);
        return { id, type, success: true, data: worktrees };
      }

      if (normalizedMethod === 'POST') {
        const created = await gitService.createWorktree(directory!, (payload || {}) as gitService.CreateGitWorktreePayload);
        return { id, type, success: true, data: created };
      }

      if (normalizedMethod === 'DELETE') {
        const removePayload = payload as {
          body?: { directory?: string; deleteLocalBranch?: boolean };
          directory?: string;
          deleteLocalBranch?: boolean;
        };
        const bodyDirectory = typeof removePayload?.body?.directory === 'string'
          ? removePayload.body.directory
          : '';
        const legacyDirectory = typeof removePayload?.directory === 'string' ? removePayload.directory : '';
        const worktreeDirectory = bodyDirectory || legacyDirectory || '';

        if (!worktreeDirectory) {
          return { id, type, success: false, error: 'Worktree directory is required' };
        }
        const removed = await gitService.removeWorktree(directory!, {
          directory: worktreeDirectory,
          deleteLocalBranch: removePayload?.body?.deleteLocalBranch === true || removePayload?.deleteLocalBranch === true,
        });
        return { id, type, success: true, data: { success: Boolean(removed) } };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:git/worktrees/validate': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.validateWorktreeCreate(directory!, (payload || {}) as gitService.CreateGitWorktreePayload);
      return { id, type, success: true, data: result };
    }

    case 'api:git/worktrees/bootstrap-status': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.getWorktreeBootstrapStatus(directory!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/worktrees/preview': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.previewWorktreeCreate(directory!, (payload || {}) as gitService.CreateGitWorktreePayload);
      return { id, type, success: true, data: result };
    }

    case 'api:git/validate-directory': {
      const { directory, worktreeRoot } = (payload || {}) as { directory?: string; worktreeRoot?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.validateWorktreeDirectory(directory!, worktreeRoot!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/canonicalize-worktree-state': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.canonicalizeWorktreeState(directory!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/diff': {
      const { directory, path: filePath, staged, contextLines } = (payload || {}) as {
        directory?: string;
        path?: string;
        staged?: boolean;
        contextLines?: number;
      };
      if (!directory || !filePath) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      const result = await gitService.getGitDiff(directory, filePath, staged, contextLines);
      return { id, type, success: true, data: result };
    }

    case 'api:git/file-diff': {
      const { directory, path: filePath, staged } = (payload || {}) as {
        directory?: string;
        path?: string;
        staged?: boolean;
      };
      if (!directory || !filePath) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      const result = await gitService.getGitFileDiff(directory, filePath, staged);
      return { id, type, success: true, data: result };
    }

    case 'api:git/revert': {
      const { directory, path: filePath } = (payload || {}) as { directory?: string; path?: string };
      if (!directory || !filePath) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      await gitService.revertGitFile(directory, filePath);
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:git/commit': {
      const { directory, message, addAll, files } = (payload || {}) as {
        directory?: string;
        message?: string;
        addAll?: boolean;
        files?: string[];
      };
      if (!directory || !message) {
        return { id, type, success: false, error: 'Directory and message are required' };
      }
      const result = await gitService.createGitCommit(directory, message, { addAll, files });
      return { id, type, success: true, data: result };
    }

    case 'api:git/push': {
      const { directory, remote, branch, options } = (payload || {}) as {
        directory?: string;
        remote?: string;
        branch?: string;
        options?: string[] | Record<string, unknown>;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.gitPush(directory!, { remote, branch, options });
      return { id, type, success: true, data: result };
    }

    case 'api:git/pull': {
      const { directory, remote, branch, rebase } = (payload || {}) as {
        directory?: string;
        remote?: string;
        branch?: string;
        rebase?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.gitPull(directory!, { remote, branch, rebase });
      return { id, type, success: true, data: result };
    }

    case 'api:git/fetch': {
      const { directory, remote, branch } = (payload || {}) as {
        directory?: string;
        remote?: string;
        branch?: string;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.gitFetch(directory!, { remote, branch });
      return { id, type, success: true, data: result };
    }

    case 'api:git/stashes': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      return { id, type, success: true, data: { stashes: await gitService.listGitStashes(directory!) } };
    }

    case 'api:git/stashes/file-counts': {
      const { directory, refs } = (payload || {}) as { directory?: string; refs?: string[] };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      return { id, type, success: true, data: { counts: await gitService.countGitStashFiles(directory!, refs ?? []) } };
    }

    case 'api:git/stash': {
      const { directory, message } = (payload || {}) as { directory?: string; message?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      return { id, type, success: true, data: await gitService.stashGitChanges(directory!, { message }) };
    }

    case 'api:git/stash/apply':
    case 'api:git/stash/pop':
    case 'api:git/stash/drop': {
      const { directory, ref } = (payload || {}) as { directory?: string; ref?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const stashRef = ref || 'stash@{0}';
      const data = type === 'api:git/stash/apply'
        ? await gitService.applyGitStash(directory!, { ref: stashRef })
        : type === 'api:git/stash/pop'
          ? await gitService.popGitStash(directory!, { ref: stashRef })
          : await gitService.dropGitStash(directory!, { ref: stashRef });
      return { id, type, success: true, data };
    }

    case 'api:git/remotes': {
      const { directory, method, remote } = (payload || {}) as {
        directory?: string;
        method?: string;
        remote?: string;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';
      if (normalizedMethod === 'GET') {
        const result = await gitService.getRemotes(directory!);
        return { id, type, success: true, data: result };
      }

      if (normalizedMethod === 'DELETE') {
        if (!remote) {
          return { id, type, success: false, error: 'Remote name is required' };
        }
        const result = await gitService.removeRemote(directory!, remote);
        return { id, type, success: true, data: result };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:git/rebase': {
      const { directory, onto } = (payload || {}) as { directory?: string; onto?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!onto) {
        return { id, type, success: false, error: 'onto is required' };
      }
      const result = await gitService.rebase(directory!, { onto });
      return { id, type, success: true, data: result };
    }

    case 'api:git/rebase/abort': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.abortRebase(directory!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/merge': {
      const { directory, branch } = (payload || {}) as { directory?: string; branch?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!branch) {
        return { id, type, success: false, error: 'branch is required' };
      }
      const result = await gitService.merge(directory!, { branch });
      return { id, type, success: true, data: result };
    }

    case 'api:git/merge/abort': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.abortMerge(directory!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/rebase/continue': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.continueRebase(directory!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/merge/continue': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.continueMerge(directory!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/log': {
      const { directory, maxCount, from, to, file } = (payload || {}) as {
        directory?: string;
        maxCount?: number;
        from?: string;
        to?: string;
        file?: string;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.getGitLog(directory!, { maxCount, from, to, file });
      return { id, type, success: true, data: result };
    }

    case 'api:git/commit-files': {
      const { directory, hash } = (payload || {}) as { directory?: string; hash?: string };
      if (!directory || !hash) {
        return { id, type, success: false, error: 'Directory and hash are required' };
      }
      const result = await gitService.getCommitFiles(directory, hash);
      return { id, type, success: true, data: result };
    }

    case 'api:git/identity': {
      const { directory, method, userName, userEmail, sshKey } = (payload || {}) as {
        directory?: string;
        method?: string;
        userName?: string;
        userEmail?: string;
        sshKey?: string | null;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        const identity = await gitService.getCurrentGitIdentity(directory!);
        return { id, type, success: true, data: identity };
      }

      if (normalizedMethod === 'POST') {
        if (!userName || !userEmail) {
          return { id, type, success: false, error: 'userName and userEmail are required' };
        }
        const result = await gitService.setGitIdentity(directory!, userName, userEmail, sshKey);
        return { id, type, success: true, data: result };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:git/ignore-openchamber': {
      return { id, type, success: true, data: { success: true } };
    }

    default:
      return null;
  }
}
