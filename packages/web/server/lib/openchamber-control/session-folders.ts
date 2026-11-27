import crypto from 'node:crypto';
import { asNonEmptyString, isRecord } from '../shared/guards.js';
import { isString } from '../shared/object-guards.js';
import { resolveWorktreeTopLevel as resolveWorktreeTopLevelDefault } from '../git/index.js';
import { OpenChamberControlError, asControlError } from './error.js';
import { SessionFoldersError, type SessionFoldersStore } from '../session-folders/store.js';
import type { FolderChange, SessionFolder } from '../session-folders/contracts.js';
import type { ControlInput } from './contracts.js';

const WINDOWS_DRIVE_ROOT = /^(?:\/\/\?\/)?[A-Za-z]:\/+$/u;

export const normalizeFolderPath = (value?: string | null): string | null => {
  if (!isString(value)) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const replaced = trimmed
    .replace(/\\/g, '/')
    .replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`);
  if (replaced === '/') return '/';
  if (WINDOWS_DRIVE_ROOT.test(replaced)) return replaced.replace(/\/+$/u, '/');
  const stripped = replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
  return stripped || null;
};

const isPathUnder = (parent: string, candidate: string): boolean => {
  if (candidate === parent) return true;
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return candidate.startsWith(prefix);
};

export const worktreeFolderMemberId = (directory: string): string | null => {
  const normalized = normalizeFolderPath(directory);
  return normalized ? `worktree:${normalized}` : null;
};

const rethrowFolderError = (error: Error | SessionFoldersError | OpenChamberControlError, fallback: string): never => {
  if (error instanceof OpenChamberControlError) throw error;
  if (error instanceof SessionFoldersError) throw new OpenChamberControlError(error.message, error.status);
  throw asControlError(error, fallback);
};

const findExistingFolder = (folders: SessionFolder[], ref: string): SessionFolder | null => {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new OpenChamberControlError('folder must be a non-empty folder id or name, or null', 400);
  }
  const byId = folders.find((folder) => folder.id === trimmed);
  if (byId) return byId;
  const normalized = trimmed.toLowerCase();
  const byName = folders.filter((folder) => folder.name.trim().toLowerCase() === normalized);
  if (byName.length === 1 && byName[0]) return byName[0];
  if (byName.length > 1) {
    const matches = byName.map((folder) => `${folder.name} (${folder.id})`).join(', ');
    throw new OpenChamberControlError(`Multiple sidebar folders match "${trimmed}": ${matches}. Pass the folder id from folder.list`, 400);
  }
  return null;
};

const folderHoldingMember = (folders: SessionFolder[], memberId: string): SessionFolder | null => (
  folders.find((folder) => folder.sessionIds.includes(memberId)) ?? null
);

export interface FolderRef {
  id: string;
  name: string;
}

export interface FolderPlacement {
  scopeKey: string;
  folder: FolderRef | null;
  requestedName?: string;
  explicit: boolean;
}

export interface SessionFolderActionsDependencies {
  store: SessionFoldersStore;
  resolveProjectPath: (directory: string) => Promise<string>;
  resolveProjectById: (projectId: string) => Promise<string>;
  resolveSessionDirectory: (sessionId: string) => Promise<string | null>;
  chatsRoot?: string | null | undefined;
  chatRoots?: readonly string[] | undefined;
  resolveWorktreeRoot?: ((directory: string) => Promise<string | null>) | undefined;
  createId?: (() => string) | undefined;
}

export type FolderTarget =
  | { kind: 'worktree'; memberId: string; directory: string }
  | { kind: 'session'; memberId: string; sessionId: string };

interface CreatedSessionRecord {
  sessionId: string;
  directory?: string | undefined;
  worktree?: object | undefined;
}

interface MovedWorktreeRecord {
  worktree?: { path?: string | undefined } | undefined;
}

export const createSessionFolderActions = (dependencies: SessionFolderActionsDependencies) => {
  const {
    store,
    resolveProjectPath,
    resolveProjectById,
    resolveSessionDirectory,
    chatsRoot = null,
    chatRoots = [],
    resolveWorktreeRoot = async (directory: string) => (await resolveWorktreeTopLevelDefault(directory).catch(() => null))?.root ?? null,
    createId = () => crypto.randomUUID(),
  } = dependencies;

  const normalizedChatsRoot = normalizeFolderPath(chatsRoot);
  const normalizedChatRoots = [
    ...(normalizedChatsRoot ? [normalizedChatsRoot] : []),
    ...chatRoots.map((root) => normalizeFolderPath(root)).filter((root): root is string => Boolean(root)),
  ];

  const isManagedChatDirectory = (directory: string | null): boolean => {
    const normalized = normalizeFolderPath(directory);
    if (!normalized) return false;
    return normalizedChatRoots.some((root) => isPathUnder(root, normalized));
  };

  const resolveProjectScope = async (directory: string): Promise<string | null> => {
    if (normalizedChatsRoot && isManagedChatDirectory(directory)) {
      return normalizedChatsRoot;
    }
    const projectPath = await resolveProjectPath(directory);
    if (normalizedChatsRoot && isManagedChatDirectory(projectPath)) {
      return normalizedChatsRoot;
    }
    return normalizeFolderPath(projectPath);
  };

  const resolveScopeKey = async (
    input: Pick<ControlInput, 'projectId' | 'directory'>,
    contextDirectory: ControlInput['directory'],
  ): Promise<string> => {
    const projectId = asNonEmptyString(input.projectId);
    const directory = asNonEmptyString(input.directory);
    if (projectId && directory) {
      throw new OpenChamberControlError('Provide either projectId or directory, not both', 400);
    }
    if (projectId) {
      const projectPath = await resolveProjectById(projectId);
      const scopeKey = normalizeFolderPath(projectPath);
      if (!scopeKey) throw new OpenChamberControlError(`Project not found: ${projectId}`, 404);
      return scopeKey;
    }
    const targetDirectory = directory || asNonEmptyString(contextDirectory);
    if (!targetDirectory) {
      throw new OpenChamberControlError('directory or projectId is required', 400);
    }
    const scopeKey = await resolveProjectScope(targetDirectory);
    if (!scopeKey) throw new OpenChamberControlError('directory is required', 400);
    return scopeKey;
  };

  const resolveMemberForDirectory = async (
    scopeKey: string,
    directory: string | null,
    sessionId: string | null,
  ): Promise<FolderTarget | null> => {
    if (directory && !isManagedChatDirectory(directory)) {
      const topLevel = await resolveWorktreeRoot(directory).catch(() => null);
      const checkoutRoot = normalizeFolderPath(topLevel || directory);
      if (checkoutRoot && checkoutRoot !== scopeKey && !isPathUnder(checkoutRoot, scopeKey)) {
        const memberId = worktreeFolderMemberId(checkoutRoot);
        if (memberId) return { kind: 'worktree', memberId, directory: checkoutRoot };
      }
    }
    if (sessionId) {
      return { kind: 'session', memberId: sessionId, sessionId };
    }
    return null;
  };

  const list = async (input: ControlInput, contextDirectory: ControlInput['directory'], contextSessionId?: string) => {
    const scopeKey = await resolveScopeKey(input, contextDirectory);
    const snapshot = await store.readCurrent().catch((error: Error) => rethrowFolderError(error, 'Failed to read sidebar folders'));
    const folders = snapshot.foldersMap[scopeKey] ?? [];
    let currentFolder: FolderRef | null = null;
    const callerSessionId = asNonEmptyString(contextSessionId);
    const callerDirectory = (callerSessionId ? await resolveSessionDirectory(callerSessionId).catch(() => null) : null)
      || asNonEmptyString(contextDirectory);
    if (callerDirectory || callerSessionId) {
      const callerScope = callerDirectory
        ? await resolveProjectScope(callerDirectory).catch(() => normalizeFolderPath(callerDirectory))
        : null;
      if (!callerScope || callerScope === scopeKey) {
        const callerTarget = await resolveMemberForDirectory(scopeKey, callerDirectory, callerSessionId);
        if (callerTarget) {
          const holding = folderHoldingMember(folders, callerTarget.memberId);
          if (holding) currentFolder = { id: holding.id, name: holding.name };
        }
      }
    }
    return {
      scopeKey,
      folders: folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId ?? null,
        memberCount: folder.sessionIds.length,
      })),
      currentFolder,
    };
  };

  const create = async (input: ControlInput, contextDirectory: ControlInput['directory']) => {
    const name = asNonEmptyString(input.name)?.trim();
    if (!name) throw new OpenChamberControlError('name is required for folder.create', 400);
    if (name.length > 10_000) throw new OpenChamberControlError('name is too long', 400);
    if (input.parentId !== undefined && input.parentId !== null && !isString(input.parentId)) {
      throw new OpenChamberControlError('parentId must be a folder id or null', 400);
    }
    const parentId = isString(input.parentId) ? (input.parentId.trim() || null) : null;
    const scopeKey = await resolveScopeKey(input, contextDirectory);
    const { value } = await store.mutate((current, timestamp) => {
      const folders = current.foldersMap[scopeKey] ?? [];
      if (parentId && !folders.some((folder) => folder.id === parentId)) {
        throw new OpenChamberControlError(`Parent folder not found: ${parentId}`, 404);
      }
      const normalizedName = name.toLowerCase();
      const existing = folders.find((folder) => (
        (folder.parentId ?? null) === parentId
        && folder.name.trim().toLowerCase() === normalizedName
      ));
      if (existing) {
        return {
          changes: [],
          value: {
            folder: { id: existing.id, name: existing.name, parentId: existing.parentId ?? null },
            created: false,
          },
        };
      }
      const id = createId();
      return {
        changes: [{ type: 'create', scopeKey, folder: { id, name, parentId, createdAt: timestamp } }],
        value: { folder: { id, name, parentId }, created: true },
      };
    }).catch((error: Error) => rethrowFolderError(error, 'Failed to create sidebar folder'));
    return { scopeKey, ...value };
  };

  const move = async (input: ControlInput, contextDirectory: ControlInput['directory'], contextSessionId?: string) => {
    if (input.folder === undefined) {
      throw new OpenChamberControlError('folder is required for folder.move (a folder id or name, or null to remove from a folder)', 400);
    }
    if (input.folder !== null && !isString(input.folder)) {
      throw new OpenChamberControlError('folder must be a folder id or name, or null', 400);
    }
    const explicitProjectId = asNonEmptyString(input.projectId);
    const explicitDirectory = asNonEmptyString(input.directory);
    if (explicitProjectId && explicitDirectory) {
      throw new OpenChamberControlError('Provide either projectId or directory, not both', 400);
    }
    const explicitSessionId = asNonEmptyString(input.sessionId);
    const callerSessionId = asNonEmptyString(contextSessionId);
    const targetSessionId = explicitSessionId || (!explicitDirectory ? callerSessionId : null);

    let targetDirectory: string | null = null;
    let scopeKey: string;
    if (explicitSessionId) {
      const sessionDirectory = await resolveSessionDirectory(explicitSessionId);
      if (!sessionDirectory) {
        throw new OpenChamberControlError(`Session not found: ${explicitSessionId}`, 404);
      }
      const sessionScope = await resolveProjectScope(sessionDirectory);
      if (!sessionScope) {
        throw new OpenChamberControlError(`Could not resolve project for session: ${explicitSessionId}`, 400);
      }
      if (explicitProjectId || explicitDirectory) {
        const requestedScope = await resolveScopeKey({ projectId: explicitProjectId, directory: explicitDirectory }, contextDirectory);
        if (requestedScope !== sessionScope) {
          throw new OpenChamberControlError('sessionId belongs to a different project than the requested scope', 400);
        }
      }
      targetDirectory = sessionDirectory;
      scopeKey = sessionScope;
    } else if (explicitDirectory) {
      targetDirectory = explicitDirectory;
      scopeKey = await resolveScopeKey({ directory: explicitDirectory }, contextDirectory);
    } else {
      const callerDir = (callerSessionId ? await resolveSessionDirectory(callerSessionId).catch(() => null) : null)
        || asNonEmptyString(contextDirectory);
      scopeKey = await resolveScopeKey({ projectId: explicitProjectId, directory: callerDir }, contextDirectory);
      if (explicitProjectId && callerDir) {
        const callerScope = await resolveProjectScope(callerDir).catch(() => null);
        if (callerScope && callerScope !== scopeKey) {
          throw new OpenChamberControlError('The current session belongs to a different project than projectId', 400);
        }
      }
      targetDirectory = callerDir;
    }

    const target = await resolveMemberForDirectory(scopeKey, targetDirectory, targetSessionId);
    if (!target) {
      throw new OpenChamberControlError('sessionId is required to move a session in the project root; pass a worktree directory to move a worktree', 400);
    }

    const folderRef = input.folder;
    const { changed, value } = await store.mutate<FolderRef | null>((current, timestamp) => {
      if (folderRef === null) {
        return {
          changes: [{ type: 'unassign', scopeKey, sessionIds: [target.memberId] }],
          value: null,
        };
      }
      const existing = findExistingFolder(current.foldersMap[scopeKey] ?? [], folderRef);
      if (existing) {
        return {
          changes: [{ type: 'assign', scopeKey, folderId: existing.id, sessionIds: [target.memberId] }],
          value: { id: existing.id, name: existing.name },
        };
      }
      const trimmed = folderRef.trim();
      const id = createId();
      return {
        changes: [
          { type: 'create', scopeKey, folder: { id, name: trimmed, parentId: null, createdAt: timestamp } },
          { type: 'assign', scopeKey, folderId: id, sessionIds: [target.memberId] },
        ],
        value: { id, name: trimmed },
      };
    }).catch((error: Error) => rethrowFolderError(error, 'Failed to update sidebar folders'));

    return {
      scopeKey,
      target,
      folder: value,
      moved: changed,
    };
  };

  const findInheritedFolder = async (
    targetScopeKey: string,
    sessionId: string | null,
    directory: string | null,
  ): Promise<FolderRef | null> => {
    if (!sessionId && !directory) return null;
    const resolvedDir = directory || (sessionId ? await resolveSessionDirectory(sessionId).catch(() => null) : null);
    if (!resolvedDir && !sessionId) return null;
    const ownerScope = resolvedDir ? await resolveProjectScope(resolvedDir).catch(() => null) : targetScopeKey;
    if (!ownerScope || ownerScope !== targetScopeKey) return null;
    const target = await resolveMemberForDirectory(ownerScope, resolvedDir, sessionId);
    if (!target) return null;
    const current = await store.readCurrent().catch(() => null);
    if (!current) return null;
    const holding = folderHoldingMember(current.foldersMap[ownerScope] ?? [], target.memberId);
    return holding ? { id: holding.id, name: holding.name } : null;
  };

  const resolvePlacementBeforeCreate = async (params: {
    folderInput: ControlInput['folder'];
    projectId?: ControlInput['projectId'];
    directory?: ControlInput['directory'];
    contextDirectory?: ControlInput['directory'];
    contextSessionId?: string | undefined;
    sourceSessionId?: string | undefined;
    sourceDirectory?: string | null | undefined;
  }): Promise<FolderPlacement | null> => {
    const { folderInput } = params;
    if (folderInput === null) return null;
    if (folderInput !== undefined && !isString(folderInput)) {
      throw new OpenChamberControlError('folder must be a folder id or name, or null', 400);
    }
    if (isString(folderInput)) {
      const scopeKey = await resolveScopeKey({ projectId: params.projectId, directory: params.directory }, params.contextDirectory);
      const current = await store.readCurrent().catch((error: Error) => rethrowFolderError(error, 'Failed to read sidebar folders'));
      const trimmed = folderInput.trim();
      const destination = findExistingFolder(current.foldersMap[scopeKey] ?? [], trimmed);
      const placement: FolderPlacement = {
        scopeKey,
        folder: destination ? { id: destination.id, name: destination.name } : null,
        explicit: true,
      };
      if (!destination || destination.id !== trimmed) {
        placement.requestedName = trimmed;
      }
      return placement;
    }

    let targetScopeKey: string;
    try {
      targetScopeKey = await resolveScopeKey({ projectId: params.projectId, directory: params.directory }, params.contextDirectory);
    } catch {
      return null;
    }

    const sourceSessionId = asNonEmptyString(params.sourceSessionId);
    const sourceDirectory = asNonEmptyString(params.sourceDirectory);
    if (sourceSessionId || sourceDirectory) {
      const inheritedFromSource = await findInheritedFolder(targetScopeKey, sourceSessionId, sourceDirectory);
      if (inheritedFromSource) return { scopeKey: targetScopeKey, folder: inheritedFromSource, explicit: false };
    }

    const callerSessionId = asNonEmptyString(params.contextSessionId);
    if (callerSessionId && callerSessionId !== sourceSessionId) {
      const inheritedFromCaller = await findInheritedFolder(targetScopeKey, callerSessionId, null);
      if (inheritedFromCaller) return { scopeKey: targetScopeKey, folder: inheritedFromCaller, explicit: false };
    } else if (!sourceSessionId && !sourceDirectory) {
      const inherited = await findInheritedFolder(targetScopeKey, callerSessionId, asNonEmptyString(params.contextDirectory));
      if (inherited) return { scopeKey: targetScopeKey, folder: inherited, explicit: false };
    }
    return null;
  };

  const assignMember = async (params: {
    placement: FolderPlacement;
    memberId: string;
    unassignMemberId?: string | null | undefined;
  }): Promise<{ folder: FolderRef | null; folderError?: string }> => {
    try {
      const { snapshot, value } = await store.mutate<FolderRef | null>((current, timestamp) => {
        const folders = current.foldersMap[params.placement.scopeKey] ?? [];
        let destination: SessionFolder | null = params.placement.folder
          ? (folders.find((folder) => folder.id === params.placement.folder?.id) ?? null)
          : null;
        if (!destination && params.placement.explicit && params.placement.requestedName) {
          destination = findExistingFolder(folders, params.placement.requestedName);
        }
        const changes: FolderChange[] = [];
        let targetFolder: FolderRef | null = destination ? { id: destination.id, name: destination.name } : null;
        if (!targetFolder) {
          if (!params.placement.explicit || !params.placement.requestedName) {
            return { changes: [], value: null };
          }
          const id = createId();
          const name = params.placement.requestedName;
          changes.push({
            type: 'create',
            scopeKey: params.placement.scopeKey,
            folder: { id, name, parentId: null, createdAt: timestamp },
          });
          targetFolder = { id, name };
        }
        if (params.unassignMemberId && params.unassignMemberId !== params.memberId) {
          changes.push({
            type: 'unassign',
            scopeKey: params.placement.scopeKey,
            sessionIds: [params.unassignMemberId],
          });
        }
        changes.push({
          type: 'assign',
          scopeKey: params.placement.scopeKey,
          folderId: targetFolder.id,
          sessionIds: [params.memberId],
        });
        return { changes, value: targetFolder };
      });
      if (!value) {
        return params.placement.explicit && params.placement.folder
          ? { folder: null, folderError: `Sidebar folder was deleted before assignment: ${params.placement.folder.name}` }
          : { folder: null };
      }
      const committed = (snapshot.foldersMap[params.placement.scopeKey] ?? []).find((folder) => folder.id === value.id);
      if (!committed?.sessionIds.includes(params.memberId)) {
        return { folder: null };
      }
      return { folder: { id: committed.id, name: committed.name } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (params.placement.explicit) {
        return { folder: null, folderError: message };
      }
      console.warn('Failed to inherit sidebar folder:', message);
      return { folder: null };
    }
  };

  const createWithFolder = async <Result extends CreatedSessionRecord>(params: {
    input: ControlInput;
    contextDirectory: ControlInput['directory'];
    contextSessionId?: string | undefined;
    ownWork: boolean;
    create: () => Promise<Result>;
  }): Promise<Result & { folder?: FolderRef; folderError?: string }> => {
    const placement = await resolvePlacementBeforeCreate({
      folderInput: params.input.folder,
      projectId: params.input.projectId,
      directory: params.input.directory,
      contextDirectory: params.contextDirectory,
      contextSessionId: params.contextSessionId,
    });
    const result = await params.create();
    if (!placement) return result;
    const createdWorktreePath = isRecord(result.worktree) ? asNonEmptyString(result.worktree.path) : null;
    let memberId: string | null = null;
    if (createdWorktreePath) {
      memberId = worktreeFolderMemberId(createdWorktreePath);
    } else {
      const resolved = await resolveMemberForDirectory(placement.scopeKey, result.directory ?? null, result.sessionId);
      if (resolved?.kind === 'worktree') {
        memberId = placement.explicit ? resolved.memberId : null;
      } else if (!params.ownWork || placement.explicit) {
        memberId = result.sessionId;
      }
    }
    if (!memberId) return result;
    const { folder, folderError } = await assignMember({ placement, memberId });
    if (folder) return { ...result, folder };
    if (folderError) return { ...result, folderError };
    return result;
  };

  const moveWithFolder = async <Result extends MovedWorktreeRecord>(params: {
    input: ControlInput;
    sessionId: string;
    callerSessionId?: string | undefined;
    directory: string | null;
    contextDirectory: ControlInput['directory'];
    move: () => Promise<Result>;
  }): Promise<Result & { folder?: FolderRef; folderError?: string }> => {
    const placement = await resolvePlacementBeforeCreate({
      folderInput: params.input.folder,
      directory: params.directory,
      contextDirectory: params.contextDirectory,
      contextSessionId: params.callerSessionId,
      sourceSessionId: params.sessionId,
      sourceDirectory: params.directory,
    });
    const moved = await params.move();
    if (!placement || !moved?.worktree?.path) return moved;
    const memberId = worktreeFolderMemberId(moved.worktree.path);
    if (!memberId) return moved;
    const { folder, folderError } = await assignMember({ placement, memberId, unassignMemberId: params.sessionId });
    if (folder) return { ...moved, folder };
    if (folderError) return { ...moved, folderError };
    return moved;
  };

  const execute = (
    action: 'folder.list' | 'folder.create' | 'folder.move',
    input: ControlInput,
    contextDirectory: ControlInput['directory'],
    contextSessionId?: string,
  ) => {
    if (action === 'folder.list') return list(input, contextDirectory, contextSessionId);
    if (action === 'folder.create') return create(input, contextDirectory);
    return move(input, contextDirectory, contextSessionId);
  };

  return {
    execute,
    createWithFolder,
    moveWithFolder,
  };
};
