import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';

export type SessionDeleteRequest = {
  sessions: Session[];
  dateLabel?: string;
  mode?: 'session' | 'worktree';
  worktree?: WorktreeMetadata | null;
};

export type SessionCreateRequest = {
  worktreeMode?: 'main' | 'create' | 'reuse';
  parentID?: string | null;
  projectId?: string | null;
};

type DeleteListener = (request: SessionDeleteRequest) => void;
type CreateListener = (request: SessionCreateRequest) => void;
type DirectoryListener = () => void;
type GitRefreshHint = { directory: string };
type GitRefreshListener = (hint: GitRefreshHint) => void;
type VcsDiffRefreshListener = (hint: GitRefreshHint) => void;

const deleteListeners = new Set<DeleteListener>();
const createListeners = new Set<CreateListener>();
const directoryListeners = new Set<DirectoryListener>();
const gitRefreshListeners = new Set<GitRefreshListener>();
const vcsDiffRefreshListeners = new Set<VcsDiffRefreshListener>();
const vcsDiffRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const sessionEvents = {
  onDeleteRequest(listener: DeleteListener) {
    deleteListeners.add(listener);
    return () => {
      deleteListeners.delete(listener);
    };
  },
  requestDelete(payload: SessionDeleteRequest) {
    if (!payload.sessions.length && payload.mode !== 'worktree') {
      return;
    }
    deleteListeners.forEach((listener) => listener(payload));
  },
  onCreateRequest(listener: CreateListener) {
    createListeners.add(listener);
    return () => {
      createListeners.delete(listener);
    };
  },
  requestCreate(payload?: SessionCreateRequest) {
    const request = payload ?? {};
    createListeners.forEach((listener) => listener(request));
  },
  onDirectoryRequest(listener: DirectoryListener) {
    directoryListeners.add(listener);
    return () => {
      directoryListeners.delete(listener);
    };
  },
  requestDirectoryDialog() {
    directoryListeners.forEach((listener) => listener());
  },
  onGitRefreshHint(listener: GitRefreshListener) {
    gitRefreshListeners.add(listener);
    return () => {
      gitRefreshListeners.delete(listener);
    };
  },
  requestGitRefresh(hint: GitRefreshHint) {
    if (!hint.directory.trim()) {
      return;
    }
    gitRefreshListeners.forEach((listener) => listener(hint));
  },
  onVcsDiffRefreshHint(listener: VcsDiffRefreshListener) {
    vcsDiffRefreshListeners.add(listener);
    return () => {
      vcsDiffRefreshListeners.delete(listener);
    };
  },
  requestVcsDiffRefresh(hint: GitRefreshHint) {
    const directory = hint.directory.trim();
    if (!directory) return;

    const existing = vcsDiffRefreshTimers.get(directory);
    if (existing) clearTimeout(existing);
    vcsDiffRefreshTimers.set(directory, setTimeout(() => {
      vcsDiffRefreshTimers.delete(directory);
      vcsDiffRefreshListeners.forEach((listener) => listener({ directory }));
    }, 100));
  },
};
