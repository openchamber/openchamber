import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { PlanProgress } from './plan-progress.js';
import { isRecord } from '../shared/guards.js';

export const PROJECT_CONTEXT_VERSION = 2;
export const PROJECT_NOTE_BODY_MAX_LENGTH = 3000;
export const PROJECT_NOTE_MAX_ITEMS = 200;
export const PROJECT_TODO_TEXT_MAX_LENGTH = 1000;
export const PROJECT_PLAN_TITLE_MAX_LENGTH = 160;
export const PROJECT_PLAN_BODY_MAX_LENGTH = 200_000;
export const PROJECT_TODO_MAX_ITEMS = 500;
export const PROJECT_PLAN_MAX_ITEMS = 500;
export const NOTES_TODOS_STORE_LOCAL = 'local';
export const NOTES_TODOS_STORE_REPOSITORY = 'repository';
export const MALFORMED_NOTES_TODOS_FILE = 'MALFORMED_NOTES_TODOS_FILE';
export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;
export const PLAN_FILE_PATTERN = /^[a-zA-Z0-9._-]+\.md$/;

export const isContextInput = (value: unknown): value is StoredContextInput => isRecord(value);
export const isNoteInput = (value: unknown): value is StoredNoteInput => isRecord(value);
export const isTodoInput = (value: unknown): value is TodoInput => isRecord(value);
export const isPlanInput = (value: unknown): value is StoredPlanInput => isRecord(value);
export const isOriginInput = (value: unknown): value is NoteOriginInput => isRecord(value);
export const isSessionInput = (value: unknown): value is PlanSessionInput => isRecord(value);
export const isSessionMapInput = (value: unknown): value is object => isRecord(value);
export const isText = (value: unknown): value is string => typeof value === 'string';
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
export const isTimestamp = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0;
export const hasErrorCode = (cause: unknown): cause is { code: unknown } => cause !== null
  && (typeof cause === 'object' || typeof cause === 'function') && 'code' in cause;
export const isNoteSource = (value: unknown): value is NoteSource => value === 'manual' || value === 'selection' || value === 'agent';
export const hasRandomUuid = (value: Crypto | undefined): value is Crypto => value !== undefined
  && typeof value.randomUUID === 'function';

export type NoteSource = 'manual' | 'selection' | 'agent';

export interface NoteOrigin {
  sessionId: string;
  messageId?: string;
}

export interface PlanLinks {
  planId?: string;
  dependsOn?: string[];
}

export interface ProjectNote extends Pick<PlanLinks, 'planId'> {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  source: NoteSource;
  pinned: boolean;
  origin?: NoteOrigin;
}

export interface ProjectTodo extends PlanLinks {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

export interface StoredPlan {
  id: string;
  file: string;
  title: string;
  createdAt: number;
  pinned: boolean;
  shared?: boolean;
}

export interface PlanSession {
  sessionId: string;
  linkedAt: number;
}

export type PlanSessions = Record<string, PlanSession>;

export interface NotesTodos {
  notes: ProjectNote[];
  todos: ProjectTodo[];
}

export interface StoredContext extends NotesTodos {
  version: number;
  plans: StoredPlan[];
  planSessions: PlanSessions;
}

export interface PublicPlan extends Omit<StoredPlan, 'shared'> {
  source: 'shared' | 'personal';
  progress?: PlanProgress;
  session?: PlanSession;
}

export interface ProjectContext extends NotesTodos {
  version: number;
  plans: PublicPlan[];
  notesTodosStore: string;
  sharedPlansDir: string | null;
}

export interface ReadPlan {
  id: string;
  file: string;
  path: string;
  createdAt: number;
  title: string;
  body: string;
  raw: string;
  source: 'shared' | 'personal';
}

export interface TodoInput {
  id?: unknown;
  text?: unknown;
  completed?: unknown;
  createdAt?: unknown;
  planId?: unknown;
  dependsOn?: unknown;
}

export interface NoteInput {
  body?: unknown;
  source?: unknown;
  origin?: unknown;
  pinned?: unknown;
  planId?: unknown;
}

export interface PlanInput {
  title?: unknown;
  body?: unknown;
  raw?: unknown;
}

export interface StoredNoteInput extends NoteInput {
  id?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface StoredPlanInput {
  id?: unknown;
  file?: unknown;
  path?: unknown;
  title?: unknown;
  createdAt?: unknown;
  pinned?: unknown;
  shared?: unknown;
}

export interface StoredContextInput {
  version?: unknown;
  notes?: unknown;
  todos?: unknown;
  plans?: unknown;
  planSessions?: unknown;
  projectNotes?: unknown;
  projectTodos?: unknown;
  projectPlanFiles?: unknown;
}

export interface NoteOriginInput {
  sessionId?: unknown;
  messageId?: unknown;
}

export interface PlanSessionInput {
  sessionId?: unknown;
  linkedAt?: unknown;
}

export interface StorageSwitch {
  enabled: boolean;
  file: string | null;
  commit: () => Promise<void>;
}

export interface ProjectContextDependencies {
  fsPromises: Pick<typeof fs, 'readFile' | 'writeFile' | 'mkdir' | 'rename' | 'rm' | 'readdir' | 'stat' | 'access' | 'copyFile'>;
  path: Pick<typeof path, 'join' | 'dirname' | 'basename'>;
  projectsDirPath: string;
  createId?: () => string;
  resolveSharedPlansDir?: (projectId: string) => Promise<string | null>;
  resolveNotesTodosFile?: (projectId: string) => Promise<string | null>;
  onChanged?: ((projectId: string) => void) | undefined;
}
