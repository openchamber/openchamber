import * as path from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const OPENCODE_PROJECT_COMMAND_TIMEOUT_MS = 8_000;

export type ProjectCommandResult =
  | { available: true; command: string }
  | { available: false; command: '' };

export interface ProjectCommandRuntime {
  loadStartCommand(projectID: string, primaryWorktree: string): Promise<ProjectCommandResult>;
}

export interface ProjectCommandRuntimeDependencies {
  getApiUrl?: () => string | null;
  getOpenCodeAuthHeaders?: () => Record<string, string>;
  createClient?: typeof createOpencodeClient;
}

const unavailableProjectCommandResult = (): ProjectCommandResult => ({ available: false, command: '' });

const availableProjectCommandResult = (command: unknown): ProjectCommandResult => ({
  available: true,
  command: typeof command === 'string' ? command.trim() : '',
});

const normalizeProjectDirectoryForCompare = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? path.resolve(text) : '';
};

const getProjectDirectory = (project: unknown): string => {
  if (!project || typeof project !== 'object') return '';
  const record = project as Record<string, unknown>;
  for (const key of ['worktree', 'directory', 'path', 'root']) {
    const value = normalizeProjectDirectoryForCompare(record[key]);
    if (value) return value;
  }
  return '';
};

const getProjectID = (project: unknown): string => {
  if (!project || typeof project !== 'object') return '';
  const id = (project as { id?: unknown }).id;
  return typeof id === 'string' ? id.trim() : '';
};

const getProjectStartCommand = (project: unknown): unknown => {
  if (!project || typeof project !== 'object') return '';
  const commands = (project as { commands?: unknown }).commands;
  if (!commands || typeof commands !== 'object') return '';
  return (commands as { start?: unknown }).start;
};

const hasProjectID = (project: unknown, projectID: string): boolean => {
  const id = getProjectID(project);
  return Boolean(id && id === projectID);
};

const hasProjectDirectory = (project: unknown, primaryWorktree: string): boolean => {
  const projectDirectory = getProjectDirectory(project);
  return Boolean(projectDirectory && projectDirectory === normalizeProjectDirectoryForCompare(primaryWorktree));
};

const findListedProject = (projects: unknown[], projectID: string, primaryWorktree: string): unknown | null => {
  return projects.find((project) => hasProjectID(project, projectID))
    || projects.find((project) => hasProjectDirectory(project, primaryWorktree))
    || null;
};

const combineAbortSignals = (existingSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): AbortSignal => {
  if (!existingSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([existingSignal, timeoutSignal]);
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (existingSignal.aborted || timeoutSignal.aborted) {
    abort();
    return controller.signal;
  }
  existingSignal.addEventListener('abort', abort, { once: true });
  timeoutSignal.addEventListener('abort', abort, { once: true });
  return controller.signal;
};

const getRequestSignal = (request: Parameters<typeof fetch>[0]): AbortSignal | undefined => {
  return request instanceof Request ? request.signal : undefined;
};

export const createOpenCodeProjectCommandRuntime = (
  dependencies: ProjectCommandRuntimeDependencies = {},
): ProjectCommandRuntime => {
  const loadStartCommand = async (projectID: string, primaryWorktree: string): Promise<ProjectCommandResult> => {
    const apiUrl = dependencies.getApiUrl?.();
    if (!apiUrl) {
      return unavailableProjectCommandResult();
    }

    try {
      const client = (dependencies.createClient ?? createOpencodeClient)({
        baseUrl: apiUrl.replace(/\/$/, ''),
        directory: primaryWorktree || undefined,
        headers: dependencies.getOpenCodeAuthHeaders?.() || {},
        fetch: (request) => globalThis.fetch(request, {
          signal: combineAbortSignals(
            getRequestSignal(request),
            AbortSignal.timeout(OPENCODE_PROJECT_COMMAND_TIMEOUT_MS),
          ),
        }),
      });

      const currentResponse = await client.project.current({ directory: primaryWorktree });
      const currentProject = currentResponse?.data;
      if (currentProject && (hasProjectID(currentProject, projectID) || hasProjectDirectory(currentProject, primaryWorktree))) {
        return availableProjectCommandResult(getProjectStartCommand(currentProject));
      }

      const listResponse = await client.project.list({ directory: primaryWorktree });
      const projects = Array.isArray(listResponse?.data) ? listResponse.data : [];
      const matchedProject = findListedProject(projects, projectID, primaryWorktree);
      if (matchedProject) {
        return availableProjectCommandResult(getProjectStartCommand(matchedProject));
      }
    } catch {
      return unavailableProjectCommandResult();
    }

    return unavailableProjectCommandResult();
  };

  return { loadStartCommand };
};
