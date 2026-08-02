import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const OPENCODE_PROJECT_COMMAND_TIMEOUT_MS = 8_000;

const unavailableProjectCommandResult = () => ({ available: false, command: '' });
const availableProjectCommandResult = (command) => ({
  available: true,
  command: typeof command === 'string' ? command.trim() : '',
});

const normalizeProjectDirectoryForCompare = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? path.resolve(text) : '';
};

const getProjectDirectory = (project) => {
  for (const key of ['worktree', 'directory', 'path', 'root']) {
    const value = normalizeProjectDirectoryForCompare(project?.[key]);
    if (value) return value;
  }
  return '';
};

const extractProjectStartCommand = (project) => {
  const command = project?.commands?.start;
  return typeof command === 'string' ? command : '';
};

const hasProjectID = (project, projectID) => {
  const id = typeof project?.id === 'string' ? project.id.trim() : '';
  return Boolean(id && id === projectID);
};

const hasProjectDirectory = (project, primaryWorktree) => {
  const projectDirectory = getProjectDirectory(project);
  return Boolean(projectDirectory && projectDirectory === normalizeProjectDirectoryForCompare(primaryWorktree));
};

const findListedProject = (projects, projectID, primaryWorktree) => {
  return projects.find((project) => hasProjectID(project, projectID))
    || projects.find((project) => hasProjectDirectory(project, primaryWorktree))
    || null;
};

const combineAbortSignals = (existingSignal, timeoutSignal) => {
  if (!existingSignal) return timeoutSignal;
  if (!timeoutSignal) return existingSignal;
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

const getRequestSignal = (request) => {
  return request instanceof Request ? request.signal : undefined;
};

export const createOpenCodeProjectCommandRuntime = (dependencies = {}) => {
  const {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodePort,
  } = dependencies;

  const loadStartCommand = async (projectID, primaryWorktree) => {
    if (typeof getOpenCodePort === 'function' && !getOpenCodePort()) {
      return unavailableProjectCommandResult();
    }
    if (typeof buildOpenCodeUrl !== 'function' || typeof getOpenCodeAuthHeaders !== 'function') {
      return unavailableProjectCommandResult();
    }

    try {
      const client = createOpencodeClient({
        baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
        directory: primaryWorktree || undefined,
        headers: getOpenCodeAuthHeaders(),
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
        return availableProjectCommandResult(extractProjectStartCommand(currentProject));
      }

      const listResponse = await client.project.list({ directory: primaryWorktree });
      const projects = Array.isArray(listResponse?.data) ? listResponse.data : [];
      const matchedProject = findListedProject(projects, projectID, primaryWorktree);
      if (matchedProject) {
        return availableProjectCommandResult(extractProjectStartCommand(matchedProject));
      }
    } catch {
      return unavailableProjectCommandResult();
    }

    return unavailableProjectCommandResult();
  };

  return { loadStartCommand };
};
