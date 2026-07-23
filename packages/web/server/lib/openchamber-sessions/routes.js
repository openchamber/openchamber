import express from 'express';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createWorktree } from '../git/index.js';
import { expandSnippets } from '../opencode/snippets.js';
import { parseScheduledCommandPrompt } from '../scheduled-tasks/runtime.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';

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

const resolveRequestedModel = (payload) => {
  const model = splitModel(payload?.model);
  if (model) return model;

  const providerID = asNonEmptyString(payload?.providerID);
  const modelID = asNonEmptyString(payload?.modelID);
  return providerID && modelID ? { providerID, modelID } : null;
};

const FALLBACK_PROVIDER_ID = 'opencode';
const FALLBACK_MODEL_ID = 'big-pickle';
const MIN_GOAL_TOKEN_BUDGET = 1_000;
const MAX_GOAL_TOKEN_BUDGET = 100_000_000;

const resolveGoalInput = (payload, prompt) => {
  const enabled = payload?.goal === true;
  if (payload?.goalTokenBudget !== undefined && !enabled) {
    return { ok: false, error: 'goalTokenBudget requires goal' };
  }
  if (enabled && !prompt) {
    return { ok: false, error: 'prompt is required when goal is enabled' };
  }
  if (payload?.goalTokenBudget === undefined) {
    return { ok: true, enabled, tokenBudget: null };
  }
  const tokenBudget = payload.goalTokenBudget;
  if (!Number.isSafeInteger(tokenBudget)
    || tokenBudget < MIN_GOAL_TOKEN_BUDGET
    || tokenBudget > MAX_GOAL_TOKEN_BUDGET) {
    return { ok: false, error: `goalTokenBudget must be an integer from ${MIN_GOAL_TOKEN_BUDGET} to ${MAX_GOAL_TOKEN_BUDGET}` };
  }
  return { ok: true, enabled, tokenBudget };
};

const isPrimaryAgentMode = (mode) => !mode || mode === 'primary' || mode === 'all';

const providerModels = (provider) => {
  if (Array.isArray(provider?.models)) return provider.models;
  if (provider?.models && typeof provider.models === 'object') return Object.values(provider.models);
  return [];
};

const hasProviderModel = (providers, providerID, modelID) => {
  return providers.some((provider) => provider?.id === providerID
    && providerModels(provider).some((model) => model?.id === modelID));
};

const resolveVariant = (providers, providerID, modelID, variant) => {
  const normalized = asNonEmptyString(variant);
  if (!normalized) return undefined;
  const provider = providers.find((entry) => entry?.id === providerID);
  const model = providerModels(provider).find((entry) => entry?.id === modelID);
  return model?.variants && Object.prototype.hasOwnProperty.call(model.variants, normalized)
    ? normalized
    : undefined;
};

const parseConfigModel = (value) => splitModel(value);

const buildDirectoryHeaders = (directory) => ({
  ...(directory ? { 'x-opencode-directory': directory } : {}),
});

const fetchJson = async (url, authHeaders, fallback, directory) => {
  const response = await fetch(url.toString(), {
    headers: { ...authHeaders, ...buildDirectoryHeaders(directory), accept: 'application/json' },
  });
  if (!response.ok) return fallback;
  return response.json().catch(() => fallback);
};

const fetchSelectionInputs = async ({ buildOpenCodeUrl, authHeaders, directory, readSettingsFromDiskMigrated }) => {
  const settings = await readSettingsFromDiskMigrated();
  const providersUrl = new URL(buildOpenCodeUrl('/config/providers', ''));
  providersUrl.searchParams.set('directory', directory);
  const agentsUrl = new URL(buildOpenCodeUrl('/agent', ''));
  agentsUrl.searchParams.set('directory', directory);
  const configUrl = new URL(buildOpenCodeUrl('/config', ''));
  configUrl.searchParams.set('directory', directory);

  const [providersBody, agentsBody, configBody] = await Promise.all([
    fetchJson(providersUrl, authHeaders, { providers: [] }, directory),
    fetchJson(agentsUrl, authHeaders, [], directory),
    fetchJson(configUrl, authHeaders, {}, directory),
  ]);

  return {
    settings,
    providers: Array.isArray(providersBody?.providers) ? providersBody.providers : [],
    agents: Array.isArray(agentsBody) ? agentsBody : [],
    opencodeDefaultAgent: asNonEmptyString(configBody?.default_agent) || asNonEmptyString(configBody?.defaultAgent),
    opencodeDefaultModel: asNonEmptyString(configBody?.model),
  };
};

const resolveDefaultSelection = ({ agents, providers, settings, opencodeDefaultAgent, opencodeDefaultModel }) => {
  const primaryAgents = agents.filter((agent) => isPrimaryAgentMode(agent?.mode) && agent?.hidden !== true);
  let resolvedAgent = null;
  const settingsDefaultAgent = asNonEmptyString(settings?.defaultAgent);
  if (settingsDefaultAgent) {
    resolvedAgent = agents.find((agent) => agent?.name === settingsDefaultAgent) || null;
  }
  if (!resolvedAgent && opencodeDefaultAgent) {
    const candidate = agents.find((agent) => agent?.name === opencodeDefaultAgent) || null;
    if (candidate && isPrimaryAgentMode(candidate.mode) && candidate.hidden !== true) {
      resolvedAgent = candidate;
    }
  }
  if (!resolvedAgent) {
    resolvedAgent = primaryAgents.find((agent) => agent?.name === 'build') || primaryAgents[0] || agents[0] || null;
  }

  let model = null;
  let variant;
  const settingsDefaultModel = parseConfigModel(settings?.defaultModel);
  if (settingsDefaultModel && hasProviderModel(providers, settingsDefaultModel.providerID, settingsDefaultModel.modelID)) {
    model = settingsDefaultModel;
    variant = resolveVariant(providers, model.providerID, model.modelID, settings?.defaultVariant);
  }

  if (!model && resolvedAgent?.model?.providerID && resolvedAgent?.model?.modelID
    && hasProviderModel(providers, resolvedAgent.model.providerID, resolvedAgent.model.modelID)) {
    model = { providerID: resolvedAgent.model.providerID, modelID: resolvedAgent.model.modelID };
    variant = resolveVariant(providers, model.providerID, model.modelID, resolvedAgent.variant);
  }

  const opencodeModel = parseConfigModel(opencodeDefaultModel);
  if (!model && opencodeModel && hasProviderModel(providers, opencodeModel.providerID, opencodeModel.modelID)) {
    model = opencodeModel;
  }

  if (!model && hasProviderModel(providers, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID)) {
    model = { providerID: FALLBACK_PROVIDER_ID, modelID: FALLBACK_MODEL_ID };
  }

  if (!model) {
    const provider = providers[0];
    const firstModel = providerModels(provider)[0];
    if (provider?.id && firstModel?.id) {
      model = { providerID: provider.id, modelID: firstModel.id };
    }
  }

  return {
    agent: resolvedAgent?.name,
    model,
    variant,
  };
};

const runPromptAsync = async ({ baseUrl, authHeaders, sessionID, directory, payload }) => {
  const promptUrl = new URL(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async`);
  promptUrl.searchParams.set('directory', directory);
  const response = await fetch(promptUrl.toString(), {
    method: 'POST',
    headers: {
      ...authHeaders,
      ...buildDirectoryHeaders(directory),
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

const createSession = async ({ baseUrl, authHeaders, directory, title }) => {
  const sessionUrl = new URL(`${baseUrl}/session`);
  sessionUrl.searchParams.set('directory', directory);
  const response = await fetch(sessionUrl.toString(), {
    method: 'POST',
    headers: {
      ...authHeaders,
      ...buildDirectoryHeaders(directory),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ directory, ...(title ? { title } : {}) }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`session create failed (${response.status})${body ? `: ${body}` : ''}`);
  }

  const body = await response.json().catch(() => null);
  const sessionID = body?.id || body?.data?.id;
  if (!sessionID) {
    throw new Error('failed to create session');
  }
  return sessionID;
};

const forkSession = async ({ client, sessionID, directory, messageID }) => {
  const response = await client.session.fork({
    sessionID,
    directory,
    ...(messageID ? { messageID } : {}),
  });
  const session = response?.data;
  if (!session?.id) {
    throw new Error('failed to fork session');
  }
  return session;
};

const latestCompletedAssistantMessageID = async ({ client, sessionID, directory }) => {
  let response;
  try {
    response = await client.session.messages({ sessionID, directory, limit: 100 });
  } catch {
    return null;
  }
  const messages = Array.isArray(response?.data) ? response.data : [];
  let latest = null;
  for (const message of messages) {
    const info = message?.info;
    if (info?.role !== 'assistant' || !Number.isFinite(info?.time?.completed)) continue;
    if (!latest || (info.time.created || 0) >= (latest.time?.created || 0)) latest = info;
  }
  return asNonEmptyString(latest?.id);
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

const resolveWorktreeInput = (payload) => {
  if (!payload?.worktree || typeof payload.worktree !== 'object') return null;
  const name = asNonEmptyString(payload.worktree.name);
  if (!name) return null;
  const branchName = asNonEmptyString(payload.worktree.branchName);
  const startRef = asNonEmptyString(payload.worktree.startRef);
  return {
    mode: 'new',
    name,
    ...(branchName ? { branchName } : {}),
    ...(startRef ? { startRef } : {}),
    ...(typeof payload.setUpstream === 'boolean' ? { setUpstream: payload.setUpstream } : {}),
  };
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
    createSessionGoal: createSessionGoalOverride,
  } = dependencies;

  const dispatchPrompt = async ({
    client,
    baseUrl,
    authHeaders,
    sessionID,
    directory,
    prompt,
    goalInput,
    requestedModel,
    requestedAgent,
    requestedVariant,
  }) => {
    let model = requestedModel;
    let agent = requestedAgent;
    let variant = requestedVariant;
    if (!model || !agent || !variant) {
      const inputs = await fetchSelectionInputs({
        buildOpenCodeUrl,
        authHeaders,
        directory,
        readSettingsFromDiskMigrated,
      });
      const defaults = resolveDefaultSelection(inputs);
      model = model || defaults.model;
      agent = agent || defaults.agent;
      variant = variant || (requestedModel ? undefined : defaults.variant);
    }
    if (!model) {
      const error = new Error('No model is configured or available for the requested directory');
      error.statusCode = 400;
      throw error;
    }

    const expandedPrompt = expandSnippets(prompt, directory);
    if (goalInput.enabled) {
      await (createSessionGoalOverride || createSessionGoal)({
        baseUrl,
        authHeaders,
        sessionID,
        directory,
        objective: expandedPrompt,
        tokenBudget: goalInput.tokenBudget,
        providerID: model.providerID,
        modelID: model.modelID,
        onWarning: (message, error) => console.warn(`[OpenChamberSessions] ${message}:`, error?.message || error),
      });
    }

    const markGoalPartial = (error) => {
      if (goalInput.enabled && error && typeof error === 'object') error.goalConfigured = true;
      return error;
    };

    let dispatchedAsCommand = false;
    const parsedCommand = parseScheduledCommandPrompt(prompt);
    if (parsedCommand) {
      let commandExists = false;
      try {
        const response = await client.command.list({ directory });
        const commands = Array.isArray(response?.data) ? response.data : [];
        commandExists = commands.some((command) => command?.name === parsedCommand.command);
      } catch {
      }
      if (commandExists) {
        try {
          await client.session.command({
            sessionID,
            directory,
            command: parsedCommand.command,
            arguments: parsedCommand.arguments,
            ...(agent ? { agent } : {}),
            model: `${model.providerID}/${model.modelID}`,
            ...(variant ? { variant } : {}),
          });
        } catch (error) {
          throw markGoalPartial(error);
        }
        dispatchedAsCommand = true;
      }
    }

    if (!dispatchedAsCommand) {
      try {
        await runPromptAsync({
          baseUrl,
          authHeaders,
          sessionID,
          directory,
          payload: {
            model,
            ...(agent ? { agent } : {}),
            ...(variant ? { variant } : {}),
            parts: [
              { type: 'text', text: expandedPrompt },
              ...(goalInput.enabled
                ? [{ type: 'text', text: buildGoalIntroText(goalInput.tokenBudget), synthetic: true }]
                : []),
            ],
          },
        });
      } catch (error) {
        throw markGoalPartial(error);
      }
    }

    return { model, agent, variant, promptDispatched: true, dispatchedAsCommand };
  };

  app.post('/api/openchamber/sessions', express.json({ limit: '1mb' }), async (req, res) => {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const title = asNonEmptyString(payload.title);
    const prompt = asNonEmptyString(payload.prompt);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) {
      return res.status(400).json({ error: goalInput.error });
    }
    const model = resolveRequestedModel(payload);
    const agent = asNonEmptyString(payload.agent);
    const variant = asNonEmptyString(payload.variant);

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

      const worktreeInput = resolveWorktreeInput(payload);
      let worktree = null;
      let sessionDirectory = resolvedDirectory.directory;
      if (payload?.worktree && !worktreeInput) {
        return res.status(400).json({ error: 'worktree.name is required when worktree is provided' });
      }
      if (worktreeInput) {
        worktree = await createWorktree(resolvedDirectory.directory, worktreeInput);
        sessionDirectory = worktree.path;
      }

      if (typeof waitForOpenCodeReady === 'function') {
        await waitForOpenCodeReady(10_000, 250);
      }

      const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
      const authHeaders = getOpenCodeAuthHeaders();
      const client = createOpencodeClient({ baseUrl, headers: authHeaders });
      const sessionID = await createSession({
        client,
        baseUrl,
        authHeaders,
        directory: sessionDirectory,
        ...(title ? { title } : {}),
      });

      let dispatch = {
        model,
        agent,
        variant,
        promptDispatched: false,
        dispatchedAsCommand: false,
      };
      if (prompt) {
        dispatch = await dispatchPrompt({
          client,
          baseUrl,
          authHeaders,
          sessionID,
          directory: sessionDirectory,
          prompt,
          goalInput,
          requestedModel: model,
          requestedAgent: agent,
          requestedVariant: variant,
        });
      }

      const result = {
        sessionId: sessionID,
        directory: sessionDirectory,
        ...(resolvedDirectory.projectId ? { projectId: resolvedDirectory.projectId } : {}),
        ...(title ? { title } : {}),
        ...(worktree ? { worktree } : {}),
        ...(prompt && dispatch.model ? { model: dispatch.model } : {}),
        ...(prompt && dispatch.agent ? { agent: dispatch.agent } : {}),
        ...(prompt && dispatch.variant ? { variant: dispatch.variant } : {}),
        promptDispatched: dispatch.promptDispatched,
        dispatchedAsCommand: dispatch.dispatchedAsCommand,
        ...(goalInput.enabled ? { goalEnabled: true } : {}),
        ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
      };

      try {
        emitSessionCreatedEvent?.({
          sessionID,
          directory: sessionDirectory,
          ...(resolvedDirectory.projectId ? { projectID: resolvedDirectory.projectId } : {}),
          ...(title ? { title } : {}),
          ...(worktree ? { worktree } : {}),
          ...(prompt && dispatch.model ? { model: dispatch.model } : {}),
          ...(prompt && dispatch.agent ? { agent: dispatch.agent } : {}),
          ...(prompt && dispatch.variant ? { variant: dispatch.variant } : {}),
          promptDispatched: dispatch.promptDispatched,
          dispatchedAsCommand: dispatch.dispatchedAsCommand,
          ...(goalInput.enabled ? { goalEnabled: true } : {}),
          ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
          createdAt: Date.now(),
        });
      } catch {
      }

      return res.json(result);
    } catch (error) {
      console.error('[OpenChamberSessions] failed to create session:', error);
      const statusCode = Number(error?.statusCode) || 500;
      return res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Failed to create session' });
    }
  });

  const handleExistingSessionAction = (action) => async (req, res) => {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const sourceSessionID = asNonEmptyString(req.params.sessionId);
    const prompt = asNonEmptyString(payload.prompt);
    if (!sourceSessionID) return res.status(400).json({ error: 'sessionId is required' });
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) return res.status(400).json({ error: goalInput.error });
    const requestedModel = resolveRequestedModel(payload);

    let targetSessionID = sourceSessionID;
    let targetSession = null;
    let directory = null;
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
      directory = resolvedDirectory.directory;
      if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);

      const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
      const authHeaders = getOpenCodeAuthHeaders();
      const client = createOpencodeClient({ baseUrl, headers: authHeaders });
      if (action === 'fork') {
        targetSession = await forkSession({
          client,
          sessionID: sourceSessionID,
          directory,
          messageID: asNonEmptyString(payload.messageId) || undefined,
        });
        targetSessionID = targetSession.id;
      }

      const baselineAssistantMessageId = await latestCompletedAssistantMessageID({
        client,
        sessionID: targetSessionID,
        directory,
      });

      const dispatch = await dispatchPrompt({
        client,
        baseUrl,
        authHeaders,
        sessionID: targetSessionID,
        directory,
        prompt,
        goalInput,
        requestedModel,
        requestedAgent: asNonEmptyString(payload.agent),
        requestedVariant: asNonEmptyString(payload.variant),
      });
      const result = {
        action,
        sessionId: targetSessionID,
        directory,
        ...(action === 'fork' ? { sourceSessionId: sourceSessionID } : {}),
        ...(targetSession?.title ? { title: targetSession.title } : {}),
        ...(baselineAssistantMessageId ? { baselineAssistantMessageId } : {}),
        model: dispatch.model,
        ...(dispatch.agent ? { agent: dispatch.agent } : {}),
        ...(dispatch.variant ? { variant: dispatch.variant } : {}),
        promptDispatched: true,
        dispatchedAsCommand: dispatch.dispatchedAsCommand,
        ...(goalInput.enabled ? { goalEnabled: true } : {}),
        ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
      };

      if (action === 'fork') {
        try {
          emitSessionCreatedEvent?.({
            sessionID: targetSessionID,
            directory,
            sourceSessionID,
            ...(targetSession?.title ? { title: targetSession.title } : {}),
            model: dispatch.model,
            ...(dispatch.agent ? { agent: dispatch.agent } : {}),
            ...(dispatch.variant ? { variant: dispatch.variant } : {}),
            promptDispatched: true,
            dispatchedAsCommand: dispatch.dispatchedAsCommand,
            ...(goalInput.enabled ? { goalEnabled: true } : {}),
            ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
            createdAt: Date.now(),
          });
        } catch {
        }
      }
      return res.json(result);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      const forkCreated = action === 'fork' && targetSessionID !== sourceSessionID;
      const goalConfigured = error?.goalConfigured === true;
      console.error(`[OpenChamberSessions] failed to ${action} session:`, error);
      return res.status(statusCode).json({
        error: error instanceof Error ? error.message : `Failed to ${action} session`,
        ...(forkCreated || goalConfigured
          ? {
            partial: true,
            partialAction: forkCreated ? 'fork-created' : 'goal-configured',
            sessionId: targetSessionID,
            directory,
          }
          : {}),
      });
    }
  };

  app.post(
    '/api/openchamber/sessions/:sessionId/send',
    express.json({ limit: '1mb' }),
    handleExistingSessionAction('send'),
  );
  app.post(
    '/api/openchamber/sessions/:sessionId/fork',
    express.json({ limit: '1mb' }),
    handleExistingSessionAction('fork'),
  );
};
