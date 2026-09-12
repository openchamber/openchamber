/**
 * Client for the project setup routes: worktree setup commands, project
 * actions, and pinned draft starters.
 *
 * A project's setup is the merge of two files the server (or the VS Code
 * extension host) owns: the personal one in `~/.config/openchamber/projects/`
 * and, when a team shares it, `<repo>/.openchamber/project.json`. The merged
 * view says what runs; its `shared` and `personal` blocks say where each
 * entry came from, so a Settings page edits the personal block and never
 * copies a teammate's entry into it. This module only speaks HTTP: it
 * resolves no home directory and composes no path, so the same code serves
 * web, desktop, VS Code, and the phone, including a phone driving a remote
 * instance.
 *
 * Reads keep the contract callers were written against: a failed read logs
 * and resolves to the empty setup, because worktree creation and the new
 * session screen must keep working when the config cannot be fetched.
 * Writes resolve `false` on failure.
 */

import { z } from 'zod';

import { sanitizeStarterRefs, type DraftStarterRef } from './draftStarters';
import { createProjectIdFromPath } from './projectId';
import { runtimeFetch } from './runtime-fetch';

type ProjectRef = { id: string; path: string };

type OpenChamberProjectActionPlatform = 'macos' | 'linux' | 'windows';

/** Where a merged entry came from: the repo's shared file or the user's own file. */
export type ProjectSetupSource = 'shared' | 'personal';

export interface OpenChamberProjectAction {
  id: string;
  name: string;
  command: string;
  icon?: string | null;
  runIn?: 'parent';
  platforms?: OpenChamberProjectActionPlatform[];
  autoOpenUrl?: boolean;
  openUrl?: string;
  desktopOpenSshForward?: string;
  /** Present on merged entries only. */
  source?: ProjectSetupSource;
}

export interface OpenChamberProjectActionsState {
  actions: OpenChamberProjectAction[];
  primaryActionId: string | null;
}

export type ProjectDraftStarter = DraftStarterRef & { source: ProjectSetupSource };

/** The view the server returns; the server sanitizes, the client only checks the shape. */
const sourceSchema = z.enum(['shared', 'personal']);

const projectActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  icon: z.string().nullable().optional(),
  runIn: z.literal('parent').optional(),
  platforms: z.array(z.enum(['macos', 'linux', 'windows'])).optional(),
  autoOpenUrl: z.literal(true).optional(),
  openUrl: z.string().optional(),
  desktopOpenSshForward: z.string().optional(),
});

const starterRefsSchema = z.unknown().transform((value) => sanitizeStarterRefs(value));

const sourcedStartersSchema = z.array(z.object({
  type: z.enum(['command', 'skill']),
  name: z.string().min(1),
  source: sourceSchema,
}));

const sharedSchema = z.object({
  status: z.enum(['missing', 'ok', 'invalid']),
  reason: z.string().optional(),
  path: z.string(),
  setupWorktree: z.array(z.string()),
  setupWorktreeWait: z.boolean().nullable(),
  projectActions: z.array(projectActionSchema),
  draftStarters: starterRefsSchema,
  plansDir: z.string().nullable(),
});

const personalSchema = z.object({
  setupWorktree: z.array(z.string()),
  setupWorktreeWait: z.boolean().nullable(),
  setupWorktreeMode: z.enum(['append', 'replace']),
  projectActions: z.array(projectActionSchema),
  projectActionsPrimaryId: z.string().nullable(),
  draftStarters: starterRefsSchema,
  hiddenSharedActionIds: z.array(z.string()),
  sharedTrust: z.object({ hash: z.string(), trustedAt: z.number() }).nullable(),
});

const projectSetupSchema = z.object({
  /** Nothing to trust when `hash` is null; otherwise trusted only for the recorded hash. */
  trust: z.object({ hash: z.string().nullable(), trusted: z.boolean() }),
  setupWorktree: z.array(z.string()),
  setupWorktreeWait: z.boolean(),
  projectActions: z.array(projectActionSchema.extend({ source: sourceSchema })),
  projectActionsPrimaryId: z.string().nullable(),
  draftStarters: sourcedStartersSchema,
  shared: sharedSchema,
  personal: personalSchema,
});

export type ProjectSetup = z.infer<typeof projectSetupSchema>;

/** What a client may change: the personal file only. */
export type ProjectSetupPatch = Partial<{
  setupWorktree: string[];
  setupWorktreeWait: boolean;
  setupWorktreeMode: 'append' | 'replace';
  projectActions: OpenChamberProjectAction[];
  projectActionsPrimaryId: string | null;
  draftStarters: DraftStarterRef[];
  hiddenSharedActionIds: string[];
  /** The trust answer for the shared commands with this hash; `null` forgets it. */
  sharedTrustHash: string | null;
}>;

const EMPTY_PROJECT_SETUP: ProjectSetup = {
  trust: { hash: null, trusted: true },
  setupWorktree: [],
  setupWorktreeWait: false,
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  shared: {
    status: 'missing',
    path: '.openchamber/project.json',
    setupWorktree: [],
    setupWorktreeWait: null,
    projectActions: [],
    draftStarters: [],
    plansDir: null,
  },
  personal: {
    setupWorktree: [],
    setupWorktreeWait: null,
    setupWorktreeMode: 'append',
    projectActions: [],
    projectActionsPrimaryId: null,
    draftStarters: [],
    hiddenSharedActionIds: [],
    sharedTrust: null,
  },
};

/**
 * The storage id is derived from the project path, not from `project.id`:
 * project ids in settings have churned across versions, and the path-derived
 * id is what names the config file on disk and locates the checkout.
 */
const resolveProjectSetupId = (project: ProjectRef): string => {
  const projectPath = typeof project?.path === 'string' ? project.path.trim() : '';
  return projectPath ? createProjectIdFromPath(projectPath) : '';
};

const endpointFor = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/config`;

const parseSetupResponse = async (response: Response): Promise<ProjectSetup> => {
  const parsed = projectSetupSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Project config response has an unexpected shape');
  }
  return parsed.data;
};

/** The project's merged setup, or the empty setup when it cannot be read. */
export async function getProjectSetup(project: ProjectRef): Promise<ProjectSetup> {
  const projectId = resolveProjectSetupId(project);
  if (!projectId) return EMPTY_PROJECT_SETUP;
  try {
    const response = await runtimeFetch(endpointFor(projectId), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await parseSetupResponse(response);
  } catch (error) {
    console.warn('Failed to read project config:', error);
    return EMPTY_PROJECT_SETUP;
  }
}

/** Change the personal part of the project's setup. */
export async function updateProjectSetup(project: ProjectRef, patch: ProjectSetupPatch): Promise<boolean> {
  const projectId = resolveProjectSetupId(project);
  if (!projectId) return false;
  try {
    const response = await runtimeFetch(endpointFor(projectId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...patch, projectPath: project.path.trim() }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    await parseSetupResponse(response);
    return true;
  } catch (error) {
    console.warn('Failed to save project config:', error);
    return false;
  }
}

/** What a client may change in the team's shared file; every named key replaces the current value. */
export type SharedProjectSetupPatch = Partial<{
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  projectActions: OpenChamberProjectAction[];
  draftStarters: DraftStarterRef[];
  plansDir: string | null;
}>;

/**
 * Change the team's shared file in the checkout (`<repo>/.openchamber/project.json`).
 * The server removes the file when nothing is left in it, and records trust
 * for the commands this instance just shared. Resolves the merged view, or
 * `null` on failure so a caller can tell "saved nothing" from "saved and empty".
 */
export async function updateSharedProjectSetup(project: ProjectRef, patch: SharedProjectSetupPatch): Promise<ProjectSetup | null> {
  const projectId = resolveProjectSetupId(project);
  if (!projectId) return null;
  const body: SharedProjectSetupPatch = { ...patch };
  if (patch.projectActions) body.projectActions = patch.projectActions.map(withoutSource);
  try {
    const response = await runtimeFetch(`${endpointFor(projectId)}/shared`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await parseSetupResponse(response);
  } catch (error) {
    console.warn('Failed to save the shared project config:', error);
    return null;
  }
}

/**
 * The commands a new worktree runs: shared first, then personal (or personal
 * only in replace mode). Code that is about to run them goes through
 * `resolveWorktreeSetupCommands` in `lib/sharedTrustConfirmation.ts` instead,
 * which asks for trust the first time the shared ones would run.
 */
export async function getWorktreeSetupCommands(project: ProjectRef): Promise<string[]> {
  return (await getProjectSetup(project)).setupWorktree;
}

export async function saveWorktreeSetupCommands(project: ProjectRef, commands: string[]): Promise<boolean> {
  return updateProjectSetup(project, { setupWorktree: commands.filter((cmd) => cmd.trim().length > 0) });
}

export async function getWorktreeSetupWaitEnabled(project: ProjectRef): Promise<boolean> {
  return (await getProjectSetup(project)).setupWorktreeWait;
}

export async function saveWorktreeSetupWaitEnabled(project: ProjectRef, enabled: boolean): Promise<boolean> {
  return updateProjectSetup(project, { setupWorktreeWait: enabled });
}

/** The starters pinned for this project, shared ones first, each marked with its source. */
export async function getProjectDraftStarters(project: ProjectRef): Promise<ProjectDraftStarter[]> {
  return (await getProjectSetup(project)).draftStarters;
}

/** Replace the user's own project starters; shared ones are untouched. */
export async function saveProjectDraftStarters(project: ProjectRef, starters: DraftStarterRef[]): Promise<boolean> {
  return updateProjectSetup(project, { draftStarters: sanitizeStarterRefs(starters) });
}

/** The actions the project offers to run: merged, each marked with its source. */
export async function getProjectActionsState(project: ProjectRef): Promise<OpenChamberProjectActionsState> {
  const setup = await getProjectSetup(project);
  return { actions: setup.projectActions, primaryActionId: setup.projectActionsPrimaryId };
}

/** Replace the user's own project actions; shared ones are untouched. */
export async function saveProjectActionsState(
  project: ProjectRef,
  value: OpenChamberProjectActionsState,
): Promise<boolean> {
  return updateProjectSetup(project, {
    projectActions: value.actions.map(withoutSource),
    projectActionsPrimaryId: value.primaryActionId,
  });
}

/** The source mark is the server's to add; it never travels back in a write. */
const withoutSource = (action: OpenChamberProjectAction): OpenChamberProjectAction => {
  const copy = { ...action };
  delete copy.source;
  return copy;
};

/**
 * Substitute variables in a command string.
 * Supported variables:
 * - $ROOT_PROJECT_PATH: The root project directory path
 * - $ROOT_WORKTREE_PATH: Legacy alias for $ROOT_PROJECT_PATH
 */
export function substituteCommandVariables(
  command: string,
  variables: { rootWorktreePath: string }
): string {
  return command
    // New preferred name
    .replace(/\$ROOT_PROJECT_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_PROJECT_PATH\}/g, variables.rootWorktreePath)
    // Legacy
    .replace(/\$ROOT_WORKTREE_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_WORKTREE_PATH\}/g, variables.rootWorktreePath);
}

export type { ProjectRef };
