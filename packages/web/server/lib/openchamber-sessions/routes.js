import { asNonEmptyString } from '../shared/guards.js';
import express from 'express';
import { z } from 'zod';
import path from 'node:path';
import {
  createWorktree as createWorktreeDefault,
  getBranches as getBranchesDefault,
  getPathsWithoutChanges as getPathsWithoutChangesDefault,
  getWorktreeBootstrapStatus as getWorktreeBootstrapStatusDefault,
  listStashes as listStashesDefault,
  removeWorktree as removeWorktreeDefault,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel as resolveWorktreeTopLevelDefault,
  stashApply as stashApplyDefault,
  stashDrop as stashDropDefault,
  stashPush as stashPushDefault,
  validateWorktreeDirectory as validateWorktreeDirectoryDefault,
  waitForActiveWorktreeBootstrap as waitForActiveWorktreeBootstrapDefault,
} from '../git/index.js';
import { expandSnippets } from '../opencode/snippets.js';
import { AUTO_MODEL_REF, isAutoModel } from '../routing/defaults.js';
import { parseScheduledCommandPrompt } from '../scheduled-tasks/runtime.js';
import { CHATS_SCOPE_PUBLIC_ID } from '../scheduled-tasks/chats-scope.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';
import { OpenChamberControlError, asControlError } from '../openchamber-control/error.js';
import { readObjective, writeObjective } from '../session-goal/objectives.js';
import { worktreeSetupOf } from '../projects/worktree-setup.js';
import { createArchiveStore } from './archive-store.js';
import { createOpenCodeSessionArchive, createSessionArchive } from './session-archive.js';
import { applyForkInheritance } from './fork-inheritance.js';
import { createOpenCodeClient as defaultCreateOpenCodeClient } from './opencode-client.js';
import { createSessionMetadataStore, createOpenCodeSessionMetadata } from './session-metadata-store.js';
import { createSession } from './create-session.js';
import { fetchSelectionInputs, fetchWarmSelectionInputs } from './selection-inputs.js';
import { buildLinkedIssuesPatch, parseLinkOperation } from './session-linked-issues.js';
import { createSessionWorktreeMover } from './worktree-move.js';
import { sessionParentId } from '../session-lineage.js';
import { listArchivedSubsessions } from './archived-subsessions.js';
import { createStartDirectoryResolver } from './worktree-start-directory.js';

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

// external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 The flat catalogue's selectable id can differ from the upstream modelID.
const findCatalogModel = (models, providerID, ref) => {
  const ofProvider = models.filter((model) => model?.providerID === providerID);
  return ofProvider.find((model) => model?.id === ref)
    || ofProvider.find((model) => model?.modelID === ref)
    || null;
};

const hasCatalogModel = (models, providerID, ref) => findCatalogModel(models, providerID, ref) !== null;

const isMissingFromCatalog = (models, model) => {
  if (models.length === 0 || isAutoModel(model)) return false;
  const entry = findCatalogModel(models, model.providerID, model.modelID);
  return !entry || entry.enabled === false;
};

const resolveVariant = (models, providerID, modelID, variant) => {
  const normalized = asNonEmptyString(variant);
  if (!normalized) return undefined;
  const model = findCatalogModel(models, providerID, modelID);
  if (!model) return normalized;
  return asList(model.variants).some((entry) => entry?.id === normalized) ? normalized : undefined;
};

const findAgentBySetting = (agents, wantedName) => {
  const wanted = asNonEmptyString(wantedName)?.toLowerCase();
  if (!wanted) return null;
  return agents.find((agent) => agent?.id === wantedName)
    || agents.find((agent) => typeof agent?.name === 'string' && agent.name.toLowerCase() === wanted)
    || agents.find((agent) => typeof agent?.id === 'string' && agent.id.toLowerCase() === wanted)
    || null;
};

const resolveSelectionVariant = ({
  settings,
  projectDefaults,
  agents,
  agentName,
  models,
  providerID,
  modelID,
}) => {
  const model = findCatalogModel(models, providerID, modelID);
  if (!model) return undefined;
  const offered = asList(model.variants)
    .map((entry) => asNonEmptyString(entry?.id))
    .filter(Boolean);
  if (offered.length === 0) return undefined;

  const agent = findAgentBySetting(agents, agentName);
  const agentModel = agent?.model;
  const agentVariant = agentModel?.providerID === providerID && agentModel?.id === modelID
    ? agentModel.variant
    : undefined;
  const projectDefaultModel = splitModel(projectDefaults?.defaultModel);
  const settingsDefaultModel = splitModel(settings?.defaultModel);
  const configuredVariant = projectDefaultModel?.providerID === providerID && projectDefaultModel.modelID === modelID
    ? projectDefaults?.defaultVariant ?? undefined
    : settingsDefaultModel?.providerID === providerID && settingsDefaultModel.modelID === modelID
      ? settings?.defaultVariant ?? undefined
      : undefined;
  const remembered = settings?.lastUsedEfforts?.[`${providerID}/${modelID}`];

  for (const source of [agentVariant, configuredVariant, remembered]) {
    if (source === null) return null;
    const parsed = z.enum(offered).safeParse(source);
    if (parsed.success) return parsed.data;
  }
  return undefined;
};

const isModelHidden = (hiddenModels, providerID, modelID) => hiddenModels.some(
  (hidden) => hidden?.providerID === providerID && hidden?.modelID === modelID,
);

const resolveFallbackModel = (models, hiddenModels) => {
  const isVisible = (providerID, modelID) => !isModelHidden(hiddenModels, providerID, modelID);
  const candidates = models.filter(
    (entry) => asNonEmptyString(entry?.providerID) && asNonEmptyString(entry?.id),
  );
  const bigPickle = findCatalogModel(candidates, FALLBACK_PROVIDER_ID, FALLBACK_MODEL_ID);
  const pick = (bigPickle && isVisible(bigPickle.providerID, bigPickle.id) ? bigPickle : null)
    || candidates.find((entry) => isVisible(entry.providerID, entry.id))
    || bigPickle
    || candidates[0];
  return pick ? { providerID: pick.providerID, modelID: pick.id } : null;
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

const resolveDefaultSelection = ({ agents, models, settings, projectDefaults, config, autoAvailable, requireDefaultAgent }) => {
  const primaryAgents = agents.filter((agent) => isPrimaryAgentMode(agent?.mode) && agent?.hidden !== true);
  let resolvedAgent = null;
  const projectDefaultAgent = asNonEmptyString(projectDefaults?.defaultAgent);
  const settingsDefaultAgent = asNonEmptyString(settings?.defaultAgent);
  const opencodeDefaultAgent = config.defaultAgent;
  const opencodeDefaultModel = config.defaultModel;
  const configuredAgent = projectDefaultAgent || settingsDefaultAgent || opencodeDefaultAgent;
  if (requireDefaultAgent && configuredAgent && !findAgentBySetting(agents, configuredAgent)) {
    throw new OpenChamberControlError(`Configured agent '${configuredAgent}' is not available in this directory. Update the default agent in project/global settings or OpenCode config, or pass an explicit agent.`, 503);
  }
  if (projectDefaultAgent) resolvedAgent = findAgentBySetting(agents, projectDefaultAgent);
  if (!resolvedAgent && settingsDefaultAgent) resolvedAgent = findAgentBySetting(agents, settingsDefaultAgent);
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
  const projectDefaultModel = splitModel(projectDefaults?.defaultModel);
  const settingsDefaultModel = splitModel(settings?.defaultModel);
  const runnable = (candidate) => candidate && !isMissingFromCatalog(models, candidate);
  if (runnable(projectDefaultModel)) {
    model = projectDefaultModel;
    variant = resolveVariant(models, model.providerID, model.modelID, projectDefaults?.defaultVariant);
  }
  if (!model && runnable(settingsDefaultModel)) {
    model = settingsDefaultModel;
    variant = resolveVariant(models, model.providerID, model.modelID, settings?.defaultVariant);
  }

  const agentModel = resolvedAgent?.model;
  if (!model && asNonEmptyString(agentModel?.providerID) && asNonEmptyString(agentModel?.id)
    && runnable({ providerID: agentModel.providerID, modelID: agentModel.id })) {
    model = { providerID: agentModel.providerID, modelID: agentModel.id };
    variant = resolveVariant(models, model.providerID, model.modelID, agentModel.variant);
  }

  if (!model && opencodeDefaultModel && runnable(opencodeDefaultModel)) {
    model = { providerID: opencodeDefaultModel.providerID, modelID: opencodeDefaultModel.modelID };
    variant = resolveVariant(models, model.providerID, model.modelID, opencodeDefaultModel.variant);
  }

  const hiddenModels = asList(settings?.hiddenModels);
  const lastSelectedModel = splitModel(settings?.lastSelectedModel);
  if (!model
    && runnable(lastSelectedModel)
    && !isModelHidden(hiddenModels, lastSelectedModel.providerID, lastSelectedModel.modelID)
    && (autoAvailable || !isAutoModel(lastSelectedModel))) {
    model = lastSelectedModel;
  }

  if (!model) model = resolveFallbackModel(models, hiddenModels);

  return {
    agent: resolvedAgent?.id,
    model,
    variant,
  };
};

const resolveNamedAgentModel = (agents, agentID, models) => {
  const bound = agents.find((entry) => entry?.id === agentID)?.model;
  if (!asNonEmptyString(bound?.providerID) || !asNonEmptyString(bound?.id)) return null;
  const model = { providerID: bound.providerID, modelID: bound.id };
  return { model, variant: resolveVariant(models, model.providerID, model.modelID, bound.variant) };
};

// external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 Agent and model selection persists on the session and must be switched explicitly.
const applySessionSelection = async ({ client, sessionID, model, agent, variant }) => {
  if (model) {
    await client.session.switchModel({
      sessionID,
      model: { id: model.modelID, providerID: model.providerID, ...(variant ? { variant } : {}) },
    });
  }
  if (agent) await client.session.switchAgent({ sessionID, agent });
};

const forkSession = async ({ client, sessionID, messageID }) => {
  const session = await client.session.fork({
    sessionID,
    // external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 Omitting the fork's before message id copies the whole session.
    ...(messageID ? { before: messageID } : {}),
  });
  if (!asNonEmptyString(session?.id)) throw new Error('failed to fork session');
  return session;
};

const readPromptOrigin = async (client, sessionID) => {
  try {
    const title = asNonEmptyString((await client.session.get({ sessionID }))?.title);
    return title ? { sessionID, title } : { sessionID };
  } catch {
    return { sessionID };
  }
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

const latestIdleRecordID = async ({ client, sessionID }) => {
  let messages;
  try {
    messages = await listMessages({ client, sessionID, limit: 100 });
  } catch {
    return undefined;
  }
  let latest = null;
  for (const message of messages) {
    if (message?.type !== 'idle' || !asNonEmptyString(message?.id)) continue;
    if (!latest || (message.time?.created || 0) >= (latest.time?.created || 0)) latest = message;
  }
  return latest ? latest.id : null;
};

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

const resolveRequestedDirectory = async ({ payload, readSettingsFromDiskMigrated, sanitizeProjects, validateDirectoryPath, chatsScope }) => {
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
      ? { ok: true, directory: validated.directory, projectId: projectID, projectPath: project.path }
      : { ok: false, status: 400, error: validated.error || 'Invalid project directory' };
  }

  const directory = asNonEmptyString(payload?.directory);
  const validated = await validateDirectoryPath(directory);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error || 'Invalid directory' };
  if (chatsScope) {
    const chatsRoot = await validateDirectoryPath(chatsScope.root);
    if (chatsRoot.ok) {
      const relative = path.relative(chatsRoot.directory, validated.directory);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
        return { ok: true, directory: validated.directory };
      }
    }
  }
  const settings = await readSettingsFromDiskMigrated();
  const projects = sanitizeProjects(settings?.projects || []);
  let project = projects.find((entry) => entry.path === validated.directory);
  if (!project && projects.length > 0) {
    const { root } = await resolvePrimaryWorktreeRoot(validated.directory);
    project = projects.find((entry) => entry.path === root);
  }
  return { ok: true, directory: validated.directory, ...(project ? { projectId: project.id, projectPath: project.path } : {}) };
};

const WORKTREE_BOOTSTRAP_TIMEOUT_MS = 60_000;
const WORKTREE_SETUP_TIMEOUT_MS = 3 * 60_000;
const NO_WORKTREE_SETUP = Object.freeze({ startCommand: '', createCommand: '', untrustedSkipped: [] });

const resolvePullRequestInput = (payload) => {
  if (payload?.pullRequest === undefined) return null;
  if (!Number.isSafeInteger(payload.pullRequest) || payload.pullRequest < 1) {
    throw new OpenChamberControlError('pullRequest must be a pull or merge request number, such as 42', 400);
  }
  if (payload.worktree?.startRef !== undefined || payload.setUpstream !== undefined) {
    throw new OpenChamberControlError('pullRequest checks out the pull request\'s own branch; do not combine it with startRef or setUpstream', 400);
  }
  const input = { number: payload.pullRequest };
  const name = asNonEmptyString(payload.worktree?.name);
  if (name) input.name = name;
  const branchName = asNonEmptyString(payload.worktree?.branchName);
  if (branchName) input.branchName = branchName;
  return input;
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

export const createOpenChamberSessionService = (dependencies) => {
  const {
    chatsScope = null,
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    validateDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    emitSessionCreatedEvent,
    broadcastGlobalUiEvent,
    onSessionArchived = null,
    createSessionGoal: createSessionGoalOverride,
    sessionKnowledgeRuntime = null,
    worktreeBootstrapStore,
    hydrateWorktreeCheckout,
    createChangeRequestWorktree = null,
    selectionWarmUp = undefined,
    dataDir = null,
    archiveStore: injectedArchiveStore = null,
    openCodeArchive: injectedOpenCodeArchive = null,
    sessionMetadataStore: injectedSessionMetadataStore = null,
    persistSessionMetadata = null,
    updateSessionMetadata = null,
    createOpenCodeClient = defaultCreateOpenCodeClient,
    createWorktree = createWorktreeDefault,
    getWorktreeBootstrapStatus = getWorktreeBootstrapStatusDefault,
    waitForActiveWorktreeBootstrap = waitForActiveWorktreeBootstrapDefault,
    removeWorktree = removeWorktreeDefault,
    getBranches = getBranchesDefault,
    stashPush = stashPushDefault,
    getPathsWithoutChanges = getPathsWithoutChangesDefault,
    stashApply = stashApplyDefault,
    stashDrop = stashDropDefault,
    listStashes = listStashesDefault,
    resolveWorktreeTopLevel = resolveWorktreeTopLevelDefault,
    validateWorktreeDirectory = validateWorktreeDirectoryDefault,
    resolveAutoSelection = null,
    isAutoReady = null,
    readProjectSetup = null,
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

  const broadcastArchived = (sessionID, archivedAt) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:session-archived',
      properties: { sessionID, archivedAt },
    });
    onSessionArchived?.(sessionID, archivedAt);
  };
  const sessionArchive = createSessionArchive({
    store: archiveStore,
    openCode: injectedOpenCodeArchive || createOpenCodeSessionArchive({ clientFor }),
    announce: broadcastArchived,
  });

  const resolveStartDirectory = createStartDirectoryResolver({ resolveWorktreeTopLevel, validateWorktreeDirectory });

  const toPathKey = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const holdsPath = (outer, inner) => inner === outer || inner.startsWith(`${outer}/`);
  const checkoutRootOf = (directoryKey, folder) => {
    if (folder === null) return null;
    if (folder === '') return directoryKey;
    return directoryKey.endsWith(`/${folder}`) ? directoryKey.slice(0, -folder.length - 1) : null;
  };

  const projectPathInPrimaryCheckout = async (directory, folder, projects) => {
    const primaryRoot = toPathKey((await resolvePrimaryWorktreeRoot(directory)).root);
    let best = null;
    for (const project of projects) {
      const projectKey = toPathKey(project.path);
      if (!holdsPath(primaryRoot, projectKey)) continue;
      const projectFolder = projectKey.slice(primaryRoot.length).replace(/^\/+/, '');
      if (projectFolder && !holdsPath(projectFolder, folder)) continue;
      if (!best || projectFolder.length > best.folder.length) best = { path: project.path, folder: projectFolder };
    }
    return best?.path ?? null;
  };

  const projectPathFor = async (directory) => {
    const projects = await readSettingsFromDiskMigrated()
      .then((settings) => sanitizeProjects(settings?.projects || []))
      .catch(() => []);
    const directoryKey = toPathKey(directory);
    const prefix = (await resolveWorktreeTopLevel(directory).catch(() => null))?.prefix;
    const folder = prefix === undefined ? null : toPathKey(prefix);
    const checkoutRoot = checkoutRootOf(directoryKey, folder);
    let containing = null;
    for (const project of projects) {
      const projectKey = toPathKey(project.path);
      if (!holdsPath(projectKey, directoryKey)) continue;
      if (checkoutRoot && !holdsPath(checkoutRoot, projectKey)) continue;
      if (!containing || projectKey.length > toPathKey(containing).length) containing = project.path;
    }
    if (containing) return containing;
    if (folder !== null) {
      const inPrimaryCheckout = await projectPathInPrimaryCheckout(directory, folder, projects).catch(() => null);
      if (inPrimaryCheckout) return inPrimaryCheckout;
    }
    const resolved = await resolveRequestedDirectory({
      chatsScope,
      payload: { directory },
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      validateDirectoryPath,
    }).catch(() => null);
    return resolved?.ok ? resolved.projectPath ?? resolved.directory : directory;
  };

  const worktreeSetupForDirectory = async (directory) => {
    if (!(readProjectSetup instanceof Function)) return NO_WORKTREE_SETUP;
    const projectPath = await projectPathFor(directory);
    const settings = await readSettingsFromDiskMigrated();
    const project = sanitizeProjects(settings?.projects || []).find((entry) => entry.path === projectPath);
    if (!project) return NO_WORKTREE_SETUP;
    return worktreeSetupOf(await readProjectSetup(project.id), project.path);
  };

  const waitForWorktreeBootstrapReady = async ({ directory, bootstrapStore }) => {
    const settled = waitForActiveWorktreeBootstrap(directory).then(() => true);
    const settledWithin = async (milliseconds) => {
      let timeout;
      try {
        return await Promise.race([settled, new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), milliseconds);
        })]);
      } finally {
        clearTimeout(timeout);
      }
    };
    if (!(await settledWithin(WORKTREE_BOOTSTRAP_TIMEOUT_MS))) {
      const running = await getWorktreeBootstrapStatus(directory, { bootstrapStore });
      if (running?.status === 'pending' && running.phase !== 'git-ready') {
        throw new OpenChamberControlError('Timed out waiting for the worktree bootstrap', 500);
      }
      // external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 OpenCode's checkout gate opens at git-ready.
      if (running?.status === 'pending' && !(await settledWithin(WORKTREE_SETUP_TIMEOUT_MS))) {
        return { setupStillRunning: true };
      }
    }
    const status = await getWorktreeBootstrapStatus(directory, { bootstrapStore });
    if (status?.status === 'failed') {
      throw new OpenChamberControlError(`Worktree bootstrap failed: ${status.error || 'unknown error'}`, 500);
    }
    if (status?.status !== 'ready') {
      throw new OpenChamberControlError('Worktree bootstrap has not completed', 503);
    }
    return { setupStillRunning: false };
  };

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

  const validateRequestedSelection = async ({ directory, requestedModel, requestedAgent, requestedVariant }) => {
    if (!requestedModel && !requestedAgent && !requestedVariant) return;
    const { models, agents } = await fetchSelectionInputs({
      client: clientFor(directory),
      readSettingsFromDiskMigrated,
    });

    if (requestedAgent && agents?.length > 0) {
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

  const selectForSession = async ({
    client,
    sessionID,
    directory,
    projectId,
    requestedModel,
    requestedAgent,
    requestedVariant,
    reuseSessionSelection = false,
    warmUp = false,
  }) => {
    let model = requestedModel;
    let agent = requestedAgent;
    let variant = requestedVariant;
    let selectionInputs = null;
    const readSelectionInputs = async ({ waitForAgents = false } = {}) => {
      if (!selectionInputs) {
        const read = () => fetchSelectionInputs({ client, readSettingsFromDiskMigrated });
        selectionInputs = await (warmUp && waitForAgents ? fetchWarmSelectionInputs(read, selectionWarmUp) : read());
      }
      return selectionInputs;
    };
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
      const inputs = await readSelectionInputs({ waitForAgents: true });
      if (!inputs.agents?.length || inputs.config === null) {
        throw new OpenChamberControlError('Session selection is not ready: agent configuration is unavailable', 503);
      }
      if (agent && !inputs.agents.some((entry) => entry?.id === agent)) {
        throw new OpenChamberControlError(`Agent '${agent}' is not available in this directory`, 503);
      }
      if (!model && agent) {
        const named = resolveNamedAgentModel(inputs.agents, agent, inputs.models);
        if (named) {
          model = named.model;
          if (variant == null) variant = named.variant;
        }
      }
      if (!model || !agent) {
        const autoAvailable = isAutoModel(splitModel(inputs.settings?.lastSelectedModel))
          && isAutoReady !== null
          && await isAutoReady().catch(() => false);
        const defaults = resolveDefaultSelection({
          ...inputs,
          projectDefaults: resolveProjectDefaults(inputs.settings, directory, projectId),
          autoAvailable,
          requireDefaultAgent: !agent,
        });
        if (!model) {
          model = defaults.model;
          if (variant == null) variant = defaults.variant;
        }
        agent = agent || defaults.agent;
      }
    }
    if (!model) {
      const error = new Error('No model is configured or available for the requested directory');
      error.statusCode = 400;
      throw error;
    }
    if (variant == null && !isAutoModel(model) && (!reuseSessionSelection || requestedModel)) {
      try {
        const inputs = await readSelectionInputs();
        variant = resolveSelectionVariant({
          settings: inputs.settings,
          projectDefaults: resolveProjectDefaults(inputs.settings, directory, projectId),
          agents: inputs.agents,
          agentName: agent,
          models: inputs.models,
          providerID: model.providerID,
          modelID: model.modelID,
        });
      } catch {
      }
    }
    return { model, agent, variant };
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
    clearResponseStyle = true,
    promptedBySessionId = null,
  }) => {
    let { model, agent, variant } = await selectForSession({
      client, sessionID, directory, projectId, requestedModel, requestedAgent, requestedVariant, reuseSessionSelection,
    });
    const expandedPrompt = expandSnippets(prompt, directory);
    if (isAutoModel(model)) {
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
      // external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 Command templates are unavailable, so the typed prompt supplies the goal objective.
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

    if (sessionKnowledgeRuntime) {
      try {
        const session = await client.session.get({ sessionID });
        const sessionDirectory = asNonEmptyString(session?.location?.directory);
        if (sessionDirectory) {
          if (clearResponseStyle) await sessionKnowledgeRuntime.sync(sessionID, sessionDirectory, '');
          else await sessionKnowledgeRuntime.sync(sessionID, sessionDirectory);
        }
      } catch (error) {
        console.warn('[OpenChamberSessions] Failed to read session directory for knowledge sync:', error?.message || error);
      }
    }

    if (resolvedCommand) {
      try {
        await client.session.command({
          sessionID,
          name: resolvedCommand.command,
          text: resolvedCommand.arguments || '',
        });
      } catch (error) {
        throw markGoalPartial(error);
      }
    } else {
      let landedMessageID = null;
      try {
        const promptInput = { sessionID, text: expandedPrompt };
        if (promptedBySessionId) {
          promptInput.metadata = { openchamber: { promptedBy: await readPromptOrigin(client, promptedBySessionId) } };
        }
        const sent = await client.session.prompt(promptInput);
        landedMessageID = asNonEmptyString(sent?.id);
        if (goalInput.enabled) {
          // external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 Messages cannot be appended to; admit the goal reminder after the user prompt it references.
          await client.session.synthetic({
            sessionID,
            text: buildGoalIntroText(goalInput.tokenBudget),
            resume: false,
          });
        }
      } catch (error) {
        throw markGoalPartial(error);
      }
      if (!landedMessageID) {
        // external: https://www.npmjs.com/package/@opencode/client/v/2.3.0 A prompt needs a returned inbox item id to confirm it is queued.
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

  const updateMetadata = async (sessionID, decide, directory = '') => {
    if (updateSessionMetadata !== null) {
      return updateSessionMetadata(sessionID, decide, { directory });
    }
    const result = await sessionMetadataStore.updateSessionMetadata(sessionID, decide, { directory });
    if (result.changed) broadcastMetadata(sessionID, result.metadata);
    return result;
  };

  const setSessionLinks = async (sessionID, payload = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new OpenChamberControlError('a session id is required', 400);
    const parsed = parseLinkOperation(payload);
    if (!parsed.ok) throw new OpenChamberControlError(parsed.error, 400);
    const directory = asNonEmptyString(payload?.directory) || '';
    const { metadata } = await updateMetadata(
      id,
      (current) => buildLinkedIssuesPatch(current, parsed.entries, parsed.linked),
      directory,
    );
    return { metadata };
  };

  const archive = async (payload = {}) => {
    const parsed = parseArchiveRequest(payload);
    if (!parsed.ok) {
      throw new OpenChamberControlError(parsed.error, 400);
    }
    return sessionArchive.archive(parsed.ids, parsed.archivedAt);
  };

  const unarchive = async (payload = {}) => {
    const parsed = parseIdBatch(payload);
    if (!parsed.ok) {
      throw new OpenChamberControlError(parsed.error, 400);
    }
    return sessionArchive.unarchive(parsed.ids);
  };

  const createInDirectory = async (payload, { titleByUser = false, startedByExtension = null, operatorParentId = null } = {}, onCreated = () => {}) => {
    const title = asNonEmptyString(payload.title);
    const prompt = asNonEmptyString(payload.prompt);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) {
      throw new OpenChamberControlError(goalInput.error, 400);
    }
    const model = resolveRequestedModel(payload);
    const agent = asNonEmptyString(payload.agent);
    const variant = asNonEmptyString(payload.variant);

    const resolvedDirectory = payload.projectId === CHATS_SCOPE_PUBLIC_ID
      ? await validateDirectoryPath(payload.directory)
      : await resolveRequestedDirectory({
        chatsScope,
        payload,
        readSettingsFromDiskMigrated,
        sanitizeProjects,
        validateDirectoryPath,
      });
    if (!resolvedDirectory.ok) {
      throw new OpenChamberControlError(resolvedDirectory.error, resolvedDirectory.status || 400);
    }

    const pullRequestInput = resolvePullRequestInput(payload);
    const worktreeInput = pullRequestInput ? null : resolveWorktreeInput(payload);
    let worktree = null;
    let sessionDirectory = resolvedDirectory.directory;
    if (payload?.worktree && !worktreeInput && !pullRequestInput) {
      throw new OpenChamberControlError('worktree.name is required when worktree is provided', 400);
    }

    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);

    const projectPath = resolvedDirectory.projectPath ?? resolvedDirectory.directory;
    if (prompt) {
      await validateRequestedSelection({
        directory: resolvedDirectory.directory,
        requestedModel: model,
        requestedAgent: agent,
        requestedVariant: variant,
      });
    }

    const setup = pullRequestInput || worktreeInput
      ? await worktreeSetupForDirectory(resolvedDirectory.directory)
      : NO_WORKTREE_SETUP;
    const setupInput = {};
    if (setup.startCommand) setupInput.startCommand = setup.startCommand;
    if (setup.createCommand) setupInput.createCommand = setup.createCommand;

    if (pullRequestInput) {
      if (!(createChangeRequestWorktree instanceof Function)
        || !(worktreeBootstrapStore?.read instanceof Function)
        || !(worktreeBootstrapStore?.write instanceof Function)) {
        throw new OpenChamberControlError('Worktrees from pull requests are not available here', 501);
      }
      try {
        worktree = await createChangeRequestWorktree({ directory: resolvedDirectory.directory, ...pullRequestInput, ...setupInput });
      } catch (error) {
        throw asControlError(error, `Failed to create a worktree from pull request ${pullRequestInput.number}`);
      }
      sessionDirectory = worktree.path;
    } else if (worktreeInput) {
      if (!(hydrateWorktreeCheckout instanceof Function)
        || !(worktreeBootstrapStore?.read instanceof Function)
        || !(worktreeBootstrapStore?.write instanceof Function)) {
        throw new OpenChamberControlError('Worktree checkout bootstrap is not available', 501);
      }
      const hydrateCheckout = ({ directory, parentRemoteName }) => hydrateWorktreeCheckout({
        directory,
        parentDirectory: resolvedDirectory.directory,
        parentRemoteName,
      });
      worktree = await createWorktree(resolvedDirectory.directory, { ...worktreeInput, ...setupInput }, {
        bootstrapStore: worktreeBootstrapStore,
        hydrateCheckout,
      });
      sessionDirectory = worktree.path;
    }

    let startDirectoryFallback = null;
    let client;
    let selection = { model, agent, variant };
    try {
      const checkoutRoot = worktree?.path || (await resolveWorktreeTopLevel(sessionDirectory))?.root || sessionDirectory;
      const { setupStillRunning } = await waitForWorktreeBootstrapReady({ directory: checkoutRoot, bootstrapStore: worktreeBootstrapStore });
      if (worktree) {
        ({ directory: sessionDirectory, fallback: startDirectoryFallback } = await resolveStartDirectory({
          projectPath,
          worktreeRoot: worktree.path,
        }));
      }
      if (setupStillRunning) {
        throw new OpenChamberControlError(`The project's setup commands are still running in ${checkoutRoot}, so no session started there. Retry in that folder once they finish`, 503);
      }
      client = clientFor(sessionDirectory);
      if (prompt) {
        selection = await selectForSession({
          client,
          directory: sessionDirectory,
          projectId: resolvedDirectory.projectId,
          requestedModel: model,
          requestedAgent: agent,
          requestedVariant: variant,
          warmUp: Boolean(worktree),
        });
      }
    } catch (error) {
      if (!worktree) throw error;
      const failure = asControlError(error, 'Session creation prerequisites failed');
      throw new OpenChamberControlError(failure.message, failure.statusCode, {
        partial: true,
        partialAction: 'worktree-created',
        directory: sessionDirectory,
      });
    }

    const baseUrl = openCodeBaseUrl();
    const authHeaders = getOpenCodeAuthHeaders();
    const sessionID = await createSession({
      client,
      directory: sessionDirectory,
      ...(title ? { title } : {}),
      titleByUser,
      startedByExtension,
      operatorParentId,
    });
    onCreated();

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
        requestedModel: selection.model,
        requestedAgent: selection.agent,
        requestedVariant: selection.variant,
        promptedBySessionId: asNonEmptyString(payload.promptedBySessionId),
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
    if (startDirectoryFallback) result.startDirectoryFallback = startDirectoryFallback;
    if (setup.untrustedSkipped.length > 0) result.untrustedSetupCommandsSkipped = setup.untrustedSkipped;

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

  const restoreAfterSend = async (client, sessionID) => {
    try {
      const session = await client.session.get({ sessionID });
      if (sessionParentId(session)) return;
      const archivedAt = await sessionArchive.archivedAt(sessionID);
      if (!archivedAt) return;
      const subsessionIDs = await listArchivedSubsessions(client, sessionID);
      if (await sessionArchive.archivedAt(sessionID) !== archivedAt) return;
      const { failedIds } = await sessionArchive.unarchive([sessionID]);
      if (failedIds.length > 0) return;
      if (subsessionIDs.length > 0) await sessionArchive.unarchive(subsessionIDs);
    } catch (error) {
      console.warn(`[openchamber-sessions] could not restore ${sessionID} after a send:`, error?.message ?? error);
    }
  };

  const create = async (payload = {}, options = {}) => {
    const projectId = asNonEmptyString(payload.projectId) || asNonEmptyString(payload.projectID);
    if (projectId !== CHATS_SCOPE_PUBLIC_ID) return createInDirectory(payload, options);
    if (asNonEmptyString(payload.directory)) {
      throw new OpenChamberControlError('Provide only one of projectId or directory', 400);
    }
    if (payload.worktree !== undefined || payload.pullRequest !== undefined) {
      throw new OpenChamberControlError('Chats cannot create a worktree; choose a project', 400);
    }
    if (!chatsScope) throw new OpenChamberControlError('Chats are not available on this server', 503);
    const directory = await chatsScope.createChatDirectory();
    let created = false;
    try {
      return await createInDirectory({ ...payload, projectId: CHATS_SCOPE_PUBLIC_ID, directory }, options, () => { created = true; });
    } finally {
      if (!created) await chatsScope.discardChatDirectory(directory);
    }
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
        chatsScope,
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
        await applyForkInheritance({
          sourceSessionID,
          fork: targetSession,
          readObjective,
          writeObjective,
          writeMetadata: (sessionID, patch) => writeMetadata(sessionID, patch, directory),
          writePermissions: (sessionID, permissions) => client.session.update({ sessionID, permissions }),
        });
      }

      const baselineAssistantMessageId = await latestCompletedAssistantMessageID({
        client,
        sessionID: targetSessionID,
      });
      const baselineIdleRecordId = await latestIdleRecordID({ client, sessionID: targetSessionID });

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
        clearResponseStyle: action === 'fork',
        promptedBySessionId: asNonEmptyString(payload.promptedBySessionId),
      });
      if (action === 'send' && dispatch.promptDispatched) await restoreAfterSend(client, targetSessionID);
      const result = {
        action,
        sessionId: targetSessionID,
        directory,
        ...(action === 'fork' ? { sourceSessionId: sourceSessionID } : {}),
        ...(targetSession?.title ? { title: targetSession.title } : {}),
        ...(baselineAssistantMessageId ? { baselineAssistantMessageId } : {}),
        ...(baselineIdleRecordId !== undefined ? { baselineIdleRecordId } : {}),
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

  const worktreeMover = createSessionWorktreeMover({
    createWorktree,
    removeWorktree,
    getBranches,
    stashPush,
    getPathsWithoutChanges,
    stashApply,
    stashDrop,
    listStashes,
    resolvePrimaryWorktreeRoot,
    bootstrapStore: worktreeBootstrapStore,
    waitForWorktreeReady: (directory) => waitForWorktreeBootstrapReady({ directory, bootstrapStore: worktreeBootstrapStore }),
    resolveStartDirectory: async ({ sourceDirectory, worktreeRoot }) => resolveStartDirectory({
      projectPath: await projectPathFor(sourceDirectory),
      worktreeRoot,
    }),
    hydrateCheckout: hydrateWorktreeCheckout,
    resolveWorktreeSetup: worktreeSetupForDirectory,
    moveSession: (sessionID, directory) => clientFor(undefined).session.move({ sessionID, directory }),
  });

  const moveToWorktree = async (sessionID, payload = {}) => {
    if (!(hydrateWorktreeCheckout instanceof Function)
      || !(worktreeBootstrapStore?.read instanceof Function)
      || !(worktreeBootstrapStore?.write instanceof Function)) {
      throw new OpenChamberControlError('Worktree checkout bootstrap is not available', 501);
    }
    await waitForOpenCodeReady?.(10_000, 250);
    return worktreeMover.move({
      sessionId: sessionID,
      directory: asNonEmptyString(payload.directory),
      name: asNonEmptyString(payload.worktree?.name),
      branchName: asNonEmptyString(payload.worktree?.branchName),
      startRef: asNonEmptyString(payload.worktree?.startRef),
      existingBranch: asNonEmptyString(payload.worktree?.existingBranch),
      carry: payload.carry,
    });
  };

  const resolveDirectory = async (payload) => {
    const resolved = await resolveRequestedDirectory({
      chatsScope,
      payload,
      readSettingsFromDiskMigrated,
      sanitizeProjects,
      validateDirectoryPath,
    });
    if (!resolved.ok) throw new OpenChamberControlError(resolved.error, resolved.status || 400);
    return resolved.directory;
  };

  return {
    create,
    resolveDirectory,
    archive,
    unarchive,
    archiveStore,
    sessionArchive,
    sessionMetadataStore,
    setMetadata,
    getMetadata,
    setSessionLinks,
    send: (sessionID, payload) => runExisting('send', sessionID, payload),
    fork: (sessionID, payload) => runExisting('fork', sessionID, payload),
    moveToWorktree,
  };
};

const sendServiceError = (res, error, fallback) => {
  const controlError = asControlError(error, fallback);
  const body = {
    error: controlError.message,
    ...(controlError.partial === true ? {
      partial: true,
      partialAction: controlError.partialAction,
      sessionId: controlError.sessionId,
      directory: controlError.directory,
    } : {}),
  };
  return res.status(controlError.statusCode).json(body);
};

export const registerOpenChamberSessionRoutes = (app, dependencies) => {
  const service = dependencies.sessionService || createOpenChamberSessionService(dependencies);

  app.post('/api/openchamber/sessions', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.create(
        req.body && typeof req.body === 'object' ? req.body : {},
        { titleByUser: true },
      ));
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

  app.post('/api/openchamber/sessions/:sessionId/links', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.setSessionLinks(req.params.sessionId, req.body));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to update session links:', error);
      return sendServiceError(res, error, 'Failed to update session links');
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
