
import { z } from 'zod';

import { sanitizeStarterRefs, type DraftStarterRef } from './draftStarters';
import { createProjectIdFromPath } from './projectId';
import { runtimeFetch } from './runtime-fetch';

type ProjectRef = { id: string; path: string };

type OpenChamberProjectActionPlatform = 'macos' | 'linux' | 'windows';

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
  source?: ProjectSetupSource;
}

export interface OpenChamberProjectActionsState {
  actions: OpenChamberProjectAction[];
  primaryActionId: string | null;
}

export type ProjectDraftStarter = DraftStarterRef & { source: ProjectSetupSource };

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
  teardownWorktree: z.array(z.string()).default([]),
  projectActions: z.array(projectActionSchema),
  draftStarters: starterRefsSchema,
  plansDir: z.string().nullable(),
});

const personalSchema = z.object({
  setupWorktree: z.array(z.string()),
  setupWorktreeWait: z.boolean().nullable(),
  setupWorktreeMode: z.enum(['append', 'replace']),
  teardownWorktree: z.array(z.string()).default([]),
  createWorktreeCommand: z.string().default(''),
  projectActions: z.array(projectActionSchema),
  projectActionsPrimaryId: z.string().nullable(),
  draftStarters: starterRefsSchema,
  hiddenSharedActionIds: z.array(z.string()),
  sharedTrust: z.object({ hash: z.string(), trustedAt: z.number() }).nullable(),
  notesTodosInRepository: z.boolean().default(false),
});

const projectSetupSchema = z.object({
  trust: z.object({ hash: z.string().nullable(), trusted: z.boolean() }),
  setupWorktree: z.array(z.string()),
  setupWorktreeWait: z.boolean(),
  teardownWorktree: z.array(z.string()).default([]),
  projectActions: z.array(projectActionSchema.extend({ source: sourceSchema })),
  projectActionsPrimaryId: z.string().nullable(),
  draftStarters: sourcedStartersSchema,
  shared: sharedSchema,
  personal: personalSchema,
  platform: z.enum(['macos', 'linux', 'windows']).nullable().optional(),
});

export type ProjectSetup = z.infer<typeof projectSetupSchema>;

export type ProjectSetupPatch = Partial<{
  setupWorktree: string[];
  setupWorktreeWait: boolean;
  setupWorktreeMode: 'append' | 'replace';
  teardownWorktree: string[];
  createWorktreeCommand: string;
  projectActions: OpenChamberProjectAction[];
  projectActionsPrimaryId: string | null;
  draftStarters: DraftStarterRef[];
  hiddenSharedActionIds: string[];
  sharedTrustHash: string | null;
  notesTodosInRepository: boolean;
}>;

const EMPTY_PROJECT_SETUP: ProjectSetup = {
  trust: { hash: null, trusted: true },
  setupWorktree: [],
  setupWorktreeWait: false,
  teardownWorktree: [],
  projectActions: [],
  projectActionsPrimaryId: null,
  draftStarters: [],
  shared: {
    status: 'missing',
    path: '.openchamber/project.json',
    setupWorktree: [],
    setupWorktreeWait: null,
    teardownWorktree: [],
    projectActions: [],
    draftStarters: [],
    plansDir: null,
  },
  personal: {
    setupWorktree: [],
    setupWorktreeWait: null,
    setupWorktreeMode: 'append',
    teardownWorktree: [],
    createWorktreeCommand: '',
    projectActions: [],
    projectActionsPrimaryId: null,
    draftStarters: [],
    hiddenSharedActionIds: [],
    sharedTrust: null,
    notesTodosInRepository: false,
  },
};

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

export async function fetchProjectSetup(project: ProjectRef): Promise<ProjectSetup> {
  const projectId = resolveProjectSetupId(project);
  if (!projectId) return EMPTY_PROJECT_SETUP;
  const response = await runtimeFetch(endpointFor(projectId), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return parseSetupResponse(response);
}

export async function getProjectSetup(project: ProjectRef): Promise<ProjectSetup> {
  try {
    return await fetchProjectSetup(project);
  } catch (error) {
    console.warn('Failed to read project config:', error);
    return EMPTY_PROJECT_SETUP;
  }
}

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

export type SharedProjectSetupPatch = Partial<{
  setupWorktree: string[];
  setupWorktreeWait: boolean | null;
  teardownWorktree: string[];
  projectActions: OpenChamberProjectAction[];
  draftStarters: DraftStarterRef[];
  plansDir: string | null;
}>;

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

export async function getWorktreeSetupCommands(project: ProjectRef): Promise<string[]> {
  return (await getProjectSetup(project)).setupWorktree;
}

export async function getWorktreeCreateCommand(project: ProjectRef): Promise<string> {
  return (await getProjectSetup(project)).personal.createWorktreeCommand;
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

export async function getProjectDraftStarters(project: ProjectRef): Promise<ProjectDraftStarter[]> {
  return (await getProjectSetup(project)).draftStarters;
}

export async function saveProjectDraftStarters(project: ProjectRef, starters: DraftStarterRef[]): Promise<boolean> {
  return updateProjectSetup(project, { draftStarters: sanitizeStarterRefs(starters) });
}

export async function getProjectActionsState(project: ProjectRef): Promise<OpenChamberProjectActionsState> {
  const setup = await getProjectSetup(project);
  return { actions: setup.projectActions, primaryActionId: setup.projectActionsPrimaryId };
}

export async function saveProjectActionsState(
  project: ProjectRef,
  value: OpenChamberProjectActionsState,
): Promise<boolean> {
  return updateProjectSetup(project, {
    projectActions: value.actions.map(withoutSource),
    projectActionsPrimaryId: value.primaryActionId,
  });
}

const withoutSource = (action: OpenChamberProjectAction): OpenChamberProjectAction => {
  const copy = { ...action };
  delete copy.source;
  return copy;
};

export function substituteCommandVariables(
  command: string,
  variables: { rootWorktreePath: string }
): string {
  return command
    .replace(/\$ROOT_PROJECT_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_PROJECT_PATH\}/g, variables.rootWorktreePath)
    .replace(/\$ROOT_WORKTREE_PATH/g, variables.rootWorktreePath)
    .replace(/\$\{ROOT_WORKTREE_PATH\}/g, variables.rootWorktreePath);
}

export type { ProjectRef };
