import express from 'express';
import {
  createWorktree as createWorktreeDefault,
  getWorktreeBootstrapStatus as getWorktreeBootstrapStatusDefault,
  resolvePrimaryWorktreeRoot,
} from '../git/index.js';
import { expandSnippets } from '../opencode/snippets.js';
import { AUTO_MODEL_REF, isAutoModel } from '../routing/defaults.js';
import { parseScheduledCommandPrompt } from '../scheduled-tasks/runtime.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';
import { OpenChamberControlError, asControlError } from '../openchamber-control/error.js';
import { readObjective, writeObjective } from '../session-goal/objectives.js';
import { createArchiveStore } from './archive-store.js';
import { applyForkInheritance } from './fork-inheritance.js';
import { createOpenCodeClient as defaultCreateOpenCodeClient } from './opencode-client.js';
import { createSessionMetadataStore, createOpenCodeSessionMetadata } from './session-metadata-store.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asList = (value) => (Array.isArray(value) ? value : []);

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

// OpenCode 2.x serves one flat model catalogue instead of models nested under
// providers: every entry already names its provider.
const hasCatalogModel = (models, providerID, modelID) => models.some(
  (model) => model?.providerID === providerID && model?.modelID === modelID,
);

const findCatalogModel = (models, providerID, modelID) => models.find(
  (model) => model?.providerID === providerID && model?.modelID === modelID,
) || null;

const resolveVariant = (models, providerID, modelID, variant) => {
  const normalized = asNonEmptyString(variant);
  if (!normalized) return undefined;
  const model = findCatalogModel(models, providerID, modelID);
  // A model the catalog does not know yet (cold or unreachable) keeps the
  // user's saved variant instead of losing it to a discovery gap.
  if (!model) return normalized;
  return asList(model.variants).some((entry) => entry?.id === normalized) ? normalized : undefined;
};

// Config `model` is either "providerID/modelID" or the expanded object form.
const parseConfigModel = (value) => {
  if (typeof value === 'string') return splitModel(value);
  const providerID = asNonEmptyString(value?.providerID);
  const modelID = asNonEmptyString(value?.model);
  return providerID && modelID ? { providerID, modelID } : null;
};

const resolveProjectDefaults = (settings, directory, projectId) => {
  const projects = Array.isArray(settings?.projects) ? settings.projects : [];
  const matchedProject = projectId
    ? projects.find((entry) => entry?.id === projectId) || null
    : projects.find((entry) => entry?.path === directory) || null;
  return {
    defaultAgent: asNonEmptyString(matchedProject?.defaultAgent),
    defaultModel: asNonEmptyString(matchedProject?.defaultModel),
    defaultVariant: asNonEmptyString(matchedProject?.defaultVariant),
  };
};

/** `x-opencode-directory` is how v2 scopes a request; there is no query param. */
/**
 * Everything the default model/agent resolution needs, from one directory-scoped
 * client. A failed lookup answers empty on purpose: an empty catalogue means
 * "unknown", and callers must never turn that into a rejection.
 */
const fetchSelectionInputs = async ({ client, readSettingsFromDiskMigrated }) => {
  const settings = await readSettingsFromDiskMigrated();
  const [models, agents, configEntries] = await Promise.all([
    client.model.list().then((response) => asList(response?.data)).catch(() => []),
    // v2 agents carry `id` (`build`, what prompts and sessions refer to) and a
    // display `name` (`Build`); every lookup here is by id.
    client.agent.list().then((response) => asList(response?.data)).catch(() => []),
    client.config.get().then((response) => asList(response)).catch(() => []),
  ]);

  // Config entries arrive lowest priority first, so the last definition wins.
  let opencodeDefaultAgent = null;
  let opencodeDefaultModel = null;
  for (const entry of configEntries) {
    const info = entry?.info;
    if (!info) continue;
    const agent = asNonEmptyString(info.default_agent);
    if (agent) opencodeDefaultAgent = agent;
    const model = parseConfigModel(info.model);
    if (model) opencodeDefaultModel = model;
  }

  return { settings, models, agents, opencodeDefaultAgent, opencodeDefaultModel };
};

const resolveDefaultSelection = ({ agents, models, settings, projectDefaults, opencodeDefaultAgent, opencodeDefaultModel }) => {
  const primaryAgents = agents.filter((agent) => isPrimaryAgentMode(agent?.mode) && agent?.hidden !== true);
  let resolvedAgent = null;
  const projectDefaultAgent = asNonEmptyString(projectDefaults?.defaultAgent);
  const settingsDefaultAgent = asNonEmptyString(settings?.defaultAgent);
  // The project's default agent wins over the global one. v1 stored the agent's
  // display name; v2 agents are addressed by id (`build` vs `Build`), so a
  // setting saved before the upgrade still resolves.
  const findAgentBySetting = (wantedName) => {
    const wanted = wantedName.toLowerCase();
    return agents.find((agent) => agent?.id === wantedName)
      || agents.find((agent) => typeof agent?.name === 'string' && agent.name.toLowerCase() === wanted)
      || agents.find((agent) => typeof agent?.id === 'string' && agent.id.toLowerCase() === wanted)
      || null;
  };
  if (projectDefaultAgent) resolvedAgent = findAgentBySetting(projectDefaultAgent);
  if (!resolvedAgent && settingsDefaultAgent) resolvedAgent = findAgentBySetting(settingsDefaultAgent);
  if (!resolvedAgent && opencodeDefaultAgent) {
    const candidate = agents.find((agent) => agent?.id === opencodeDefaultAgent) || null;
    if (candidate && isPrimaryAgentMode(candidate.mode) && candidate.hidden !== true) {
      resolvedAgent = candidate;
    }
  }
  if (!resolvedAgent) {
    resolvedAgent = primaryAgents.find((agent) => agent?.id === 'build') || primaryAgents[0] || agents[0] || null;
  }

  let model = null;
  let variant;
  const projectDefaultModel = parseConfigModel(projectDefaults?.defaultModel);
  const settingsDefaultModel = parseConfigModel(settings?.defaultModel);
  // A saved choice is honoured even when the catalog has not listed it yet: a
  // discovery gap must not silently move the user onto another model.
  if (projectDefaultModel) {
    model = projectDefaultModel;
    variant = resolveVariant(models, model.providerID, model.modelID, projectDefaults?.defaultVariant);
  }
  if (!model && settingsDefaultModel) {
    model = settingsDefaultModel;
    variant = resolveVariant(models, model.providerID, model.modelID, settings?.defaultVariant);
  }

  // An agent's model is a v2 `ModelRef`: `id` is the model id, not a composite.
  const agentModel = resolvedAgent?.model;
  if (!model && asNonEmptyString(agentModel?.providerID) && asNonEmptyString(agentModel?.id)) {
    model = { providerID: agentModel.providerID, modelID: agentModel.id };
    variant = resolveVariant(models, model.providerID, model.modelID, agentModel.variant);
  }

  if (!model && opencodeDefaultModel) {
    model = opencodeDefaultModel;
  }

  if (!model && hasCatalogModel(models, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID)) {
    model = { providerID: FALLBACK_PROVIDER_ID, modelID: FALLBACK_MODEL_ID };
  }

  if (!model) {
    const first = models[0];
    if (asNonEmptyString(first?.providerID) && asNonEmptyString(first?.modelID)) {
      model = { providerID: first.providerID, modelID: first.modelID };
    }
  }

  return {
    agent: resolvedAgent?.id,
    model,
    variant,
  };
};

/**
 * v2 selects model and agent per session, not per prompt: the choice is
 * switched once and then persists, so every dispatch sets it explicitly rather
 * than passing it alongside the prompt.
 */
const applySessionSelection = async ({ client, sessionID, model, agent, variant }) => {
  if (model) {
    await client.session.switchModel({
      sessionID,
      model: { id: model.modelID, providerID: model.providerID, ...(variant ? { variant } : {}) },
    });
  }
  if (agent) await client.session.switchAgent({ sessionID, agent });
};

const createSession = async ({ client, directory, title }) => {
  const session = await client.session.create({
    location: { directory },
    ...(title ? { title } : {}),
  });
  const sessionID = asNonEmptyString(session?.id);
  if (!sessionID) throw new Error('failed to create session');
  return sessionID;
};

const forkSession = async ({ client, sessionID, messageID }) => {
  const session = await client.session.fork({
    sessionID,
    // OpenCode 2.0.8 replaced the SessionForkBoundary object with an optional
    // `before` message id. Omitting it carries the whole session over, which is
    // what the old `{ type: 'through' }` boundary meant.
    ...(messageID ? { before: messageID } : {}),
  });
  if (!asNonEmptyString(session?.id)) throw new Error('failed to fork session');
  return session;
};

const listMessages = async ({ client, sessionID, limit }) => {
  const response = await client.message.list({ sessionID, limit, order: 'desc' });
  return asList(response?.data);
};

const latestCompletedAssistantMessageID = async ({ client, sessionID }) => {
  let messages;
  try {
    messages = await listMessages({ client, sessionID, limit: 100 });
  } catch {
    return null;
  }
  let latest = null;
  for (const message of messages) {
    if (message?.type !== 'assistant' || !Number.isFinite(message?.time?.completed)) continue;
    if (!latest || (message.time.created || 0) >= (latest.time?.created || 0)) latest = message;
  }
  return asNonEmptyString(latest?.id);
};

/**
 * Upper bound on one archive batch.
 *
 * The batch is a bounded amount of work on one request, and callers with more
 * sessions than this send several batches and keep their own partial results.
 */
const MAX_ARCHIVE_BATCH = 500;

const parseIdBatch = (payload) => {
  const rawIds = payload?.ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return { ok: false, error: 'ids must be a non-empty array of session ids' };
  }
  if (rawIds.length > MAX_ARCHIVE_BATCH) {
    return { ok: false, error: `ids must contain at most ${MAX_ARCHIVE_BATCH} session ids` };
  }

  const ids = [];
  for (const value of rawIds) {
    const id = asNonEmptyString(value);
    if (!id) return { ok: false, error: 'ids must contain non-empty session ids' };
    ids.push(id);
  }
  return { ok: true, ids };
};

const parseArchiveRequest = (payload) => {
  const parsed = parseIdBatch(payload);
  if (!parsed.ok) return parsed;

  const archivedAt = payload?.archivedAt;
  if (archivedAt !== undefined && (!Number.isSafeInteger(archivedAt) || archivedAt <= 0)) {
    return { ok: false, error: 'archivedAt must be a positive integer timestamp' };
  }

  return { ok: true, ids: parsed.ids, archivedAt: archivedAt ?? Date.now() };
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
  if (!validated.ok) return { ok: false, status: 400, error: validated.error || 'Invalid directory' };
  const settings = await readSettingsFromDiskMigrated();
  const projects = sanitizeProjects(settings?.projects || []);
  let project = projects.find((entry) => entry.path === validated.directory);
  if (!project && projects.length > 0) {
    const { root } = await resolvePrimaryWorktreeRoot(validated.directory);
    project = projects.find((entry) => entry.path === root);
  }
  return { ok: true, directory: validated.directory, ...(project ? { projectId: project.id } : {}) };
};

// createWorktree returns while the worktree is still being populated in the
// background (git reset --hard after a --no-checkout add). Dispatching a
// prompt into a half-populated directory makes opencode's run die with
// UnknownError (agent and config files are not there yet), so wait until the
// bootstrap reaches git-ready (population done) or fails before creating the
// session and dispatching.
const WORKTREE_BOOTSTRAP_TIMEOUT_MS = 60_000;
const WORKTREE_BOOTSTRAP_POLL_MS = 150;

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

export const createOpenChamberSessionService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    validateDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    emitSessionCreatedEvent,
    broadcastGlobalUiEvent,
    createSessionGoal: createSessionGoalOverride,
    sessionKnowledgeRuntime = null,
    dataDir = null,
    archiveStore: injectedArchiveStore = null,
    sessionMetadataStore: injectedSessionMetadataStore = null,
    // Injected by the server so every metadata write takes the same path:
    // store, broadcast, and tell the goal loop. Falls back to store+broadcast
    // when it is absent, which is what module tests use.
    persistSessionMetadata = null,
    createOpenCodeClient = defaultCreateOpenCodeClient,
    createWorktree = createWorktreeDefault,
    getWorktreeBootstrapStatus = getWorktreeBootstrapStatusDefault,
    // Auto routing. Sessions dispatched here talk to OpenCode through the SDK,
    // not through the proxy that intercepts the Auto sentinel, so a default of
    // `openchamber/auto` (Session Defaults) is resolved here before the
    // session is switched onto it. Null when routing is not wired in.
    resolveAutoSelection = null,
  } = dependencies;

  if ((!injectedArchiveStore || !injectedSessionMetadataStore) && !dataDir) {
    throw new Error('openchamber session routes need either both stores or a dataDir');
  }
  const archiveStore = injectedArchiveStore || createArchiveStore({ dataDir });
  const sessionMetadataStore = injectedSessionMetadataStore || createSessionMetadataStore({
    dataDir,
    openCode: createOpenCodeSessionMetadata({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      createOpenCodeClient,
    }),
  });

  const openCodeBaseUrl = () => buildOpenCodeUrl('/', '').replace(/\/$/, '');
  const clientFor = (directory) => createOpenCodeClient({
    baseUrl: openCodeBaseUrl(),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });

  const waitForWorktreeBootstrapReady = async ({ directory }) => {
    const deadline = Date.now() + WORKTREE_BOOTSTRAP_TIMEOUT_MS;
    for (;;) {
      const status = await getWorktreeBootstrapStatus(directory);
      if (status?.status === 'failed') {
        throw new OpenChamberControlError(`Worktree bootstrap failed: ${status.error || 'unknown error'}`, 500);
      }
      const phase = status?.phase;
      if (status?.status === 'ready' || phase === 'git-ready' || phase === 'setup-ready') return;
      if (Date.now() >= deadline) {
        throw new OpenChamberControlError('Timed out waiting for the worktree bootstrap', 500);
      }
      await new Promise((resolve) => setTimeout(resolve, WORKTREE_BOOTSTRAP_POLL_MS));
    }
  };

  /**
   * The selection an existing session already runs on. v2 keeps it on the
   * session record, so there is no need to walk the message history for it.
   */
  const fetchSessionSelection = async ({ client, sessionID }) => {
    try {
      const session = await client.session.get({ sessionID });
      const providerID = asNonEmptyString(session?.model?.providerID);
      const modelID = asNonEmptyString(session?.model?.id);
      return {
        model: providerID && modelID ? { providerID, modelID } : null,
        agent: asNonEmptyString(session?.agent),
        variant: asNonEmptyString(session?.model?.variant),
      };
    } catch {
      return null;
    }
  };

  // An unknown agent or model makes the run fail after the prompt is accepted,
  // leaving a session with no answer. Reject them before any session, worktree,
  // or goal side effect happens.
  const validateRequestedSelection = async ({ directory, requestedModel, requestedAgent, requestedVariant }) => {
    if (!requestedModel && !requestedAgent && !requestedVariant) return;
    const { models, agents } = await fetchSelectionInputs({
      client: clientFor(directory),
      readSettingsFromDiskMigrated,
    });

    // An empty list means the lookup failed or returned nothing authoritative;
    // it must not turn a valid selection into a rejection.
    if (requestedAgent && agents.length > 0) {
      const agent = agents.find((entry) => entry?.id === requestedAgent) || null;
      if (!agent) {
        throw new OpenChamberControlError(`Unknown agent '${requestedAgent}' for ${directory}`, 400);
      }
      if (!isPrimaryAgentMode(agent.mode)) {
        throw new OpenChamberControlError(`Agent '${requestedAgent}' is a subagent and cannot receive a prompt directly`, 400);
      }
    }

    if (requestedModel && models.length > 0) {
      if (!hasCatalogModel(models, requestedModel.providerID, requestedModel.modelID)) {
        throw new OpenChamberControlError(
          `Unknown model '${requestedModel.providerID}/${requestedModel.modelID}' for ${directory}`,
          400,
        );
      }
      if (requestedVariant
        && !resolveVariant(models, requestedModel.providerID, requestedModel.modelID, requestedVariant)) {
        throw new OpenChamberControlError(
          `Unknown variant '${requestedVariant}' for model '${requestedModel.providerID}/${requestedModel.modelID}'`,
          400,
        );
      }
    }
  };

  const dispatchPrompt = async ({
    client,
    baseUrl,
    authHeaders,
    sessionID,
    directory,
    projectId,
    prompt,
    goalInput,
    requestedModel,
    requestedAgent,
    requestedVariant,
    reuseSessionSelection = false,
  }) => {
    let model = requestedModel;
    let agent = requestedAgent;
    let variant = requestedVariant;
    if (reuseSessionSelection && (!model || !agent)) {
      const previous = await fetchSessionSelection({ client, sessionID });
      if (previous) {
        if (!model && previous.model) {
          model = previous.model;
          if (variant == null) variant = previous.variant ?? undefined;
        }
        if (!agent && previous.agent) agent = previous.agent;
      }
    }
    if (!model || !agent) {
      const inputs = await fetchSelectionInputs({ client, readSettingsFromDiskMigrated });
      const defaults = resolveDefaultSelection({
        ...inputs,
        projectDefaults: resolveProjectDefaults(inputs.settings, directory, projectId),
      });
      if (!model) {
        model = defaults.model;
        if (variant == null) variant = defaults.variant;
      }
      agent = agent || defaults.agent;
    }
    if (!model) {
      const error = new Error('No model is configured or available for the requested directory');
      error.statusCode = 400;
      throw error;
    }

    const expandedPrompt = expandSnippets(prompt, directory);
    if (isAutoModel(model)) {
      // The sentinel must never reach OpenCode: neither the goal record nor the
      // session switch below may carry it.
      if (!resolveAutoSelection) {
        throw new OpenChamberControlError('Auto routing is not available on this server. Choose a model.', 400);
      }
      const routed = await resolveAutoSelection({
        sessionId: sessionID,
        directory,
        model: AUTO_MODEL_REF,
        agent: agent ?? null,
        requestText: expandedPrompt,
      });
      model = { providerID: routed.model.providerID, modelID: routed.model.id };
      variant = routed.model.variant ?? undefined;
      agent = routed.agent || agent;
    }
    const parsedCommand = parseScheduledCommandPrompt(prompt);
    let resolvedCommand = null;
    if (parsedCommand) {
      try {
        const response = await client.command.list();
        const commands = asList(response?.data);
        if (commands.some((candidate) => candidate?.name === parsedCommand.command)) {
          resolvedCommand = parsedCommand;
        }
      } catch {
      }
    }
    if (goalInput.enabled) {
      // v2 no longer publishes a command's template, so a slash command's goal
      // objective is the prompt the user typed rather than the expanded body.
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
        // v2 has no session-metadata route, so the goal record goes to
        // OpenChamber's own store — the same one the proxy overlays back.
        persistSessionGoal: async (goalSessionID, goalDirectory, goal) => {
          await writeMetadata(goalSessionID, { openchamber: { goal } }, goalDirectory);
        },
      });
    }

    const markGoalPartial = (error) => {
      if (goalInput.enabled && error && typeof error === 'object') error.goalConfigured = true;
      return error;
    };

    try {
      await applySessionSelection({ client, sessionID, model, agent, variant });
    } catch (error) {
      throw markGoalPartial(error);
    }

    // A session the agent dispatched has no UI to attach the project's
    // standing context, so it is asked for here. Never fails the dispatch:
    // a session that runs without its background beats one that never runs.
    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime.resolvePendingForSession(sessionID, directory)
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };
    // After the send is accepted, so a rejected dispatch carries it again.
    const recordKnowledge = async () => {
      if (knowledge.text && sessionKnowledgeRuntime) {
        await sessionKnowledgeRuntime.recordDelivered(sessionID, directory, knowledge.signature)
          .catch(() => undefined);
      }
    };

    if (resolvedCommand) {
      try {
        // The command route takes no extra parts, so the context goes in
        // first as a synthetic message that does not start execution.
        if (knowledge.text) {
          await client.session.synthetic({ sessionID, text: knowledge.text, resume: false });
        }
        await client.session.command({
          sessionID,
          // OpenCode 2.0.8 renamed the command body field `command` to `name`.
          name: resolvedCommand.command,
          text: resolvedCommand.arguments || '',
        });
      } catch (error) {
        throw markGoalPartial(error);
      }
      await recordKnowledge();
    } else {
      let landedMessageID = null;
      try {
        if (knowledge.text) {
          await client.session.synthetic({ sessionID, text: knowledge.text, resume: false });
        }
        const sent = await client.session.prompt({ sessionID, text: expandedPrompt });
        landedMessageID = asNonEmptyString(sent?.id);
        if (goalInput.enabled) {
          // Goal mode's reminder refers to "the user message above", so it is
          // admitted after the prompt; v2 has no way to append to one message.
          await client.session.synthetic({
            sessionID,
            text: buildGoalIntroText(goalInput.tokenBudget),
            resume: false,
          });
        }
      } catch (error) {
        throw markGoalPartial(error);
      }
      await recordKnowledge();
      if (!landedMessageID) {
        // v2 answers a prompt with the inbox item it recorded. No item id means
        // nothing is queued, so the dispatch must not be claimed as done.
        return {
          model,
          agent,
          variant,
          promptDispatched: false,
          dispatchedAsCommand: false,
          promptError: 'OpenCode accepted the prompt but returned no queued message',
        };
      }
    }

    return { model, agent, variant, promptDispatched: true, dispatchedAsCommand: Boolean(resolvedCommand) };
  };

  const broadcastMetadata = (sessionID, metadata) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:session-metadata',
      properties: { sessionID, metadata },
    });
  };

  /**
   * Merge-patch a session's OpenChamber metadata on its OpenCode record: the
   * per-session state of goal mode, session assist, obligatory context and
   * pinned notes. The broadcast carries the full merged object, because a
   * client that missed an earlier patch must not have to reconstruct it.
   */
  const writeMetadata = async (sessionID, patch, directory = '') => {
    if (typeof persistSessionMetadata === 'function') {
      return persistSessionMetadata(sessionID, patch, { directory });
    }
    const metadata = await sessionMetadataStore.setSessionMetadata(sessionID, patch, { directory });
    broadcastMetadata(sessionID, metadata);
    return metadata;
  };

  const setMetadata = async (sessionID, payload = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new OpenChamberControlError('a session id is required', 400);
    const patch = payload?.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new OpenChamberControlError('patch must be an object', 400);
    }

    return { metadata: await writeMetadata(id, patch, asNonEmptyString(payload?.directory) || '') };
  };

  const getMetadata = async (sessionID, directory = '') => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new OpenChamberControlError('a session id is required', 400);
    return { metadata: await sessionMetadataStore.get(id, { directory }) };
  };

  const broadcastArchived = (sessionID, archivedAt) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:session-archived',
      properties: { sessionID, archivedAt },
    });
  };

  /**
   * Archive a batch of sessions in one request.
   *
   * OpenCode 2.x has no route that sets `time.archived`, so the state is
   * OpenChamber's own: a JSON file beside the OpenCode instance, folded back
   * onto the session records the proxy serves. Batching matters for the same
   * reason it did before — the UI archives every session linked to a worktree
   * before removing it, and doing that one request at a time is what made
   * removing a busy worktree take tens of seconds.
   *
   * No directory is needed: archive state is keyed by session id per data dir.
   */
  const archive = async (payload = {}) => {
    const parsed = parseArchiveRequest(payload);
    if (!parsed.ok) {
      throw new OpenChamberControlError(parsed.error, 400);
    }

    const { archived, failedIds } = await archiveStore.archive(parsed.ids, parsed.archivedAt);
    for (const entry of archived) broadcastArchived(entry.id, entry.archivedAt);
    return { archived, failedIds };
  };

  /** Clears the archive flag for a batch. Mirrors `archive`. */
  const unarchive = async (payload = {}) => {
    const parsed = parseIdBatch(payload);
    if (!parsed.ok) {
      throw new OpenChamberControlError(parsed.error, 400);
    }

    const { restored, failedIds } = await archiveStore.unarchive(parsed.ids);
    for (const entry of restored) broadcastArchived(entry.id, null);
    return { restored, failedIds };
  };

  const create = async (payload = {}) => {
    const title = asNonEmptyString(payload.title);
    const prompt = asNonEmptyString(payload.prompt);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) {
      throw new OpenChamberControlError(goalInput.error, 400);
    }
    const model = resolveRequestedModel(payload);
    const agent = asNonEmptyString(payload.agent);
    const variant = asNonEmptyString(payload.variant);

    const resolvedDirectory = await resolveRequestedDirectory({
      payload,
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      validateDirectoryPath,
    });
    if (!resolvedDirectory.ok) {
      throw new OpenChamberControlError(resolvedDirectory.error, resolvedDirectory.status || 400);
    }

    const worktreeInput = resolveWorktreeInput(payload);
    let worktree = null;
    let sessionDirectory = resolvedDirectory.directory;
    if (payload?.worktree && !worktreeInput) {
      throw new OpenChamberControlError('worktree.name is required when worktree is provided', 400);
    }

    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);

    if (prompt) {
      await validateRequestedSelection({
        directory: resolvedDirectory.directory,
        requestedModel: model,
        requestedAgent: agent,
        requestedVariant: variant,
      });
    }

    if (worktreeInput) {
      worktree = await createWorktree(resolvedDirectory.directory, worktreeInput);
      sessionDirectory = worktree.path;
      await waitForWorktreeBootstrapReady({ directory: sessionDirectory });
    }

    const baseUrl = openCodeBaseUrl();
    const authHeaders = getOpenCodeAuthHeaders();
    const client = clientFor(sessionDirectory);
    const sessionID = await createSession({
      client,
      directory: sessionDirectory,
      ...(title ? { title } : {}),
    });

    let dispatch = { model, agent, variant, promptDispatched: false, dispatchedAsCommand: false };
    if (prompt) {
      dispatch = await dispatchPrompt({
        client,
        baseUrl,
        authHeaders,
        sessionID,
        directory: sessionDirectory,
        projectId: resolvedDirectory.projectId,
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
      ...(dispatch.promptError ? { promptError: dispatch.promptError } : {}),
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

    return result;
  };

  const runExisting = async (action, sourceSessionId, payload = {}) => {
    const sourceSessionID = asNonEmptyString(sourceSessionId);
    const prompt = asNonEmptyString(payload.prompt);
    if (!sourceSessionID) throw new OpenChamberControlError('sessionId is required', 400);
    if (!prompt) throw new OpenChamberControlError('prompt is required', 400);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) throw new OpenChamberControlError(goalInput.error, 400);
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
        throw new OpenChamberControlError(resolvedDirectory.error, resolvedDirectory.status || 400);
      }
      directory = resolvedDirectory.directory;
      if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);

      await validateRequestedSelection({
        directory,
        requestedModel,
        requestedAgent: asNonEmptyString(payload.agent),
        requestedVariant: asNonEmptyString(payload.variant),
      });

      const baseUrl = openCodeBaseUrl();
      const authHeaders = getOpenCodeAuthHeaders();
      const client = clientFor(directory);
      if (action === 'fork') {
        targetSession = await forkSession({
          client,
          sessionID: sourceSessionID,
          messageID: asNonEmptyString(payload.messageId) || undefined,
        });
        targetSessionID = targetSession.id;
        // Before the prompt goes out, so a goal armed by this dispatch writes
        // over the copied objective rather than the other way round.
        await applyForkInheritance({
          sourceSessionID,
          fork: targetSession,
          readObjective,
          writeObjective,
          writeMetadata: (sessionID, patch) => writeMetadata(sessionID, patch, directory),
        });
      }

      const baselineAssistantMessageId = await latestCompletedAssistantMessageID({
        client,
        sessionID: targetSessionID,
      });

      const dispatch = await dispatchPrompt({
        client,
        baseUrl,
        authHeaders,
        sessionID: targetSessionID,
        directory,
        projectId: resolvedDirectory.projectId,
        prompt,
        goalInput,
        requestedModel,
        requestedAgent: asNonEmptyString(payload.agent),
        requestedVariant: asNonEmptyString(payload.variant),
        reuseSessionSelection: true,
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
        promptDispatched: dispatch.promptDispatched,
        ...(dispatch.promptError ? { promptError: dispatch.promptError } : {}),
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
            promptDispatched: dispatch.promptDispatched,
            dispatchedAsCommand: dispatch.dispatchedAsCommand,
            ...(goalInput.enabled ? { goalEnabled: true } : {}),
            ...(goalInput.tokenBudget ? { goalTokenBudget: goalInput.tokenBudget } : {}),
            createdAt: Date.now(),
          });
        } catch {
        }
      }
      return result;
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      const forkCreated = action === 'fork' && targetSessionID !== sourceSessionID;
      const goalConfigured = error?.goalConfigured === true;
      throw new OpenChamberControlError(
        error instanceof Error ? error.message : `Failed to ${action} session`,
        statusCode,
        {
        ...(forkCreated || goalConfigured
          ? {
            partial: true,
            partialAction: forkCreated ? 'fork-created' : 'goal-configured',
            sessionId: targetSessionID,
            directory,
          }
          : {}),
        },
      );
    }
  };

  return {
    create,
    archive,
    unarchive,
    archiveStore,
    sessionMetadataStore,
    setMetadata,
    getMetadata,
    send: (sessionID, payload) => runExisting('send', sessionID, payload),
    fork: (sessionID, payload) => runExisting('fork', sessionID, payload),
  };
};

const sendServiceError = (res, error, fallback) => {
  const controlError = asControlError(error, fallback);
  return res.status(controlError.statusCode).json({
    error: controlError.message,
    ...(controlError.partial === true ? {
      partial: true,
      partialAction: controlError.partialAction,
      sessionId: controlError.sessionId,
      directory: controlError.directory,
    } : {}),
  });
};

export const registerOpenChamberSessionRoutes = (app, dependencies) => {
  const service = dependencies.sessionService || createOpenChamberSessionService(dependencies);

  app.post('/api/openchamber/sessions', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.create(req.body && typeof req.body === 'object' ? req.body : {}));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to create session:', error);
      return sendServiceError(res, error, 'Failed to create session');
    }
  });

  app.post('/api/openchamber/sessions/archive', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.archive(req.body && typeof req.body === 'object' ? req.body : {}));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to archive sessions:', error);
      return sendServiceError(res, error, 'Failed to archive sessions');
    }
  });

  app.get('/api/openchamber/sessions/:sessionId/metadata', async (req, res) => {
    try {
      return res.json(await service.getMetadata(
        req.params.sessionId,
        asNonEmptyString(req.query?.directory) || '',
      ));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to read session metadata:', error);
      return sendServiceError(res, error, 'Failed to read session metadata');
    }
  });

  app.post('/api/openchamber/sessions/:sessionId/metadata', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.setMetadata(
        req.params.sessionId,
        req.body && typeof req.body === 'object' ? req.body : {},
      ));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to store session metadata:', error);
      return sendServiceError(res, error, 'Failed to store session metadata');
    }
  });

  app.post('/api/openchamber/sessions/unarchive', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.unarchive(req.body && typeof req.body === 'object' ? req.body : {}));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to unarchive sessions:', error);
      return sendServiceError(res, error, 'Failed to unarchive sessions');
    }
  });

  app.post(
    '/api/openchamber/sessions/:sessionId/send',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        return res.json(await service.send(req.params.sessionId, req.body));
      } catch (error) {
        console.error('[OpenChamberSessions] failed to send session:', error);
        return sendServiceError(res, error, 'Failed to send session');
      }
    },
  );
  app.post(
    '/api/openchamber/sessions/:sessionId/fork',
    express.json({ limit: '1mb' }),
    async (req, res) => {
      try {
        return res.json(await service.fork(req.params.sessionId, req.body));
      } catch (error) {
        console.error('[OpenChamberSessions] failed to fork session:', error);
        return sendServiceError(res, error, 'Failed to fork session');
      }
    },
  );
};
