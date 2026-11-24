import { asNonEmptyString } from '../shared/guards.js';
import type { SessionDirectoryCanonicalizer } from '../opencode/directory-canonicalization.js';
import express from 'express';
import { z } from 'zod';
import path from 'node:path';
import {
  createWorktree as createWorktreeDefault,
  getBranches as getBranchesDefault,
  isExistingBranchAvailableLocally as isExistingBranchAvailableLocallyDefault,
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
import { expandSnippets } from '../snippets/snippets.js';
import { AUTO_MODEL_REF, isAutoModel } from '../routing/defaults.js';
import { parseScheduledCommandPrompt } from '../scheduled-tasks/runtime.js';
import { CHATS_SCOPE_PUBLIC_ID, readChatsDefaults } from '../scheduled-tasks/chats-scope.js';
import { buildGoalIntroText, createSessionGoal } from '../session-goal/create.js';
import { OpenChamberControlError, asControlError, controlErrorFields, type ControlErrorDetails } from '../openchamber-control/error.js';
import { readObjective, writeObjective } from '../session-goal/objectives.js';
import { worktreeSetupOf } from '../projects/worktree-setup.js';
import { createArchiveStore } from './archive-store.js';
import { createOpenCodeSessionArchive, createSessionArchive } from './session-archive.js';
import { applyForkInheritance, listForkMessages } from './fork-inheritance.js';
import { createOpenCodeClient as defaultCreateOpenCodeClient } from './opencode-client.js';
import { createSessionMetadataStore, createOpenCodeSessionMetadata, type SessionMetadata, type MetadataDecider } from './session-metadata-store.js';
import { compareAndSetSessionMetadata, registerConditionalMetadataRoute, setSessionMetadata } from './session-metadata-route.js';
import { createSession } from './create-session.js';
import { mayBeReloading, readCatalogListing } from './catalog-reload.js';
import { findCatalogModel, isMissingFromCatalog, isModelHidden, requireListedDefault, resolveFallbackModel } from './catalog-models.js';
import type { ModelSelection } from './catalog-models.js';
import { fetchSelectionInputs } from './selection-inputs.js';
import { EMPTY_SESSION_AUTO_ERROR, assertEmptySessionModel, resolveRequestedModel, splitModel } from './requested-model.js';
import { buildLinkedIssuesPatch, parseLinkOperation } from './session-linked-issues.js';
import { createSessionWorktreeMover, type SessionMoveWorktree } from './worktree-move.js';
import { sessionParentId } from '../session-lineage.js';
import { listArchivedSubsessions } from './archived-subsessions.js';
import { createStartDirectoryResolver, type StartDirectoryResult } from './worktree-start-directory.js';
import { assertExistingBranchAvailable, resolvePullRequestInput, resolveWorktreeInput, worktreeFields } from './worktree-input.js';
import { hasMessage } from './contracts.js';
import type { AgentInfo, ModelInfo, SessionPromptInput, SessionForkInput, SessionSwitchModelInput } from '@opencode/client';
import type { SessionClient } from './opencode-client-contract.js';
import type { Application, Request, Response } from '../shared/http-contracts.js';
import type { WorktreeSetup, WorktreeSetupInput, DirectoryValidation } from '../projects/contracts.js';
import type { createChatsScope } from '../scheduled-tasks/chats-scope.js';
import type { createFeatureRoutesRuntime } from '../server-frame/feature-routes-runtime.js';
import type { createRoutingRuntime } from '../routing/runtime.js';
import type { createWorktreeBootstrapStore } from '../git/worktree-bootstrap-storage.js';

export interface SessionPayload {
  entries?: unknown;
  linked?: unknown;
  model?: unknown;
  providerID?: unknown;
  modelID?: unknown;
  goal?: unknown;
  goalTokenBudget?: unknown;
  ids?: unknown;
  archivedAt?: unknown;
  projectId?: unknown;
  projectID?: unknown;
  directory?: unknown;
  pullRequest?: unknown;
  worktree?: unknown;
  setUpstream?: unknown;
  patch?: unknown;
  expected?: unknown;
  title?: unknown;
  prompt?: unknown;
  agent?: unknown;
  variant?: unknown;
  promptedBySessionId?: unknown;
  messageId?: unknown;
  carry?: unknown;
}

interface SessionSettings {
  projects?: unknown;
  defaultAgent?: unknown;
  defaultModel?: unknown;
  defaultVariant?: unknown;
  chatsDefaultAgent?: unknown; chatsDefaultModel?: unknown; chatsDefaultVariant?: unknown;
  lastUsedEfforts?: unknown;
  hiddenModels?: unknown;
  lastSelectedModel?: unknown;
}

interface SessionProject { id: string; path: string }
type MetadataStore = ReturnType<typeof createSessionMetadataStore>;
type FeatureRoutesRuntime = ReturnType<typeof createFeatureRoutesRuntime>;
type BootstrapStore = ReturnType<typeof createWorktreeBootstrapStore>;
type Message = Awaited<ReturnType<SessionClient['message']['list']>>['data'][number];

export interface SessionServiceDependencies {
  getSessionDirectoryCanonicalizer?: SessionDirectoryCanonicalizer | null;
  chatsScope?: ReturnType<typeof createChatsScope> | null;
  readSettingsFromDiskMigrated: () => Promise<SessionSettings | null>;
  sanitizeProjects: (projects: SessionSettings['projects']) => SessionProject[];
  validateDirectoryPath: (directory: string | null) => Promise<DirectoryValidation>;
  buildOpenCodeUrl: (route: string, query: string) => string;
  getOpenCodeAuthHeaders: Parameters<typeof createOpenCodeSessionMetadata>[0]['getOpenCodeAuthHeaders'];
  waitForOpenCodeReady?: (timeout: number, interval: number) => Promise<void>;
  emitSessionCreatedEvent?: (event: SessionCreatedEvent) => void;
  broadcastGlobalUiEvent?: (event: { type: string; properties: { sessionID: string; archivedAt?: number | null; metadata?: SessionMetadata | undefined } }) => void;
  onSessionArchived?: ((sessionID: string, archivedAt: number | null) => void) | null;
  createSessionGoal?: typeof createSessionGoal;
  sessionKnowledgeRuntime?: { sync: (sessionID: string, directory: string, responseStyle?: string) => Promise<boolean | void> } | null;
  worktreeBootstrapStore: BootstrapStore;
  hydrateWorktreeCheckout: FeatureRoutesRuntime['hydrateBoundCheckout'];
  createChangeRequestWorktree?: ((input: { directory: string; number: number; name?: string; branchName?: string; startCommand?: string; createCommand?: string }) => Promise<SessionMoveWorktree>) | null;
  dataDir?: string | null;
  archiveStore?: ReturnType<typeof createArchiveStore> | null;
  openCodeArchive?: Parameters<typeof createSessionArchive>[0]['openCode'] | null;
  sessionMetadataStore?: MetadataStore | null;
  persistSessionMetadata?: MetadataStore['setSessionMetadata'] | null;
  updateSessionMetadata?: MetadataStore['updateSessionMetadata'] | null;
  createOpenCodeClient?: typeof defaultCreateOpenCodeClient;
  createWorktree?: typeof createWorktreeDefault;
  getWorktreeBootstrapStatus?: typeof getWorktreeBootstrapStatusDefault;
  waitForActiveWorktreeBootstrap?: typeof waitForActiveWorktreeBootstrapDefault;
  removeWorktree?: typeof removeWorktreeDefault;
  getBranches?: typeof getBranchesDefault;
  isExistingBranchAvailableLocally?: typeof isExistingBranchAvailableLocallyDefault;
  stashPush?: typeof stashPushDefault;
  getPathsWithoutChanges?: typeof getPathsWithoutChangesDefault;
  stashApply?: typeof stashApplyDefault;
  stashDrop?: typeof stashDropDefault;
  listStashes?: typeof listStashesDefault;
  resolveWorktreeTopLevel?: typeof resolveWorktreeTopLevelDefault;
  validateWorktreeDirectory?: typeof validateWorktreeDirectoryDefault;
  resolveAutoSelection?: ReturnType<typeof createRoutingRuntime>['resolveAutoSelection'] | null;
  isAutoReady?: (() => Promise<boolean>) | null;
  readProjectSetup?: ((projectID: string) => Promise<WorktreeSetupInput>) | null;
}

export interface SessionCreatedEvent {
  sessionID: string;
  directory: string;
  projectID?: string;
  sourceSessionID?: string;
  title?: string;
  worktree?: SessionMoveWorktree;
  model?: ModelSelection;
  agent?: string;
  variant?: string;
  promptDispatched: boolean;
  dispatchedAsCommand: boolean;
  goalEnabled?: boolean;
  goalTokenBudget?: number;
  createdAt: number;
}

interface Selection {
  model: ModelSelection | null;
  agent: string | null | undefined;
  variant: string | null | undefined;
}
interface SelectionRequest {
  requestedModel: ModelSelection | null;
  requestedAgent: string | null | undefined;
  requestedVariant: string | null | undefined;
}
interface SessionSelectionInput extends SelectionRequest {
  client: SessionClient;
  sessionID?: string;
  directory: string;
  projectId: string | undefined;
  reuseSessionSelection?: boolean;
}
type GoalInput = { ok: true; enabled: boolean; tokenBudget: number | null } | { ok: false; error: string };
interface DispatchInput extends SessionSelectionInput {
  sessionID: string;
  baseUrl: string;
  authHeaders: ReturnType<SessionServiceDependencies['getOpenCodeAuthHeaders']>;
  prompt: string;
  goalInput: Extract<GoalInput, { ok: true }>;
  clearResponseStyle?: boolean;
  promptedBySessionId?: string | null;
}
interface DispatchResult extends Selection {
  model: ModelSelection;
  promptDispatched: boolean;
  dispatchedAsCommand: boolean;
  promptError?: string;
}
export interface CreateResult {
  sessionId: string;
  directory: string;
  projectId?: string;
  title?: string;
  worktree?: SessionMoveWorktree;
  model?: ModelSelection;
  agent?: string;
  variant?: string;
  promptDispatched: boolean;
  promptError?: string;
  dispatchedAsCommand: boolean;
  goalEnabled?: boolean;
  goalTokenBudget?: number;
  startDirectoryFallback?: NonNullable<StartDirectoryResult['fallback']>;
  untrustedSetupCommandsSkipped?: string[];
}
export interface ExistingResult extends CreateResult {
  action: 'send' | 'fork';
  sourceSessionId?: string;
  baselineAssistantMessageId?: string;
  baselineIdleRecordId?: string | null;
  model: ModelSelection;
}
interface CreateOptions {
  titleByUser?: boolean;
  startedByExtension?: string | null;
  operatorParentId?: string | null;
}
interface ProjectFields { id?: unknown; path?: unknown; defaultAgent?: unknown; defaultModel?: unknown; defaultVariant?: unknown }
interface ServiceErrorBody extends Pick<ControlErrorDetails, 'partial' | 'partialAction' | 'sessionId' | 'directory'> { error: string }
interface SetupInput { startCommand?: string; createCommand?: string }
type PromptInput = { -readonly [Key in keyof SessionPromptInput]: SessionPromptInput[Key] };
type ForkInput = { -readonly [Key in keyof SessionForkInput]: SessionForkInput[Key] };
type SwitchModel = { -readonly [Key in keyof SessionSwitchModelInput['model']]: SessionSwitchModelInput['model'][Key] };

const isPayload = (value: unknown): value is SessionPayload => value !== null && typeof value === 'object';
const hasPayloadFields = (value: unknown): value is SessionPayload => value !== null && value !== undefined;
const payloadFields = ({ body }: Pick<Request, 'body'>): SessionPayload | null | undefined => hasPayloadFields(body) ? body : body === null ? null : undefined;
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isGoalError = (value: unknown): value is { goalConfigured?: unknown } => !!value && typeof value === 'object';
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
const asList = <T>(value: readonly T[] | null | undefined): readonly T[] => Array.isArray(value) ? value : [];
const hasProjectFields = (value: unknown): value is ProjectFields => value !== null && value !== undefined;
const hasEffortEntries = (value: unknown): value is Record<string, unknown> => value !== null && value !== undefined;
const hasText = (value: unknown): value is string => Boolean(asNonEmptyString(value));
const requiredDataDir = (value: string | null) => {
  if (value === null) throw new Error('openchamber session routes need either both stores or a dataDir');
  return value;
};

const MIN_GOAL_TOKEN_BUDGET = 1_000;
const MAX_GOAL_TOKEN_BUDGET = 100_000_000;


const resolveGoalInput = (payload: SessionPayload, prompt: string | null): GoalInput => {
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
  if (!isSafeInteger(tokenBudget)
    || tokenBudget < MIN_GOAL_TOKEN_BUDGET
    || tokenBudget > MAX_GOAL_TOKEN_BUDGET) {
    return { ok: false, error: `goalTokenBudget must be an integer from ${MIN_GOAL_TOKEN_BUDGET} to ${MAX_GOAL_TOKEN_BUDGET}` };
  }
  return { ok: true, enabled, tokenBudget };
};

const isPrimaryAgentMode = (mode: AgentInfo['mode']) => !mode || mode === 'primary' || mode === 'all';

const resolveVariant = (models: readonly ModelInfo[], providerID: string, modelID: string, variant: string | null | undefined) => {
  const normalized = asNonEmptyString(variant);
  if (!normalized) return undefined;
  const model = findCatalogModel(models, providerID, modelID);
  if (!model) return normalized;
  return asList(model.variants).some((entry) => entry?.id === normalized) ? normalized : undefined;
};

const findAgentBySetting = (agents: readonly AgentInfo[] | null, wantedName: string | null | undefined) => {
  const wanted = asNonEmptyString(wantedName)?.toLowerCase();
  if (!wanted) return null;
  if (agents === null) throw new TypeError("Cannot read properties of null (reading 'find')");
  return agents.find((agent) => agent?.id === wantedName)
    || agents.find((agent) => isText(agent?.name) && agent.name.toLowerCase() === wanted)
    || agents.find((agent) => isText(agent?.id) && agent.id.toLowerCase() === wanted)
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
}: {
  settings: SessionSettings | null;
  projectDefaults: ReturnType<typeof resolveProjectDefaults>;
  agents: readonly AgentInfo[] | null;
  agentName: string | null | undefined;
  models: readonly ModelInfo[];
  providerID: string;
  modelID: string;
}) => {
  const model = findCatalogModel(models, providerID, modelID);
  if (!model) return undefined;
  const offered = asList(model.variants)
    .map((entry) => asNonEmptyString(entry?.id))
    .filter((value) => value !== null);
  if (offered.length === 0) return undefined;

  const agent = findAgentBySetting(agents, agentName);
  const agentModel = agent?.model;
  const agentVariant = agentModel?.providerID === providerID && agentModel?.id === modelID
    ? agentModel.variant
    : undefined;
  const projectDefaultModel = splitModel(projectDefaults?.defaultModel);
  const settingsDefaultModel = splitModel(asNonEmptyString(settings?.defaultModel));
  const isThisModel = (candidate: ModelSelection | null) => candidate?.providerID === providerID && candidate.modelID === modelID;
  const settingsVariant = isThisModel(settingsDefaultModel) ? settings?.defaultVariant ?? undefined : undefined;
  const scopeVariant = isThisModel(projectDefaultModel) ? projectDefaults?.defaultVariant ?? undefined : undefined;
  const remembered = hasEffortEntries(settings?.lastUsedEfforts) ? settings.lastUsedEfforts[`${providerID}/${modelID}`] : undefined;
  const sources = !isThisModel(projectDefaultModel) ? [agentVariant, settingsVariant, remembered]
    : scopeVariant === undefined ? [agentVariant, remembered, settingsVariant] : [agentVariant, scopeVariant, remembered];

  for (const source of sources) {
    if (source === null) return null;
    const parsed = z.enum(offered).safeParse(source);
    if (parsed.success) return parsed.data;
  }
  return undefined;
};

const resolveProjectDefaults = (settings: SessionSettings | null, directory: string, projectId: string | undefined) => {
  if (projectId === CHATS_SCOPE_PUBLIC_ID) return readChatsDefaults(settings);
  const projects: readonly unknown[] = Array.isArray(settings?.projects) ? settings.projects : [];
  const matchedProject = projects.find((entry) => hasProjectFields(entry) && (projectId ? entry.id === projectId : entry.path === directory)) || null;
  const project = hasProjectFields(matchedProject) ? matchedProject : undefined;
  return {
    defaultAgent: asNonEmptyString(project?.defaultAgent),
    defaultModel: asNonEmptyString(project?.defaultModel),
    defaultVariant: asNonEmptyString(project?.defaultVariant),
  };
};

const resolveDefaultSelection = ({ agents, models, settings, projectDefaults, config, autoAvailable, requireDefaultAgent }: {
  agents: readonly AgentInfo[];
  models: readonly ModelInfo[];
  settings: SessionSettings | null;
  projectDefaults: ReturnType<typeof resolveProjectDefaults>;
  config: NonNullable<Awaited<ReturnType<typeof fetchSelectionInputs>>['config']>;
  autoAvailable: boolean;
  requireDefaultAgent: boolean;
}) => {
  const primaryAgents = agents.filter((agent) => isPrimaryAgentMode(agent?.mode) && agent?.hidden !== true);
  let resolvedAgent: AgentInfo | null = null;
  const projectDefaultAgent = asNonEmptyString(projectDefaults?.defaultAgent);
  const settingsDefaultAgent = asNonEmptyString(settings?.defaultAgent);
  const opencodeDefaultAgent = config.defaultAgent;
  const opencodeDefaultModel = config.defaultModel;
  const configuredAgent = projectDefaultAgent || settingsDefaultAgent || opencodeDefaultAgent;
  if (requireDefaultAgent && configuredAgent && !findAgentBySetting(agents, configuredAgent)) {
    throw new OpenChamberControlError(`Configured agent '${configuredAgent}' is not available in this directory. Update the default agent in the project, Chats or global settings, or in OpenCode config, or pass an explicit agent.`, 503);
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

  let model: ModelSelection | null = null;
  let variant: string | undefined;
  const projectDefaultModel = splitModel(projectDefaults?.defaultModel);
  const settingsDefaultModel = splitModel(asNonEmptyString(settings?.defaultModel));
  const runnable = (candidate: ModelSelection | null): candidate is ModelSelection => !!candidate
    && (!isMissingFromCatalog(models, candidate) || mayBeReloading(models, candidate.providerID));
  if (runnable(projectDefaultModel)) {
    model = projectDefaultModel;
    variant = resolveVariant(models, model.providerID, model.modelID, projectDefaults?.defaultVariant);
  }
  if (!model && runnable(settingsDefaultModel)) {
    model = settingsDefaultModel;
    variant = resolveVariant(models, model.providerID, model.modelID, asNonEmptyString(settings?.defaultVariant));
  }

  const agentModel = resolvedAgent?.model;
  if (!model && hasText(agentModel?.providerID) && hasText(agentModel?.id)
    && runnable({ providerID: agentModel.providerID, modelID: agentModel.id })) {
    model = { providerID: agentModel.providerID, modelID: agentModel.id };
    variant = resolveVariant(models, model.providerID, model.modelID, agentModel.variant);
  }

  if (!model && opencodeDefaultModel && runnable(opencodeDefaultModel)) {
    model = { providerID: opencodeDefaultModel.providerID, modelID: opencodeDefaultModel.modelID };
    variant = resolveVariant(models, model.providerID, model.modelID, opencodeDefaultModel.variant);
  }

  const hiddenModels = isList(settings?.hiddenModels) ? settings.hiddenModels : [];
  const lastSelectedModel = splitModel(asNonEmptyString(settings?.lastSelectedModel));
  if (!model
    && runnable(lastSelectedModel)
    && !isModelHidden(hiddenModels, lastSelectedModel.providerID, lastSelectedModel.modelID)
    && (autoAvailable || !isAutoModel(lastSelectedModel))) {
    model = lastSelectedModel;
  }

  const named = [projectDefaultModel, settingsDefaultModel,
    hasText(agentModel?.providerID) && hasText(agentModel?.id) ? { providerID: agentModel.providerID, modelID: agentModel.id } : null,
    opencodeDefaultModel && { providerID: opencodeDefaultModel.providerID, modelID: opencodeDefaultModel.modelID },
    lastSelectedModel && !isAutoModel(lastSelectedModel) && !isModelHidden(hiddenModels, lastSelectedModel.providerID, lastSelectedModel.modelID) ? lastSelectedModel : null];
  if (!model) model = named.find((candidate) => !!candidate) ?? resolveFallbackModel(models, hiddenModels);

  return {
    agent: resolvedAgent?.id,
    model,
    variant,
  };
};

const resolveNamedAgentModel = (agents: readonly AgentInfo[], agentID: string, models: readonly ModelInfo[]) => {
  const bound = agents.find((entry) => entry?.id === agentID)?.model;
  if (!hasText(bound?.providerID) || !hasText(bound?.id)) return null;
  const model = { providerID: bound.providerID, modelID: bound.id };
  return { model, variant: resolveVariant(models, model.providerID, model.modelID, bound.variant) };
};

const applySessionSelection = async ({ client, sessionID, model, agent, variant }: Selection & { client: SessionClient; sessionID: string }) => {
  if (model) {
    const selected: SwitchModel = { id: model.modelID, providerID: model.providerID };
    if (variant) selected.variant = variant;
    await client.session.switchModel({
      sessionID,
      model: selected,
    });
  }
  if (agent) await client.session.switchAgent({ sessionID, agent });
};

const forkSession = async ({ client, sessionID, messageID }: { client: SessionClient; sessionID: string; messageID: string | undefined }) => {
  const input: ForkInput = { sessionID };
  if (messageID) input.before = messageID;
  const session = await client.session.fork(input);
  if (!asNonEmptyString(session?.id)) throw new Error('failed to fork session');
  return session;
};

const readPromptOrigin = async (client: SessionClient, sessionID: string) => {
  try {
    const title = asNonEmptyString((await client.session.get({ sessionID }))?.title);
    return title ? { sessionID, title } : { sessionID };
  } catch {
    return { sessionID };
  }
};

const listMessages = async ({ client, sessionID, limit }: { client: SessionClient; sessionID: string; limit: number }) => {
  const response = await client.message.list({ sessionID, limit, order: 'desc' });
  return asList(response?.data);
};

const latestCompletedAssistantMessageID = async ({ client, sessionID }: { client: SessionClient; sessionID: string }) => {
  let messages;
  try {
    messages = await listMessages({ client, sessionID, limit: 100 });
  } catch {
    return null;
  }
  let latest: Message | null = null;
  for (const message of messages) {
    if (message?.type !== 'assistant' || !Number.isFinite(message?.time?.completed)) continue;
    if (!latest || (message.time.created || 0) >= (latest.time?.created || 0)) latest = message;
  }
  return asNonEmptyString(latest?.id);
};

const latestIdleRecordID = async ({ client, sessionID }: { client: SessionClient; sessionID: string }) => {
  let messages;
  try {
    messages = await listMessages({ client, sessionID, limit: 100 });
  } catch {
    return undefined;
  }
  let latest: Message | null = null;
  for (const message of messages) {
    if (message?.type !== 'idle' || !asNonEmptyString(message?.id)) continue;
    if (!latest || (message.time?.created || 0) >= (latest.time?.created || 0)) latest = message;
  }
  return latest ? latest.id : null;
};

const MAX_ARCHIVE_BATCH = 500;

const parseIdBatch = (payload: SessionPayload): { ok: true; ids: string[] } | { ok: false; error: string } => {
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

const parseArchiveRequest = (payload: SessionPayload): { ok: true; ids: string[]; archivedAt: number } | { ok: false; error: string } => {
  const parsed = parseIdBatch(payload);
  if (!parsed.ok) return parsed;

  const archivedAt = payload?.archivedAt;
  if (archivedAt !== undefined && (!isSafeInteger(archivedAt) || archivedAt <= 0)) {
    return { ok: false, error: 'archivedAt must be a positive integer timestamp' };
  }

  return { ok: true, ids: parsed.ids, archivedAt: archivedAt ?? Date.now() };
};

type ResolvedDirectory =
  | { ok: true; directory: string; projectId?: string; projectPath?: string; chats?: boolean }
  | { ok: false; status?: number; error: string };

const resolveRequestedDirectory = async ({ payload, readSettingsFromDiskMigrated, sanitizeProjects, validateDirectoryPath, chatsScope }: Pick<SessionServiceDependencies, 'readSettingsFromDiskMigrated' | 'sanitizeProjects' | 'validateDirectoryPath' | 'chatsScope'> & { payload: SessionPayload }): Promise<ResolvedDirectory> => {
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
        return { ok: true, directory: validated.directory, chats: true };
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
  const result: Extract<ResolvedDirectory, { ok: true }> = { ok: true, directory: validated.directory };
  if (project) {
    result.projectId = project.id;
    result.projectPath = project.path;
  }
  return result;
};

const WORKTREE_BOOTSTRAP_TIMEOUT_MS = 60_000;
const WORKTREE_SETUP_TIMEOUT_MS = 3 * 60_000;
const NO_WORKTREE_SETUP: Readonly<WorktreeSetup> = Object.freeze({ startCommand: '', createCommand: '', untrustedSkipped: [] });

export const createOpenChamberSessionService = (dependencies: SessionServiceDependencies) => {
  const {
    getSessionDirectoryCanonicalizer = null,
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
    isExistingBranchAvailableLocally = isExistingBranchAvailableLocallyDefault,
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
  const archiveStore = injectedArchiveStore || createArchiveStore({ dataDir: requiredDataDir(dataDir) });
  const sessionMetadataStore = injectedSessionMetadataStore || createSessionMetadataStore({
    dataDir: requiredDataDir(dataDir),
    openCode: createOpenCodeSessionMetadata({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      createOpenCodeClient,
    }),
  });

  const openCodeBaseUrl = () => buildOpenCodeUrl('/', '').replace(/\/$/, '');
  const clientFor = (directory?: string) => createOpenCodeClient({
    baseUrl: openCodeBaseUrl(),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });

  const broadcastArchived = (sessionID: string, archivedAt: number | null) => {
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

  const resolveStartDirectory = createStartDirectoryResolver({ resolveWorktreeTopLevel, validateWorktreeDirectory, getSessionDirectoryCanonicalizer });

  const toPathKey = (value: string | undefined) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const holdsPath = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);
  const checkoutRootOf = (directoryKey: string, folder: string | null) => {
    if (folder === null) return null;
    if (folder === '') return directoryKey;
    return directoryKey.endsWith(`/${folder}`) ? directoryKey.slice(0, -folder.length - 1) : null;
  };

  const projectPathInPrimaryCheckout = async (directory: string, folder: string, projects: SessionProject[]) => {
    const primaryRoot = toPathKey((await resolvePrimaryWorktreeRoot(directory)).root);
    let best: { path: string; folder: string } | null = null;
    for (const project of projects) {
      const projectKey = toPathKey(project.path);
      if (!holdsPath(primaryRoot, projectKey)) continue;
      const projectFolder = projectKey.slice(primaryRoot.length).replace(/^\/+/, '');
      if (projectFolder && !holdsPath(projectFolder, folder)) continue;
      if (!best || projectFolder.length > best.folder.length) best = { path: project.path, folder: projectFolder };
    }
    return best?.path ?? null;
  };

  const projectPathFor = async (directory: string) => {
    const projects = await readSettingsFromDiskMigrated()
      .then((settings) => sanitizeProjects(settings?.projects || []))
      .catch(() => []);
    const directoryKey = toPathKey(directory);
    const prefix = (await resolveWorktreeTopLevel(directory).catch(() => null))?.prefix;
    const folder = prefix === undefined ? null : toPathKey(prefix);
    const checkoutRoot = checkoutRootOf(directoryKey, folder);
    let containing: string | null = null;
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

  const worktreeSetupForDirectory = async (directory: string) => {
    if (!(readProjectSetup instanceof Function)) return NO_WORKTREE_SETUP;
    const projectPath = await projectPathFor(directory);
    const settings = await readSettingsFromDiskMigrated();
    const project = sanitizeProjects(settings?.projects || []).find((entry) => entry.path === projectPath);
    return project ? worktreeSetupOf(await readProjectSetup(project.id), project.path) : NO_WORKTREE_SETUP;
  };

  const waitForWorktreeBootstrapReady = async ({ directory, bootstrapStore }: { directory: string; bootstrapStore: BootstrapStore }) => {
    const settled = waitForActiveWorktreeBootstrap(directory).then(() => true);
    const settledWithin = async (milliseconds: number) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([settled, new Promise<boolean>((resolve) => {
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

  const fetchSessionSelection = async ({ client, sessionID }: { client: SessionClient; sessionID: string }) => {
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

  const validateRequestedSelection = async ({ directory, requestedModel, requestedAgent, requestedVariant, requireModelMatch = false }: SelectionRequest & { directory: string; requireModelMatch?: boolean }) => {
    if (!requestedModel && !requestedAgent && !requestedVariant) return requestedModel;
    const client = clientFor(directory);
    const { models: listed, agents, notReadyReason } = await fetchSelectionInputs({ client, readSettingsFromDiskMigrated });
    const models = requestedModel ? await readCatalogListing(client, listed, (known) => Boolean(findCatalogModel(known, requestedModel.providerID, requestedModel.modelID))) : listed;

    if (requestedAgent && agents && agents.length > 0) {
      const agent = agents.find((entry) => entry?.id === requestedAgent) || null;
      if (!agent && notReadyReason) {
        throw new OpenChamberControlError(`Session selection is not ready: ${notReadyReason}`, 503);
      }
      if (!agent) {
        throw new OpenChamberControlError(`Unknown agent '${requestedAgent}' for ${directory}`, 400);
      }
      if (!isPrimaryAgentMode(agent.mode)) {
        throw new OpenChamberControlError(`Agent '${requestedAgent}' is a subagent and cannot receive a prompt directly`, 400);
      }
    }

    if (requestedModel && requireModelMatch && models.length === 0) throw new OpenChamberControlError(`Session selection is not ready: ${notReadyReason ?? 'the model catalog is unavailable'}`, 503);
    if (requestedModel && models.length > 0) {
      const entry = findCatalogModel(models, requestedModel.providerID, requestedModel.modelID);
      if (!entry) {
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
      return { providerID: entry.providerID, modelID: entry.id };
    }
    return requestedModel;
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
  }: SessionSelectionInput) => {
    let model = requestedModel;
    let agent = requestedAgent;
    let variant = requestedVariant, reusedModel = false;
    let selectionInputs: Awaited<ReturnType<typeof fetchSelectionInputs<SessionSettings | null>>> | null = null;
    const readSelectionInputs = async () => {
      selectionInputs ??= await fetchSelectionInputs({ client, readSettingsFromDiskMigrated });
      return selectionInputs;
    };
    if (reuseSessionSelection && (!model || !agent)) {
      if (sessionID === undefined) throw new Error('Session selection requires a session id');
      const previous = await fetchSessionSelection({ client, sessionID });
      if (previous) {
        if (!model && previous.model) {
          [model, reusedModel] = [previous.model, true];
          if (variant == null) variant = previous.variant ?? undefined;
        }
        if (!agent && previous.agent) agent = previous.agent;
      }
    }
    if (!model || !agent) {
      const inputs = await readSelectionInputs();
      if (inputs.notReadyReason) {
        throw new OpenChamberControlError(`Session selection is not ready: ${inputs.notReadyReason}`, 503);
      }
      if (!inputs.agents || !inputs.agents.length || inputs.config === null) {
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
        const autoAvailable = isAutoModel(splitModel(asNonEmptyString(inputs.settings?.lastSelectedModel)))
          && isAutoReady !== null
          && await isAutoReady().catch(() => false);
        const { agents, config } = inputs;
        const resolveWith = (models: readonly ModelInfo[]) => resolveDefaultSelection({
          ...inputs,
          agents,
          config,
          models,
          projectDefaults: resolveProjectDefaults(inputs.settings, directory, projectId),
          autoAvailable,
          requireDefaultAgent: !agent,
        });
        const lists = (known: readonly ModelInfo[]) => {
          const named = resolveWith(known).model;
          return !named || !isMissingFromCatalog(known, named);
        };
        if (!model) inputs.models = [...await readCatalogListing(client, inputs.models, lists)];
        const defaults = resolveWith(inputs.models);
        if (!model && defaults.model) requireListedDefault(inputs.models, defaults.model);
        if (!model) {
          model = defaults.model;
          if (variant == null) variant = defaults.variant;
        }
        agent = agent || defaults.agent;
      }
    }
    if (!model) {
      const error = Object.assign(new Error('No model is configured or available for the requested directory'), { statusCode: 400 });
      throw error;
    }
    if (variant == null && !isAutoModel(model) && !reusedModel) {
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
        void 0;
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
  }: DispatchInput): Promise<DispatchResult> => {
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
      if (routed === null) throw new TypeError("Cannot read properties of null (reading 'model')");
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
        void 0;
      }
    }
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
        onWarning: (message: string, cause: unknown) => console.warn(`[OpenChamberSessions] ${message}:`, (hasMessage(cause) ? cause.message : undefined) || cause),
        persistSessionGoal: async (goalSessionID: string, goalDirectory: string, goal: Awaited<ReturnType<typeof createSessionGoal>>) => {
          await writeMetadata(goalSessionID, { openchamber: { goal } }, goalDirectory);
        },
      });
    }

    const markGoalPartial = (cause: unknown) => {
      if (goalInput.enabled && isGoalError(cause)) cause.goalConfigured = true;
      return cause;
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
        console.warn('[OpenChamberSessions] Failed to read session directory for knowledge sync:', (hasMessage(error) ? error.message : undefined) || error);
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
        const promptInput: PromptInput = { sessionID, text: expandedPrompt };
        if (promptedBySessionId) {
          promptInput.metadata = { openchamber: { promptedBy: await readPromptOrigin(client, promptedBySessionId) } };
        }
        const sent = await client.session.prompt(promptInput);
        landedMessageID = asNonEmptyString(sent?.id);
        if (goalInput.enabled) {
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

  const broadcastMetadata = (sessionID: string, metadata: SessionMetadata | undefined) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:session-metadata',
      properties: { sessionID, metadata },
    });
  };

  const writeMetadata = async (sessionID: string, patch: SessionMetadata, directory = '') => {
    if (persistSessionMetadata) {
      return persistSessionMetadata(sessionID, patch, { directory });
    }
    const metadata = await sessionMetadataStore.setSessionMetadata(sessionID, patch, { directory });
    broadcastMetadata(sessionID, metadata);
    return metadata;
  };

  const setMetadata = (sessionID: string | undefined, payload: SessionPayload = {}) =>
    setSessionMetadata(sessionID, payload, writeMetadata);
  const compareAndSetMetadata = (sessionID: string | undefined, payload: SessionPayload = {}) =>
    compareAndSetSessionMetadata(sessionID, payload, updateMetadata);

  const getMetadata = async (sessionID: string | undefined, directory = '') => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new OpenChamberControlError('a session id is required', 400);
    return { metadata: await sessionMetadataStore.get(id, { directory }) };
  };

  const updateMetadata = async (sessionID: string, decide: MetadataDecider, directory = '') => {
    if (updateSessionMetadata !== null) {
      return updateSessionMetadata(sessionID, decide, { directory });
    }
    const result = await sessionMetadataStore.updateSessionMetadata(sessionID, decide, { directory });
    if (result.changed) broadcastMetadata(sessionID, result.metadata);
    return result;
  };

  const setSessionLinks = async (sessionID: string | undefined, payload: SessionPayload | null = {}) => {
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

  const archive = async (payload: SessionPayload = {}) => {
    const parsed = parseArchiveRequest(payload);
    if (!parsed.ok) {
      throw new OpenChamberControlError(parsed.error, 400);
    }
    return sessionArchive.archive(parsed.ids, parsed.archivedAt);
  };

  const unarchive = async (payload: SessionPayload = {}) => {
    const parsed = parseIdBatch(payload);
    if (!parsed.ok) {
      throw new OpenChamberControlError(parsed.error, 400);
    }
    return sessionArchive.unarchive(parsed.ids);
  };

  const createInDirectory = async (payload: SessionPayload, { titleByUser = false, startedByExtension = null, operatorParentId = null }: CreateOptions = {}, onCreated = () => {}) => {
    const title = asNonEmptyString(payload.title);
    const prompt = asNonEmptyString(payload.prompt);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) {
      throw new OpenChamberControlError(goalInput.error, 400);
    }
    const model = resolveRequestedModel(payload);
    const agent = asNonEmptyString(payload.agent);
    const variant = asNonEmptyString(payload.variant);
    if (!prompt) assertEmptySessionModel(payload, model);

    const resolvedDirectory: ResolvedDirectory = payload.projectId === CHATS_SCOPE_PUBLIC_ID
      ? await validateDirectoryPath(asNonEmptyString(payload.directory)).then((result) => (result.ok ? { ...result, chats: true } : result))
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
    let worktree: SessionMoveWorktree | null = null;
    let sessionDirectory = resolvedDirectory.directory;
    if (payload?.worktree && !worktreeInput && !pullRequestInput) {
      throw new OpenChamberControlError('worktree.name is required when worktree is provided', 400);
    }

    if (waitForOpenCodeReady) await waitForOpenCodeReady(10_000, 250);

    const projectPath = resolvedDirectory.projectPath ?? resolvedDirectory.directory;
    const validatedModel = prompt || model
      ? await validateRequestedSelection({
        directory: resolvedDirectory.directory,
        requestedModel: model,
        requestedAgent: prompt ? agent : null,
        requestedVariant: variant, requireModelMatch: !prompt,
      })
      : null;

    const setup = pullRequestInput || worktreeInput
      ? await worktreeSetupForDirectory(resolvedDirectory.directory)
      : NO_WORKTREE_SETUP;
    const setupInput: SetupInput = {};
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
      const hydrateCheckout = ({ directory, parentRemoteName }: { directory: string; parentRemoteName: string }) => hydrateWorktreeCheckout({
        directory,
        parentDirectory: resolvedDirectory.directory,
        parentRemoteName,
      });
      if (worktreeInput.existingBranch) {
        await assertExistingBranchAvailable(isExistingBranchAvailableLocally, resolvedDirectory.directory, worktreeInput.existingBranch);
      }
      worktree = await createWorktree(resolvedDirectory.directory, { ...worktreeInput, ...setupInput }, {
        bootstrapStore: worktreeBootstrapStore,
        hydrateCheckout,
      });
      sessionDirectory = worktree.path;
    }

    let startDirectoryFallback: StartDirectoryResult['fallback'] = null;
    let client;
    let selection: Selection = { model: prompt ? model : validatedModel, agent, variant };
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
      if (prompt || (variant && !model)) {
        selection = await selectForSession({
          client,
          directory: sessionDirectory,
          projectId: resolvedDirectory.chats ? CHATS_SCOPE_PUBLIC_ID : resolvedDirectory.projectId,
          requestedModel: model,
          requestedAgent: agent,
          requestedVariant: variant,
        });
      }
      if (!prompt && isAutoModel(selection.model)) {
        throw new OpenChamberControlError(EMPTY_SESSION_AUTO_ERROR, 400);
      }
      if (!prompt && selection.model && (worktree || !model)) {
        selection.model = await validateRequestedSelection({
          directory: sessionDirectory,
          requestedModel: model ?? selection.model,
          requestedAgent: null, requestedVariant: variant, requireModelMatch: true,
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
    const createInput: Parameters<typeof createSession>[0] = {
      client,
      directory: sessionDirectory,
      titleByUser,
      startedByExtension,
      operatorParentId,
    };
    if (!prompt) {
      createInput.model = selection.model;
      createInput.variant = selection.variant ?? null;
    }
    if (title) createInput.title = title;
    const sessionID = await createSession(createInput);
    onCreated();

    let dispatch: Selection & Omit<DispatchResult, 'model'> = { ...selection, promptDispatched: false, dispatchedAsCommand: false };
    if (prompt) {
      dispatch = await dispatchPrompt({
        client,
        baseUrl,
        authHeaders,
        sessionID,
        directory: sessionDirectory,
        projectId: resolvedDirectory.chats ? CHATS_SCOPE_PUBLIC_ID : resolvedDirectory.projectId,
        prompt,
        goalInput,
        requestedModel: selection.model,
        requestedAgent: selection.agent,
        requestedVariant: selection.variant,
        promptedBySessionId: asNonEmptyString(payload.promptedBySessionId),
      });
    }

    const result: CreateResult = {
      sessionId: sessionID,
      directory: sessionDirectory,
      promptDispatched: dispatch.promptDispatched,
      dispatchedAsCommand: dispatch.dispatchedAsCommand,
    };
    if (resolvedDirectory.projectId) result.projectId = resolvedDirectory.projectId;
    if (title) result.title = title;
    if (worktree) result.worktree = worktree;
    if (dispatch.model) result.model = dispatch.model;
    if (prompt && dispatch.agent) result.agent = dispatch.agent;
    if (dispatch.variant) result.variant = dispatch.variant;
    if (dispatch.promptError) result.promptError = dispatch.promptError;
    if (goalInput.enabled) result.goalEnabled = true;
    if (goalInput.tokenBudget) result.goalTokenBudget = goalInput.tokenBudget;
    if (startDirectoryFallback) result.startDirectoryFallback = startDirectoryFallback;
    if (setup.untrustedSkipped.length > 0) result.untrustedSetupCommandsSkipped = setup.untrustedSkipped;

    try {
      if (emitSessionCreatedEvent) {
        const event: SessionCreatedEvent = {
          sessionID,
          directory: sessionDirectory,
          promptDispatched: dispatch.promptDispatched,
          dispatchedAsCommand: dispatch.dispatchedAsCommand,
          createdAt: Date.now(),
        };
        if (resolvedDirectory.projectId) event.projectID = resolvedDirectory.projectId;
        if (title) event.title = title;
        if (worktree) event.worktree = worktree;
        if (prompt && dispatch.model) event.model = dispatch.model;
        if (prompt && dispatch.agent) event.agent = dispatch.agent;
        if (prompt && dispatch.variant) event.variant = dispatch.variant;
        if (goalInput.enabled) event.goalEnabled = true;
        if (goalInput.tokenBudget) event.goalTokenBudget = goalInput.tokenBudget;
        emitSessionCreatedEvent(event);
      }
    } catch {
      void 0;
    }

    return result;
  };

  const restoreAfterSend = async (client: SessionClient, sessionID: string) => {
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
      console.warn(`[openchamber-sessions] could not restore ${sessionID} after a send:`, (hasMessage(error) ? error.message : undefined) ?? error);
    }
  };

  const create = async (payload: SessionPayload = {}, options: CreateOptions = {}) => {
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

  const runExisting = async (action: 'send' | 'fork', sourceSessionId: string | undefined, payload: SessionPayload | null = {}) => {
    const sourceSessionID = asNonEmptyString(sourceSessionId);
    if (payload === null) throw new TypeError("Cannot read properties of null (reading 'prompt')");
    const prompt = asNonEmptyString(payload.prompt);
    if (!sourceSessionID) throw new OpenChamberControlError('sessionId is required', 400);
    if (!prompt) throw new OpenChamberControlError('prompt is required', 400);
    const goalInput = resolveGoalInput(payload, prompt);
    if (!goalInput.ok) throw new OpenChamberControlError(goalInput.error, 400);
    const requestedModel = resolveRequestedModel(payload);

    let targetSessionID = sourceSessionID;
    let targetSession = null;
    let directory: string | null = null;
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
      if (waitForOpenCodeReady) await waitForOpenCodeReady(10_000, 250);

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
          writeMetadata: (sessionID, patch) => writeMetadata(sessionID, patch, resolvedDirectory.directory),
          writePermissions: (sessionID, permissions) => client.session.update({ sessionID, permissions }),
          readMessages: (sessionID) => listForkMessages(client, sessionID),
          updatePins: async (sessionID, decide) => { await updateMetadata(sessionID, decide, resolvedDirectory.directory); },
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
        projectId: resolvedDirectory.chats ? CHATS_SCOPE_PUBLIC_ID : resolvedDirectory.projectId,
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
      const result: ExistingResult = {
        action,
        sessionId: targetSessionID,
        directory,
        model: dispatch.model,
        promptDispatched: dispatch.promptDispatched,
        dispatchedAsCommand: dispatch.dispatchedAsCommand,
      };
      if (action === 'fork') result.sourceSessionId = sourceSessionID;
      if (targetSession?.title) result.title = targetSession.title;
      if (baselineAssistantMessageId) result.baselineAssistantMessageId = baselineAssistantMessageId;
      if (baselineIdleRecordId !== undefined) result.baselineIdleRecordId = baselineIdleRecordId;
      if (dispatch.agent) result.agent = dispatch.agent;
      if (dispatch.variant) result.variant = dispatch.variant;
      if (dispatch.promptError) result.promptError = dispatch.promptError;
      if (goalInput.enabled) result.goalEnabled = true;
      if (goalInput.tokenBudget) result.goalTokenBudget = goalInput.tokenBudget;

      if (action === 'fork') {
        try {
          if (emitSessionCreatedEvent) {
            const event: SessionCreatedEvent = {
              sessionID: targetSessionID,
              directory,
              sourceSessionID,
              model: dispatch.model,
              promptDispatched: dispatch.promptDispatched,
              dispatchedAsCommand: dispatch.dispatchedAsCommand,
              createdAt: Date.now(),
            };
            if (targetSession?.title) event.title = targetSession.title;
            if (dispatch.agent) event.agent = dispatch.agent;
            if (dispatch.variant) event.variant = dispatch.variant;
            if (goalInput.enabled) event.goalEnabled = true;
            if (goalInput.tokenBudget) event.goalTokenBudget = goalInput.tokenBudget;
            emitSessionCreatedEvent(event);
          }
        } catch {
          void 0;
        }
      }
      return result;
    } catch (error) {
      const statusCode = Number(controlErrorFields(error)?.statusCode) || 500;
      const forkCreated = action === 'fork' && targetSessionID !== sourceSessionID;
      const goalConfigured = controlErrorFields(error)?.goalConfigured === true;
      const details: ControlErrorDetails = {};
      if (forkCreated || goalConfigured) {
        details.partial = true;
        details.partialAction = forkCreated ? 'fork-created' : 'goal-configured';
        details.sessionId = targetSessionID;
        details.directory = directory;
      }
      throw new OpenChamberControlError(
        error instanceof Error ? error.message : `Failed to ${action} session`,
        statusCode,
        details,
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

  const moveToWorktree = async (sessionID: string, payload: SessionPayload = {}) => {
    if (!(hydrateWorktreeCheckout instanceof Function)
      || !(worktreeBootstrapStore?.read instanceof Function)
      || !(worktreeBootstrapStore?.write instanceof Function)) {
      throw new OpenChamberControlError('Worktree checkout bootstrap is not available', 501);
    }
    await waitForOpenCodeReady?.(10_000, 250);
    return worktreeMover.move({
      sessionId: sessionID,
      directory: asNonEmptyString(payload.directory),
      name: asNonEmptyString(worktreeFields(payload)?.name),
      branchName: asNonEmptyString(worktreeFields(payload)?.branchName),
      startRef: asNonEmptyString(worktreeFields(payload)?.startRef),
      existingBranch: asNonEmptyString(worktreeFields(payload)?.existingBranch),
      carry: payload.carry,
    });
  };

  const resolveDirectory = async (payload: SessionPayload) => {
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
    projectPathFor,
    archive,
    unarchive,
    archiveStore,
    sessionArchive,
    sessionMetadataStore,
    setMetadata,
    compareAndSetMetadata,
    getMetadata,
    setSessionLinks,
    send: (sessionID: string | undefined, payload: SessionPayload | null | undefined) => runExisting('send', sessionID, payload),
    fork: (sessionID: string | undefined, payload: SessionPayload | null | undefined) => runExisting('fork', sessionID, payload),
    moveToWorktree,
  };
};

const sendServiceError = (res: Response, cause: unknown, fallback: string) => {
  const controlError = asControlError(cause, fallback);
  const body: ServiceErrorBody = {
    error: controlError.message,
  };
  if (controlError.partial === true) {
    body.partial = true;
    body.partialAction = controlError.partialAction;
    body.sessionId = controlError.sessionId;
    body.directory = controlError.directory;
  }
  return res.status(controlError.statusCode).json(body);
};

export const registerOpenChamberSessionRoutes = (app: Application, dependencies: SessionServiceDependencies & { sessionService?: ReturnType<typeof createOpenChamberSessionService> }) => {
  const service = dependencies.sessionService || createOpenChamberSessionService(dependencies);

  app.post('/api/openchamber/sessions', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.create(
        isPayload(req.body) ? req.body : {},
        { titleByUser: true },
      ));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to create session:', error);
      return sendServiceError(res, error, 'Failed to create session');
    }
  });

  app.post('/api/openchamber/sessions/archive', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.archive(isPayload(req.body) ? req.body : {}));
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
        isPayload(req.body) ? req.body : {},
      ));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to store session metadata:', error);
      return sendServiceError(res, error, 'Failed to store session metadata');
    }
  });

  registerConditionalMetadataRoute(app, service.compareAndSetMetadata, sendServiceError);

  app.post('/api/openchamber/sessions/unarchive', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.unarchive(isPayload(req.body) ? req.body : {}));
    } catch (error) {
      console.error('[OpenChamberSessions] failed to unarchive sessions:', error);
      return sendServiceError(res, error, 'Failed to unarchive sessions');
    }
  });

  app.post('/api/openchamber/sessions/:sessionId/links', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      return res.json(await service.setSessionLinks(req.params.sessionId, payloadFields(req)));
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
        return res.json(await service.send(req.params.sessionId, payloadFields(req)));
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
        return res.json(await service.fork(req.params.sessionId, payloadFields(req)));
      } catch (error) {
        console.error('[OpenChamberSessions] failed to fork session:', error);
        return sendServiceError(res, error, 'Failed to fork session');
      }
    },
  );
};
