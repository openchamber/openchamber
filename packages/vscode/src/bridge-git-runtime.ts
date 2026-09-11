import * as gitService from './gitService';
import type { BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type BridgePayloadRecord = Record<string, unknown>;

const requireDirectory = (id: string, type: string, directory?: string): BridgeResponse | null => {
  if (!directory) {
    return { id, type, success: false, error: 'Directory is required' };
  }
  return null;
};

const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

const isValidCommitHash = (hash: string | undefined): hash is string => (
  typeof hash === 'string' && /^[0-9a-fA-F]{7,64}$/.test(hash)
);

const isFullGitObjectId = (hash: string | undefined): hash is string => (
  typeof hash === 'string' && FULL_GIT_OBJECT_ID_PATTERN.test(hash)
);

const isOptionLikeGitName = (value: string | undefined): value is string => (
  typeof value === 'string' && (value.startsWith('-') || value.includes('\0'))
);

const asRecord = (payload: unknown): BridgePayloadRecord => (
  payload && typeof payload === 'object' ? payload as BridgePayloadRecord : {}
);

const readString = (payload: BridgePayloadRecord, key: string): string | undefined => (
  typeof payload[key] === 'string' ? payload[key] as string : undefined
);

const readStringArray = (payload: BridgePayloadRecord, key: string): string[] | null => {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return null;
  }
  return value;
};

const readOptionalStringArray = (payload: BridgePayloadRecord, key: string): string[] | null | undefined => {
  if (!(key in payload) || payload[key] == null) {
    return undefined;
  }
  return readStringArray(payload, key);
};

const readOptionalBoolean = (payload: BridgePayloadRecord, key: string): boolean | null | undefined => {
  if (!(key in payload) || payload[key] == null) {
    return undefined;
  }
  const value = payload[key];
  return typeof value === 'boolean' ? value : null;
};

const readOptionalNumber = (payload: BridgePayloadRecord, key: string): number | null | undefined => {
  const value = payload[key];
  if (value == null) {
    return undefined;
  }
  return typeof value === 'number' ? value : null;
};

export async function handleStandardGitBridgeMessage(message: BridgeMessageInput): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;
  const payloadRecord = asRecord(payload);

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
      const { directory, mode } = (payload || {}) as { directory?: string; mode?: 'light' };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const status = await gitService.getGitStatus(directory!, mode === 'light' ? { mode } : undefined);
      return { id, type, success: true, data: status };
    }

    case 'api:git/history/refs': {
      const directory = readString(payloadRecord, 'directory');
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const refs = await gitService.getGitHistoryRefs(directory!);
      return { id, type, success: true, data: refs };
    }

    case 'api:git/history': {
      const directory = readString(payloadRecord, 'directory');
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const refs = readOptionalStringArray(payloadRecord, 'refs');
      if (refs === null) {
        return { id, type, success: false, error: 'refs must be an array of strings' };
      }
      const all = readOptionalBoolean(payloadRecord, 'all');
      if (all === null) {
        return { id, type, success: false, error: 'all must be a boolean' };
      }
      if (all === true && refs && refs.length > 0) {
        return { id, type, success: false, error: 'all cannot be combined with explicit refs' };
      }
      if (all !== true && !refs) {
        return { id, type, success: false, error: 'refs must be an array of strings' };
      }

      const cursor = readString(payloadRecord, 'cursor');
      const limit = readOptionalNumber(payloadRecord, 'limit');
      if (limit === null) {
        return { id, type, success: false, error: 'limit must be a number' };
      }

      const history = await gitService.getGitHistory(directory!, all === true ? { all: true, cursor, limit } : { refs, cursor, limit });
      return { id, type, success: true, data: history };
    }

    case 'api:git/history/merge-base': {
      const directory = readString(payloadRecord, 'directory');
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const refs = readStringArray(payloadRecord, 'refs');
      if (!refs) {
        return { id, type, success: false, error: 'refs must be an array of strings' };
      }

      const mergeBase = await gitService.getGitHistoryMergeBase(directory!, { refs });
      return { id, type, success: true, data: mergeBase };
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

    case 'api:git/branch-push-status': {
      const { directory, branches } = (payload || {}) as { directory?: string; branches?: string[] };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!Array.isArray(branches) || branches.some((branch) => typeof branch !== 'string')) {
        return { id, type, success: false, error: 'branches must be an array of branch names' };
      }
      return { id, type, success: true, data: await gitService.getGitUnpushedBranchCounts(directory!, branches) };
    }

    case 'api:git/tags': {
      const directory = readString(payloadRecord, 'directory');
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const method = readString(payloadRecord, 'method');
      const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';
      if (normalizedMethod !== 'POST') {
        return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
      }

      const name = readString(payloadRecord, 'name')?.trim();
      if (!name) {
        return { id, type, success: false, error: 'Tag name is required' };
      }
      if (isOptionLikeGitName(name)) {
        return { id, type, success: false, error: 'Tag name must not contain option-like values' };
      }

      const commitHash = readString(payloadRecord, 'commitHash')?.trim();
      if (!commitHash || !isFullGitObjectId(commitHash)) {
        return { id, type, success: false, error: 'commitHash must be a full commit SHA' };
      }

      const result = await gitService.createTag(directory!, name, commitHash);
      return { id, type, success: true, data: result };
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
      const { directory, path: filePath, scope } = (payload || {}) as { directory?: string; path?: string; scope?: 'all' | 'working' };
      if (!directory || !filePath) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      await gitService.revertGitFile(directory, filePath, { scope });
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:git/stage': {
      const { directory, path: filePath, paths } = (payload || {}) as { directory?: string; path?: string; paths?: string[] };
      const filePaths = (Array.isArray(paths) ? paths : [filePath])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (!directory || filePaths.length === 0) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      await gitService.stageGitFiles(directory, filePaths);
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:git/unstage': {
      const { directory, path: filePath, paths } = (payload || {}) as { directory?: string; path?: string; paths?: string[] };
      const filePaths = (Array.isArray(paths) ? paths : [filePath])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (!directory || filePaths.length === 0) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      await gitService.unstageGitFiles(directory, filePaths);
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:git/apply-hunk': {
      const { directory, path: filePath, patch, action } = (payload || {}) as {
        directory?: string;
        path?: string;
        patch?: string;
        action?: 'stage' | 'unstage' | 'discard';
      };
      if (!directory || !filePath || typeof patch !== 'string' || !patch.trim()) {
        return { id, type, success: false, error: 'Directory, path, and patch are required' };
      }
      if (action !== 'stage' && action !== 'unstage' && action !== 'discard') {
        return { id, type, success: false, error: 'action must be stage, unstage, or discard' };
      }
      await gitService.applyGitHunk(directory, filePath, patch, action);
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:git/commit': {
      const { directory, message, addAll, files, stageFiles } = (payload || {}) as {
        directory?: string;
        message?: string;
        addAll?: boolean;
        files?: string[];
        stageFiles?: string[];
      };
      if (!directory || !message) {
        return { id, type, success: false, error: 'Directory and message are required' };
      }
      const result = await gitService.createGitCommit(directory, message, { addAll, files, stageFiles });
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

    case 'api:git/checkout-commit': {
      const { directory, hash } = (payload || {}) as { directory?: string; hash?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!isValidCommitHash(hash)) {
        return { id, type, success: false, error: 'Invalid commit hash' };
      }
      const result = await gitService.checkoutCommit(directory!, hash);
      return { id, type, success: true, data: result };
    }

    case 'api:git/cherry-pick': {
      const { directory, hash } = (payload || {}) as { directory?: string; hash?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!isValidCommitHash(hash)) {
        return { id, type, success: false, error: 'Invalid commit hash' };
      }
      const result = await gitService.cherryPick(directory!, hash);
      return { id, type, success: true, data: result };
    }

    case 'api:git/revert-commit': {
      const { directory, hash } = (payload || {}) as { directory?: string; hash?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!isValidCommitHash(hash)) {
        return { id, type, success: false, error: 'Invalid commit hash' };
      }
      const result = await gitService.revertCommit(directory!, hash);
      return { id, type, success: true, data: result };
    }

    case 'api:git/reset-to-commit': {
      const { directory, hash, mode, force } = (payload || {}) as {
        directory?: string;
        hash?: string;
        mode?: 'soft' | 'mixed' | 'hard';
        force?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!isValidCommitHash(hash)) {
        return { id, type, success: false, error: 'Invalid commit hash' };
      }
      if (!mode || !['soft', 'mixed', 'hard'].includes(mode)) {
        return { id, type, success: false, error: 'mode must be soft, mixed, or hard' };
      }
      const result = await gitService.resetToCommit(directory!, hash, mode, force);
      return { id, type, success: true, data: result };
    }

    case 'api:git/log': {
      const { directory, maxCount, from, to, file, all } = (payload || {}) as {
        directory?: string;
        maxCount?: number;
        from?: string;
        to?: string;
        file?: string;
        all?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.getGitLog(directory!, { maxCount, from, to, file, all });
      return { id, type, success: true, data: result };
    }

    case 'api:git/commit-files': {
      const directory = readString(payloadRecord, 'directory');
      const hash = readString(payloadRecord, 'hash');
      const parentHashValue = payloadRecord.parentHash;
      const parentHash = parentHashValue === null ? null : readString(payloadRecord, 'parentHash');
      if (!directory || !hash) {
        return { id, type, success: false, error: 'Directory and hash are required' };
      }
      if (!isFullGitObjectId(hash)) {
        return { id, type, success: false, error: 'hash must be a full commit SHA' };
      }
      if (parentHashValue !== undefined && parentHashValue !== null && parentHash === undefined) {
        return { id, type, success: false, error: 'parentHash must be a string or null' };
      }
      if (parentHash !== undefined && parentHash !== null && !isFullGitObjectId(parentHash)) {
        return { id, type, success: false, error: 'parentHash must be a full commit SHA or null' };
      }
      const result = await gitService.getCommitFiles(directory, {
        commitHash: hash,
        parentHash: parentHash ?? null,
      });
      return { id, type, success: true, data: result };
    }

    case 'api:git/commit-file-diff': {
      const directory = readString(payloadRecord, 'directory');
      const hash = readString(payloadRecord, 'hash');
      const parentHashValue = payloadRecord.parentHash;
      const parentHash = parentHashValue === null ? null : readString(payloadRecord, 'parentHash');
      const originalPathValue = payloadRecord.originalPath;
      const originalPath = originalPathValue === null ? null : readString(payloadRecord, 'originalPath');
      const modifiedPathValue = payloadRecord.modifiedPath;
      const modifiedPath = modifiedPathValue === null ? null : readString(payloadRecord, 'modifiedPath');
      if (!directory || !hash) {
        return { id, type, success: false, error: 'Directory and hash are required' };
      }
      if (!isFullGitObjectId(hash)) {
        return { id, type, success: false, error: 'hash must be a full commit SHA' };
      }
      if (parentHashValue !== undefined && parentHashValue !== null && parentHash === undefined) {
        return { id, type, success: false, error: 'parentHash must be a string or null' };
      }
      if (parentHash !== undefined && parentHash !== null && !isFullGitObjectId(parentHash)) {
        return { id, type, success: false, error: 'parentHash must be a full commit SHA or null' };
      }
      if (originalPathValue !== undefined && originalPathValue !== null && originalPath === undefined) {
        return { id, type, success: false, error: 'originalPath must be a string or null' };
      }
      if (modifiedPathValue !== undefined && modifiedPathValue !== null && modifiedPath === undefined) {
        return { id, type, success: false, error: 'modifiedPath must be a string or null' };
      }
      if (!originalPath && !modifiedPath) {
        return { id, type, success: false, error: 'originalPath or modifiedPath is required' };
      }
      const result = await gitService.getCommitFileDiff(directory, {
        commitHash: hash,
        parentHash: parentHash ?? null,
        originalPath: originalPath ?? null,
        modifiedPath: modifiedPath ?? null,
      });
      return { id, type, success: true, data: result };
    }

    case 'api:git/identity': {
      const { directory, method, userName, userEmail, sshKey, signCommits, signingKey } = (payload || {}) as {
        directory?: string;
        method?: string;
        userName?: string;
        userEmail?: string;
        sshKey?: string | null;
        signCommits?: boolean;
        signingKey?: string | null;
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
        const result = await gitService.setGitIdentity(
          directory!,
          userName,
          userEmail,
          sshKey,
          signCommits === true,
          signingKey ?? null
        );
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
