import type { folderChangesBodySchema } from './folder-changes.js';
import type { z } from 'zod';

export interface SessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  parentId?: string | null | undefined;
}

export type SessionFoldersMap = Record<string, SessionFolder[]>;
export type FolderTombstones = Record<string, number>;
export type FolderChange = z.infer<typeof folderChangesBodySchema>['changes'][number];

export interface StoredFolderSnapshot {
  version: 1;
  foldersMap: SessionFoldersMap;
  collapsedFolderIds: string[];
  deletedFolderIds?: FolderTombstones | undefined;
  updatedAt?: unknown;
}

export interface FolderSnapshot extends StoredFolderSnapshot {
  updatedAt: number;
}

export type FolderChangesResult =
  | { snapshot: StoredFolderSnapshot; changed: false }
  | { snapshot: FolderSnapshot; changed: true };

type SessionFoldersResponse =
  | (StoredFolderSnapshot & { exists: boolean })
  | { version: 1; exists: false }
  | { error: string }
  | { success: true };

interface RouteResponse {
  status: (code: number) => RouteResponse;
  json: (payload: SessionFoldersResponse) => RouteResponse;
}

type RouteHandler = (req: { body: unknown }, res: RouteResponse) => Promise<RouteResponse>;

export interface SessionFoldersApp {
  get: (path: string, handler: RouteHandler) => void;
  post: (path: string, handler: RouteHandler) => void;
  patch: (path: string, handler: RouteHandler) => void;
}

export interface SessionFoldersDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'readFile' | 'writeFile' | 'rename' | 'unlink'>;
  path: Pick<typeof import('node:path'), 'join' | 'dirname'>;
  openchamberDataDir: string;
  onChanged?: ((updatedAt: number) => void) | undefined;
  now?: (() => number) | undefined;
}
