import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { expandSnippets } from '../opencode/snippets.js';
import { parseScheduledCommandPrompt } from '../scheduled-tasks/runtime.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const splitModel = (value) => {
  const model = asNonEmptyString(value);
  if (!model) return null;
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) return null;
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
};

const runPromptAsync = async ({ baseUrl, authHeaders, sessionID, directory, payload }) => {
  const promptUrl = new URL(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async`);
  promptUrl.searchParams.set('directory', directory);
  const response = await fetch(promptUrl.toString(), {
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`prompt_async failed (${response.status})${body ? `: ${body}` : ''}`);
  }
};

const resolveRequestedDirectory = async ({ payload, readSettingsFromDiskMigrated, sanitizeProjects, validateDirectoryPath }) => {
  const projectID = asNonEmptyString(payload?.projectId) || asNonEmptyString(payload?.projectID);
  if (projectID) {
    const settings = await readSettingsFromDiskMigrated();
    const projects = sanitizeProjects(settings?.projects || []);
    const project = projects.find((entry) => entry.id === projectID) || null;
    if (!project?.path) {
      return { ok: false, status: 404, error: 'Project not found' };
    }
    const validated = await validateDirectoryPath(project.path);
    return validated.ok
      ? { ok: true, directory: validated.directory, projectId: projectID }
      : { ok: false, status: 400, error: validated.error || 'Invalid project directory' };
  }

  const directory = asNonEmptyString(payload?.directory);
  const validated = await validateDirectoryPath(directory);
  return validated.ok
    ? { ok: true, directory: validated.directory }
    : { ok: false, status: 400, error: validated.error || 'Invalid directory' };
};

export const registerOpenChamberSessionRoutes = (app, dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    validateDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    emitSessionCreatedEvent,
  } = dependencies;

  app.post('/api/openchamber/sessions', async (req, res) => {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const title = asNonEmptyString(payload.title);
    const prompt = asNonEmptyString(payload.prompt);
    const model = splitModel(payload.model)
      || (asNonEmptyString(payload.providerID) && asNonEmptyString(payload.modelID)
        ? { providerID: asNonEmptyString(payload.providerID), modelID: asNonEmptyString(payload.modelID) }
        : null);
    const agent = asNonEmptyString(payload.agent);
    const variant = asNonEmptyString(payload.variant);

    if (prompt && !model) {
      return res.status(400).json({ error: 'model is required when prompt is provided' });
    }

    try {
      const resolvedDirectory = await resolveRequestedDirectory({
        payload,
        readSettingsFromDiskMigrated,
        sanitizeProjects,
        validateDirectoryPath,
      });
      if (!resolvedDirectory.ok) {
        return res.status(resolvedDirectory.status || 400).json({ error: resolvedDirectory.error });
      }

      if (typeof waitForOpenCodeReady === 'function') {
        await waitForOpenCodeReady(10_000, 250);
      }

      const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
      const authHeaders = getOpenCodeAuthHeaders();
      const client = createOpencodeClient({ baseUrl, headers: authHeaders });
      const sessionResponse = await client.session.create({
        directory: resolvedDirectory.directory,
        ...(title ? { title } : {}),
      });
      const sessionID = sessionResponse?.data?.id;
      if (!sessionID) {
        throw new Error('failed to create session');
      }

      let promptDispatched = false;
      let dispatchedAsCommand = false;
      if (prompt && model) {
        const parsedCommand = parseScheduledCommandPrompt(prompt);
        if (parsedCommand) {
          try {
            const response = await client.command.list({ directory: resolvedDirectory.directory });
            const commands = Array.isArray(response?.data) ? response.data : [];
            if (commands.some((command) => command?.name === parsedCommand.command)) {
              await client.session.command({
                sessionID,
                directory: resolvedDirectory.directory,
                command: parsedCommand.command,
                arguments: parsedCommand.arguments,
                ...(agent ? { agent } : {}),
                model: `${model.providerID}/${model.modelID}`,
                ...(variant ? { variant } : {}),
              });
              promptDispatched = true;
              dispatchedAsCommand = true;
            }
          } catch {
          }
        }

        if (!promptDispatched) {
          await runPromptAsync({
            baseUrl,
            authHeaders,
            sessionID,
            directory: resolvedDirectory.directory,
            payload: {
              model,
              ...(agent ? { agent } : {}),
              ...(variant ? { variant } : {}),
              parts: [{ type: 'text', text: expandSnippets(prompt, resolvedDirectory.directory) }],
            },
          });
          promptDispatched = true;
        }
      }

      const result = {
        sessionId: sessionID,
        directory: resolvedDirectory.directory,
        ...(resolvedDirectory.projectId ? { projectId: resolvedDirectory.projectId } : {}),
        ...(title ? { title } : {}),
        promptDispatched,
        dispatchedAsCommand,
      };

      try {
        emitSessionCreatedEvent?.({
          sessionID,
          directory: resolvedDirectory.directory,
          ...(resolvedDirectory.projectId ? { projectID: resolvedDirectory.projectId } : {}),
          ...(title ? { title } : {}),
          promptDispatched,
          dispatchedAsCommand,
          createdAt: Date.now(),
        });
      } catch {
      }

      return res.json(result);
    } catch (error) {
      console.error('[OpenChamberSessions] failed to create session:', error);
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create session' });
    }
  });
};
