import { z } from 'zod';
import type { OpenCodeTrust, SessionDirectoryResolver } from '../opencode-trust/contracts.js';
import type { discoverLoops } from '../scheduled-tasks/loops.js';

const sharedProjectDocumentSchema = z.record(z.string(), z.unknown());
export type SharedProjectDocument = z.infer<typeof sharedProjectDocumentSchema>;
export type ActionPlatform = 'macos' | 'linux' | 'windows';

export interface ProjectAction {
  id: string;
  name: string;
  command: string;
  icon: string | null;
  autoOpenUrl?: true;
  openUrl?: string;
  desktopOpenSshForward?: string;
  platforms?: ActionPlatform[];
  runIn?: 'parent';
}

export interface DraftStarter {
  type: 'command' | 'skill';
  name: string;
}

export interface SharedProjectConfig {
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  teardownWorktree: string[];
  projectActions: ProjectAction[];
  draftStarters: DraftStarter[];
  plansDir: string | null;
}

export interface PersonalProjectSetup extends Omit<SharedProjectConfig, 'plansDir'> {
  setupWorktreeMode: 'append' | 'replace';
  createWorktreeCommand: string;
  projectActionsPrimaryId: string | null;
  hiddenSharedActionIds: string[];
  sharedTrust: { hash: string; trustedAt: number } | null;
  notesTodosInRepository: boolean;
}

export type SharedProjectRead<Document extends SharedProjectDocument = SharedProjectDocument> =
  | { status: 'ok'; config: SharedProjectConfig; document: Document }
  | { status: 'missing'; document?: never }
  | { status: 'invalid'; reason: string; unread?: boolean; document?: Document };

export interface StoredProjectSetupPatch {
  'setup-worktree'?: string[];
  'setup-worktree-wait'?: boolean;
  teardownWorktree?: string[];
  createWorktreeCommand?: string | undefined;
  projectActions?: ProjectAction[];
  projectActionsPrimaryId?: string | undefined;
  draftStarters?: DraftStarter[];
  hiddenSharedActionIds?: string[];
  setupWorktreeMode?: 'append' | 'replace';
  sharedTrust?: { hash: string; trustedAt: number } | undefined;
  notesTodosInRepository?: true | undefined;
  projectPath?: string;
}

export interface WorktreeSetupInput {
  setupWorktree: string[];
  trust: { trusted: boolean };
  shared: { setupWorktree: string[] };
  personal: {
    setupWorktree: string[];
    setupWorktreeMode: PersonalProjectSetup['setupWorktreeMode'];
    createWorktreeCommand?: string;
  };
}

export interface WorktreeSetup {
  startCommand: string;
  createCommand: string;
  untrustedSkipped: string[];
}

export interface SessionProject {
  id: string;
  path: string;
}

export type ScheduledTaskStatus = 'running' | 'success' | 'error' | 'idle' | 'queued' | 'sent' | 'skipped' | 'failed' | 'cancelled';

export type ScheduledTaskSchedule =
  | { kind: 'daily'; times: string[]; timezone: string }
  | { kind: 'weekly'; times: string[]; weekdays: number[]; timezone: string }
  | { kind: 'once'; date: string; time: string; timezone: string }
  | { kind: 'cron'; cron: string; timezone: string };

export type ScheduledTaskExecution = {
  prompt: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
  agent?: string;
  useDefaults?: boolean;
  goalEnabled?: boolean;
  goalTokenBudget?: number;
  permissionAutoAccept?: boolean;
};

export type ScheduledTaskState = {
  createdAt: number;
  updatedAt: number;
  lastStatus: ScheduledTaskStatus;
  lastRunAt?: number | undefined;
  lastDurationMs?: number | undefined;
  nextRunAt?: number | undefined;
  lastScheduledFor?: number | undefined;
  waitingForFolder?: number | undefined;
  lastSessionId?: string | undefined;
  lastError?: string | undefined;
  lastRunIsolated?: boolean | undefined;
  lastRunBranch?: string | undefined;
};

export type ScheduledTask = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: ScheduledTaskSchedule;
  execution: ScheduledTaskExecution;
  state: ScheduledTaskState;
  loopFile?: string;
  loopApproval?: 'required' | 'outdated';
  runInWorktree?: boolean;
  baseBranch?: string;
  cleanupWorktree?: boolean;
  targetSessionId?: string;
};

export interface ScheduledTaskStateResult {
  task: ScheduledTask | null;
  tasks: ScheduledTask[];
  updated: boolean;
}

export interface ScheduledTaskConfig {
  listScheduledTasks: (projectID: string) => Promise<ScheduledTask[]>;
  updateScheduledTaskState: (projectID: string, taskID: string, patch: ScheduledTaskStatePatch) => Promise<ScheduledTaskStateResult>;
  updateScheduledTaskStateIf: (projectID: string, taskID: string, predicate: (task: ScheduledTask) => boolean, patch: ScheduledTaskStatePatch) => Promise<ScheduledTaskStateResult>;
}

export interface ScheduledWorktreeCleanup {
  projectID: string;
  projectDirectory: string;
  worktreeDirectory: string;
  directoryIdentity: string;
  sessionID: string;
  branch: string | null;
  startedAt: number;
  ownerPID: number;
  ownerInstance?: string | undefined;
  phase: 'waiting' | 'removing';
}

export interface ScheduledTaskInput {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  schedule?: unknown;
  execution?: unknown;
  state?: unknown;
  targetSessionId?: unknown;
  runInWorktree?: unknown;
  baseBranch?: unknown;
  cleanupWorktree?: unknown;
  loopFile?: unknown;
}

export interface ScheduledTaskStore extends ScheduledTaskConfig {
  upsertScheduledTask: (projectID: string, input: ScheduledTaskInput) => Promise<{ task: ScheduledTask; tasks: ScheduledTask[]; created: boolean }>;
  reconcileLoopTasks: (projectID: string, loops: Awaited<ReturnType<typeof discoverLoops>>) => Promise<ScheduledTask[]>;
  listScheduledWorktreeCleanups: () => Promise<ScheduledWorktreeCleanup[]>;
  saveScheduledWorktreeCleanup: (projectID: string, record: Omit<ScheduledWorktreeCleanup, 'projectID'>) => Promise<ScheduledWorktreeCleanup>;
  finishScheduledWorktreeCleanup: (projectID: string, sessionID: string, remove: ((record: ScheduledWorktreeCleanup, resumingRemoval: boolean) => Promise<void>) | null, options: { signal: AbortSignal }) => Promise<boolean>;
}

export interface ScheduledTaskStatePatch {
  createdAt?: unknown;
  updatedAt?: unknown;
  lastStatus?: unknown;
  lastRunAt?: unknown;
  lastDurationMs?: unknown;
  nextRunAt?: unknown;
  lastScheduledFor?: unknown;
  waitingForFolder?: unknown;
  lastSessionId?: unknown;
  lastError?: unknown;
  lastRunIsolated?: unknown;
  lastRunBranch?: unknown;
}

export type DirectoryValidation =
  | { ok: true; directory: string }
  | { ok: false; error: string; directory?: never };

export interface SessionProjectDependencies {
  validateDirectoryPath: (directory: string) => Promise<DirectoryValidation>;
  openCodeTrust: Pick<OpenCodeTrust, 'assess'>;
  registerSessionProject: (resolve: (projects: SessionProject[]) => Promise<SessionProject>) => Promise<SessionProject>;
  resolveSessionDirectory: SessionDirectoryResolver;
  moveSession: (sessionID: string, directory: string) => Promise<void>;
  emitWorktreeChanged?: (event: { directories: string[]; at: number }) => void;
  linkedWorktreeRoot?: (directory: string) => Promise<string | null>;
}
