import { asNonEmptyString, isBoolean, isRecord } from '../shared/guards.js';
import { extractTextMessages, type MessageRecord, type TextMessage } from './session-text-messages.js';
import path from 'node:path';
import nodeFsPromises from 'node:fs/promises';
import { OpenCode } from '@opencode/client';
import { OpenChamberControlError, asControlError, controlErrorFields } from './error.js';
import { OPENCHAMBER_ALL_ACTIONS, OPENCHAMBER_KNOWLEDGE_ACTIONS } from './actions.js';
import { writeScreenshot } from './screenshots.js';
import { createProjectKnowledgeActions } from './project-knowledge.js';
import { createPageAnswers, createRenderPageAction, isAgentPrompt } from './render-page.js';
import { completeFormAnswer } from './form-answer.js';
import { createImageGenerationAction } from './generate-image.js';
import { createSecretRequests } from './secret-request.js';
import { createUsageReadAction } from './usage-read.js';
import { createTerminalReadAction } from './terminal-read.js';
import { runWaitAction } from './waits.js';
import { createWorkNamer } from '../openchamber-sessions/work-naming.js';
import { CHATS_SCOPE_PUBLIC_ID } from '../scheduled-tasks/chats-scope.js';
import { createWorkMembership } from '../session-work/membership.js';
import { createSessionListing, positiveInteger } from './session-listing.js';
import { isPinnedMetadata, userStatePatch } from '../session-work/state.js';
import { z } from 'zod';
import { resolveUploadFiles, UploadRefusedError } from '../browser-control/uploads.js';
import type { SessionInfo, ModelInfo, PermissionReplyInput, SessionFormCancelInput, FormInfo } from '@opencode/client';
import type { ControlClient } from './opencode-client.js';
import type { FormValues } from './form-answer.js';
import type { PageAnswerInput } from './render-page.js';
import type { ControlInput, PendingPermission, PublicSessionStatus, SessionMessagesResult, SessionStatusResult, StoredSessionMetadata } from './contracts.js';
import type { ControlErrorFields } from './error.js';
import type { createOpenChamberSessionService } from '../openchamber-sessions/routes.js';
import type { createScheduledTaskService } from '../scheduled-tasks/service.js';
import type { KnowledgeDependencies } from './project-knowledge.js';
import type { ImageGenerationDependencies } from './generate-image.js';
import type { TerminalReadDependencies } from './terminal-read.js';
import type { createUsageReadAction as usageAction } from './usage-read.js';
import type { createFileOpenRequester } from './file-open.js';
import type { createSessionLinker } from '../openchamber-sessions/session-link.js';
import type { createLaterPages } from './later-pages.js';
import type { WaitActionRequest } from './waits.js';
import type { createDispatchResultsRuntime } from '../dispatch-results/runtime.js';
import type { createBrowserControlRouter } from '../browser-control/provider.js';
import type { createUploadStore } from '../browser-control/uploads.js';
import type { ListedSessionRecord } from './listed-session.js';
import type { BrowserControlParameters } from '../browser-control/broker.js';
import type { createAgentMemoryActions } from '../agent-memory/actions.js';
import type { createWorkflowRuntime } from '../workflows/runtime.js';
import type { createLeadActions } from '../session-lead/actions.js';

interface ControlSettings {
  projects?: unknown;
  defaultModel?: unknown;
  defaultVariant?: unknown;
  defaultAgent?: unknown;
  favoriteModels?: unknown;
  recentModels?: unknown;
  hiddenModels?: unknown;
  sessionWorkEnabled?: unknown;
  agentImageToolEnabled?: unknown;
  agentImageModel?: unknown;
  agentUsageToolEnabled?: unknown;
  agentTerminalToolEnabled?: unknown;
}

export interface ControlOptions {
  signal?: AbortSignal | undefined;
  contextSessionId?: string;
  contextCallId?: string;
  startedByExtension?: string;
  secretRunAuthorized?: boolean;
}

export interface ControlDependencies {
  readSettingsFromDiskMigrated: () => Promise<ControlSettings | null>;
  sanitizeProjects: (projects: ControlSettings['projects']) => { id: string; path: string; label?: string }[];
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => HeadersInit;
  waitForOpenCodeReady?: (timeout: number, interval: number) => Promise<void>;
  sessionService: ReturnType<typeof createOpenChamberSessionService>;
  scheduledTaskService: ReturnType<typeof createScheduledTaskService>;
  chatsScope?: { root: string } | null;
  chatRoots?: string[];
  updateSessionMetadata?: ((sessionId: string, update: (metadata: StoredSessionMetadata | undefined) => ReturnType<typeof userStatePatch>, options: { directory: string }) => Promise<{ changed: boolean }>) | null;
  isWorktreePinned?: (directory: string) => Promise<boolean>;
  browserControl?: ReturnType<typeof createBrowserControlRouter> | null;
  browserUploads?: ReturnType<typeof createUploadStore> | null;
  fileOpen?: ReturnType<typeof createFileOpenRequester> | null;
  notifyUser?: ((input: { title: unknown; body: unknown; showWhenFocused: unknown; sessionId: string | undefined; directory: string | undefined }) => Promise<{ status: number; body: { error?: string } }>) | null;
  agentMemoryActions?: { execute: (action: string, input: ControlInput, directory: ControlInput['directory']) => ReturnType<ReturnType<typeof createAgentMemoryActions>['execute']> } | null;
  sessionLinks?: ReturnType<typeof createSessionLinker> | null;
  workNaming?: Omit<Parameters<typeof createWorkNamer>[0], 'getSession' | 'createError'> | null;
  projectContextRuntime?: KnowledgeDependencies['projectContextRuntime'];
  resolveProjectContextId?: KnowledgeDependencies['resolveProjectContextId'];
  isKnowledgeToolEnabled?: () => Promise<boolean>;
  isRenderToolEnabled?: () => Promise<boolean>;
  isSecretToolEnabled?: () => Promise<boolean>;
  getTerminalRuntime?: TerminalReadDependencies['getTerminalRuntime'];
  secretFiles?: Parameters<typeof createSecretRequests>[0]['files'];
  savedSecrets?: Parameters<typeof createSecretRequests>[0]['saved'];
  onPageWaitChange?: NonNullable<Parameters<typeof createPageAnswers>[0]>['onWaitChange'];
  readPendingRequests?: () => { [sessionID: string]: { forms: object[]; pages: object[]; permissions: PendingPermission[] } };
  isPermissionAutoAnswered?: (sessionID: string | undefined, directory: PendingPermission['directory'], permissionID: PendingPermission['id']) => Promise<boolean>;
  showPlan?: KnowledgeDependencies['showPlan'];
  dispatchResults?: ReturnType<typeof createDispatchResultsRuntime> | null;
  prWatch?: WaitActionRequest['prWatch'];
  extensionWaits?: WaitActionRequest['extensionWaits'] | null;
  laterPages?: ReturnType<typeof createLaterPages> | null;
  workflowRuntime?: Pick<ReturnType<typeof createWorkflowRuntime>, 'executeAction'> | null;
  leadActions?: Pick<ReturnType<typeof createLeadActions>, 'execute'> | null;
  sharePages?: Parameters<typeof createRenderPageAction>[0]['sharePages'];
  archiveStore?: { entry: (sessionID: string) => Promise<number | null | undefined> } | null;
  isOpenCodeDirectoryTrusted?: ((directory: string) => Promise<boolean>) | null;
  createClient?: (options: Parameters<typeof OpenCode.make>[0]) => ControlClient;
  imageFsPromises?: ImageGenerationDependencies['fsPromises'];
  loadQuota?: Parameters<typeof usageAction>[0]['loadQuota'] | null;
  sleep?: (duration: number) => Promise<void>;
  now?: () => number;
  isHiddenSession?: (id: string | null, record?: ListedSessionRecord) => boolean;
}

const hasText = (value: unknown): value is string => Boolean(asNonEmptyString(value));
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isIntegerNumber = (value: unknown): value is number => Number.isInteger(value);
const isText = (value: unknown): value is string => typeof value === 'string';
type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
type ControlSession = SessionInfo & { directory?: string; time: SessionInfo['time'] & { archived?: number } };
interface TaskExecution {
  prompt: string;
  providerID?: string;
  modelID?: string;
  agent?: string;
  variant?: string;
  useDefaults?: boolean;
  goalEnabled?: boolean;
  goalTokenBudget?: number;
}
type TaskSchedule =
  | { kind: 'daily'; times: string[]; timezone?: string }
  | { kind: 'weekly'; times: string[]; weekdays: number[]; timezone?: string }
  | { kind: 'once'; date: string; time: string; timezone?: string }
  | { kind: 'cron'; cron: string | null; timezone?: string };
interface ControlTask {
  id?: string;
  loopFile?: string;
  name: string;
  enabled: boolean;
  schedule: TaskSchedule;
  execution: TaskExecution;
  targetSessionId?: unknown;
  runInWorktree?: unknown;
  cleanupWorktree?: unknown;
  baseBranch?: string | null;
}
interface SessionPayload {
  directory?: string;
  projectId?: string;
  title?: string;
  prompt?: string;
  model?: string;
  agent?: string;
  variant?: string;
  goal?: boolean;
  goalTokenBudget?: unknown;
  worktree?: { name?: string; branchName?: string; startRef?: string };
  setUpstream?: boolean;
  messageId?: string;
  pullRequest?: unknown;
  promptedBySessionId?: string;
}
export interface SessionActionResult {
  sessionId: string;
  directory: string;
  projectId?: string;
  title?: string;
  worktree?: object;
  promptDispatched: boolean;
  baselineAssistantMessageId?: string;
  baselineIdleRecordId?: string | null;
  lastAssistantMessage?: TextMessage | null;
}
interface RankPreferences { [rank: string]: string }
type PermissionReply = Mutable<PermissionReplyInput>;
type FormCancellation = Mutable<SessionFormCancelInput>;
interface SessionCreateOptions { startedByExtension?: string; operatorParentId?: string | null }
interface MoveWorktree { name: string | undefined; branchName?: string; startRef?: string; existingBranch?: string }
interface MovePayload { worktree: MoveWorktree; directory?: string; carry?: unknown }

const dialogAnswerSchema = z.object({ accept: z.boolean(), value: z.string().optional() });

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_POLL_INTERVAL_MS = 500;
const CONTROL_ACTIONS = new Set(OPENCHAMBER_ALL_ACTIONS);
const PREFERENCE_BY_RANK: RankPreferences = { 2: 'favorite', 1: 'recent' };
const SCHEDULE_TASK_ID_ACTIONS = new Set([
  'schedule.update',
  'schedule.run',
  'schedule.delete',
  'schedule.toggle',
]);


const normalizeWaitTimeoutMs = (value: ControlInput['timeout']) => {
  const seconds = value === undefined || value === null ? DEFAULT_WAIT_TIMEOUT_SECONDS : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new OpenChamberControlError(`timeout must be from 1 to ${MAX_WAIT_TIMEOUT_SECONDS} seconds`, 400);
  }
  return seconds * 1000;
};

const parseModel = (value: ControlInput['model']) => {
  const model = asNonEmptyString(value);
  if (!model) throw new OpenChamberControlError('model is required', 400);
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new OpenChamberControlError('model must be in provider/model format', 400);
  }
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
};

const parseWeekdays = (value: ControlInput['weekly']) => {
  const raw = asNonEmptyString(value);
  if (!raw) throw new OpenChamberControlError('weekly is required', 400);
  const weekdays = raw.split(',').map((entry) => Number.parseInt(entry.trim(), 10));
  if (weekdays.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 6)) {
    throw new OpenChamberControlError('weekly must contain weekdays from 0 to 6', 400);
  }
  return Array.from(new Set(weekdays)).sort((a, b) => a - b);
};

const buildSchedule = (input: ControlInput): TaskSchedule => {
  const daily = asNonEmptyString(input.daily);
  const weekly = asNonEmptyString(input.weekly);
  const once = asNonEmptyString(input.once);
  const cron = asNonEmptyString(input.cron);
  const selectors = [daily, weekly, once, cron].filter(Boolean);
  if (selectors.length !== 1) {
    throw new OpenChamberControlError('Provide exactly one of daily, weekly, once, or cron', 400);
  }
  const timezone = asNonEmptyString(input.timezone);
  if (daily) {
    const schedule: TaskSchedule = { kind: 'daily', times: [daily] };
    if (timezone) schedule.timezone = timezone;
    return schedule;
  }
  if (weekly) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new OpenChamberControlError('time is required with weekly', 400);
    const schedule: TaskSchedule = { kind: 'weekly', weekdays: parseWeekdays(weekly), times: [time] };
    if (timezone) schedule.timezone = timezone;
    return schedule;
  }
  if (once) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new OpenChamberControlError('time is required with once', 400);
    const schedule: TaskSchedule = { kind: 'once', date: once, time };
    if (timezone) schedule.timezone = timezone;
    return schedule;
  }
  const schedule: TaskSchedule = { kind: 'cron', cron };
  if (timezone) schedule.timezone = timezone;
  return schedule;
};

const assertWorktreeIsolation = (input: ControlInput, targetSessionId: ControlInput['targetSessionId']) => {
  for (const field of ['runInWorktree', 'cleanupWorktree'] as const) {
    if (input[field] !== undefined && !isBoolean(input[field])) {
      throw new OpenChamberControlError(`${field} must be a boolean`, 400);
    }
  }
  const { baseBranch } = input;
  if (baseBranch !== undefined && baseBranch !== null && baseBranch !== '' && !asNonEmptyString(baseBranch)) {
    throw new OpenChamberControlError('baseBranch must be a branch name, or empty to clear it', 400);
  }
  const isolationNamed = (['runInWorktree', 'baseBranch', 'cleanupWorktree'] as const).some((field) => input[field] !== undefined);
  if (isolationNamed && asNonEmptyString(targetSessionId)) {
    throw new OpenChamberControlError('runInWorktree, baseBranch and cleanupWorktree are not compatible with an existing session', 400);
  }
};

const buildScheduledTask = (input: ControlInput) => {
  const name = asNonEmptyString(input.name);
  const prompt = asNonEmptyString(input.prompt);
  if (!name) throw new OpenChamberControlError('name is required', 400);
  if (!prompt) throw new OpenChamberControlError('prompt is required', 400);
  const targetSessionId = asNonEmptyString(input.targetSessionId);
  const model = targetSessionId && input.model === undefined ? { useDefaults: !asNonEmptyString(input.agent) } : parseModel(input.model);
  const goalTokenBudget = input.goalTokenBudget;
  if (goalTokenBudget !== undefined && input.goal !== true) {
    throw new OpenChamberControlError('goalTokenBudget requires goal', 400);
  }
  if (goalTokenBudget !== undefined && (!isSafeInteger(goalTokenBudget) || goalTokenBudget < 1000 || goalTokenBudget > 100_000_000)) {
    throw new OpenChamberControlError('goalTokenBudget must be from 1000 to 100000000', 400);
  }
  assertWorktreeIsolation(input, targetSessionId);
  const baseBranch = asNonEmptyString(input.baseBranch);
  const task: ControlTask = {
    name,
    enabled: input.disabled !== true,
    schedule: buildSchedule(input),
    execution: {
      prompt,
      ...model,
    },
  };
  if (hasText(input.agent)) task.execution.agent = input.agent.trim();
  if (hasText(input.variant)) task.execution.variant = input.variant.trim();
  if (input.goal === true) task.execution.goalEnabled = true;
  if (goalTokenBudget !== undefined) task.execution.goalTokenBudget = goalTokenBudget;
  if (input.targetSessionId !== undefined) task.targetSessionId = targetSessionId ?? input.targetSessionId;
  if (input.runInWorktree === true) task.runInWorktree = true;
  if (input.cleanupWorktree === false) task.cleanupWorktree = false;
  if (baseBranch) task.baseBranch = baseBranch;
  return task;
};

const patchScheduledTask = (existing: ControlTask & { id: string }, input: ControlInput) => {
  if (existing.loopFile) {
    throw new OpenChamberControlError(`This task comes from ${existing.loopFile}; change that file instead`, 409);
  }
  const execution = { ...existing.execution };
  if (input.prompt !== undefined) {
    const prompt = asNonEmptyString(input.prompt);
    if (!prompt) throw new OpenChamberControlError('prompt cannot be empty', 400);
    execution.prompt = prompt;
  }
  if (input.model !== undefined) {
    Object.assign(execution, parseModel(input.model));
    delete execution.variant;
    delete execution.useDefaults;
  }
  for (const field of ['variant', 'agent'] as const) {
    if (input[field] === undefined) continue;
    const value = asNonEmptyString(input[field]);
    if (value) execution[field] = value;
    else delete execution[field];
    if (field === 'agent' && value && (input.targetSessionId || existing.targetSessionId)) delete execution.useDefaults;
  }
  if (isBoolean(input.goal)) {
    if (input.goal) execution.goalEnabled = true;
    else {
      delete execution.goalEnabled;
      delete execution.goalTokenBudget;
    }
  }
  if (input.goalTokenBudget !== undefined) {
    if (!execution.goalEnabled) throw new OpenChamberControlError('goalTokenBudget requires goal', 400);
    if (!isSafeInteger(input.goalTokenBudget) || input.goalTokenBudget < 1000 || input.goalTokenBudget > 100_000_000) {
      throw new OpenChamberControlError('goalTokenBudget must be from 1000 to 100000000', 400);
    }
    execution.goalTokenBudget = input.goalTokenBudget;
  }
  let name: string | null = existing.name;
  if (input.name !== undefined) {
    name = asNonEmptyString(input.name);
    if (!name) throw new OpenChamberControlError('name cannot be empty', 400);
  }
  const selectors = (['daily', 'weekly', 'once', 'cron'] as const).filter((key) => input[key] !== undefined);
  if (selectors.length > 1 || (selectors.length === 1 && !asNonEmptyString(input[selectors[0] ?? 'daily']))) {
    throw new OpenChamberControlError('Provide exactly one nonempty daily, weekly, once, or cron selector', 400);
  }
  const timezone = asNonEmptyString(input.timezone);
  let schedule = selectors.length === 1
    ? buildSchedule(input)
    : (timezone ? { ...existing.schedule, timezone } : existing.schedule);
  if (input.time !== undefined) {
    const time = asNonEmptyString(input.time);
    if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new OpenChamberControlError('time must be HH:mm', 400);
    }
    if (schedule.kind === 'once') {
      schedule = { ...schedule, time };
    } else if (schedule.kind === 'weekly' && schedule.times.length === 1) {
      schedule = { ...schedule, times: [time] };
    } else {
      throw new OpenChamberControlError('time requires a once or single-time weekly schedule; provide an explicit schedule to replace other schedules', 400);
    }
  }

  assertWorktreeIsolation(
    input,
    input.targetSessionId === undefined ? existing.targetSessionId : input.targetSessionId,
  );
  const patch: ControlTask = {
    id: existing.id,
    targetSessionId: input.targetSessionId === undefined ? existing.targetSessionId : input.targetSessionId,
    name,
    enabled: isBoolean(input.disabled) ? !input.disabled : existing.enabled,
    schedule,
    execution,
  };
  if (input.runInWorktree !== undefined) patch.runInWorktree = input.runInWorktree;
  if (input.cleanupWorktree !== undefined) patch.cleanupWorktree = input.cleanupWorktree;
  if (input.baseBranch !== undefined) patch.baseBranch = asNonEmptyString(input.baseBranch);
  return patch;
};

export const createOpenChamberControlService = (dependencies: ControlDependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    sessionService,
    chatsScope = null,
    chatRoots = [],
    updateSessionMetadata = null,
    isWorktreePinned = async () => false,
    scheduledTaskService,
    browserControl = null,
    browserUploads = null,
    fileOpen = null,
    notifyUser = null,
    agentMemoryActions = null,
    sessionLinks = null,
    workNaming = null,
    projectContextRuntime = null,
    resolveProjectContextId = null,
    isKnowledgeToolEnabled = async () => true,
    isRenderToolEnabled = async () => true,
    isSecretToolEnabled = async () => true,
    getTerminalRuntime = null,
    secretFiles = null,
    savedSecrets = null,
    onPageWaitChange = () => {},
    readPendingRequests = (): ReturnType<NonNullable<ControlDependencies['readPendingRequests']>> => ({}),
    isPermissionAutoAnswered = async () => false,
    showPlan = null,
    dispatchResults = null,
    prWatch = null,
    extensionWaits = null,
    laterPages = null,
    workflowRuntime = null,
    leadActions = null,
    sharePages = null,
    archiveStore = null,
    isOpenCodeDirectoryTrusted = null,
    createClient = OpenCode.make,
    imageFsPromises = nodeFsPromises,
    loadQuota = null,
    sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    now = Date.now,
    isHiddenSession = () => false,
  } = dependencies;

  const wait = (duration: number, signal?: AbortSignal) => {
    if (!signal) return sleep(duration);
    if (signal.aborted) return Promise.reject(new OpenChamberControlError('OpenChamber action was cancelled', 499));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new OpenChamberControlError('OpenChamber action was cancelled', 499));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      sleep(duration).then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  };

  const getClient = async (directory: string | null = ''): Promise<ControlClient> => {
    if (directory && isOpenCodeDirectoryTrusted && !(await isOpenCodeDirectoryTrusted(directory))) {
      throw new OpenChamberControlError(
        `OpenCode is paused for ${directory}: its configuration runs plugins or commands the user has not trusted. Ask the user to open the folder in OpenChamber and trust it.`,
        403,
      );
    }
    if (waitForOpenCodeReady) await waitForOpenCodeReady(10_000, 250);
    const baseUrl = new URL(buildOpenCodeUrl('/api/info', '')).origin;
    const headers = { ...getOpenCodeAuthHeaders() };
    if (directory) Object.assign(headers, { 'x-opencode-directory': encodeURIComponent(directory) });
    return createClient({
      baseUrl,
      headers,
      fetch,
    });
  };

  const workNamer = workNaming ? createWorkNamer({
    ...workNaming,
    getSession: async (sessionID) => {
      const client = await getClient();
      return client.session.get({ sessionID }).catch(() => null);
    },
    renameSession: async (sessionID, title) => {
      const client = await getClient((await resolveSessionDirectory(sessionID)) ?? '');
      await client.session.update({ sessionID, title });
    },
    createError: (message, status) => new OpenChamberControlError(message, status),
  }) : null;

  const withArchiveEntry = async (session: ControlSession): Promise<ControlSession> => {
    if (!archiveStore || !session?.id) return session;
    const entry = await archiveStore.entry(session.id);
    if (entry === undefined) return session;
    if (entry !== null) return { ...session, time: { ...session.time, archived: entry } };
    const { archived: _archived, ...time } = session.time ?? {};
    return { ...session, time };
  };

  const projects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const configured = sanitizeProjects(settings?.projects || []).map((project) => ({
      id: project.id,
      path: path.resolve(project.path),
      label: asNonEmptyString(project.label) || path.basename(project.path) || project.path,
    }));
    return chatsScope
      ? [...configured, { id: CHATS_SCOPE_PUBLIC_ID, path: chatsScope.root, label: 'Chats' }]
      : configured;
  };

  const assertSingleScope = (input: ControlInput) => {
    if (asNonEmptyString(input.projectId) && asNonEmptyString(input.directory)) {
      throw new OpenChamberControlError('Provide only one of projectId or directory', 400);
    }
  };

  const resolveReadDirectory = async (input: ControlInput, contextDirectory: ControlInput['directory']) => {
    assertSingleScope(input);
    const projectID = asNonEmptyString(input.projectId);
    if (!projectID) return asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
    return sessionService.resolveDirectory({ projectId: projectID });
  };

  const knowledgeActions = createProjectKnowledgeActions({
    projectContextRuntime,
    resolveProjectContextId,
    isEnabled: isKnowledgeToolEnabled,
    showPlan,
    resolveDirectory: (input) => sessionService.resolveDirectory(input),
  });

  const hasUnreadChat = async (sessionID: string) => {
    try {
      const client = await getClient();
      const items = await client.session.inbox.list({ sessionID });
      return items.some((item) => item.type === 'user' && item.delivery === 'steer' && !isAgentPrompt(item.payload?.metadata));
    } catch (error) {
      console.warn('[render.page] could not read the session inbox:', controlErrorFields(error)?.message ?? error);
      return false;
    }
  };
  const pageAnswers = createPageAnswers({ onWaitChange: onPageWaitChange });
  const readSession = async (sessionID: string) => (await getClient()).session.get({ sessionID });
  const renderPage = createRenderPageAction({ isEnabled: isRenderToolEnabled, pageAnswers, hasUnreadChat, readSession, laterPages, sharePages });
  const secretRequests = createSecretRequests({ isEnabled: isSecretToolEnabled, files: secretFiles, saved: savedSecrets, onWaitChange: onPageWaitChange, hasUnreadChat });
  const generateImage = createImageGenerationAction({
    getClient,
    readSettings: readSettingsFromDiskMigrated,
    fsPromises: imageFsPromises,
  });
  const readUsage = loadQuota ? createUsageReadAction({ readSettings: readSettingsFromDiskMigrated, loadQuota }) : null;
  const readTerminal = createTerminalReadAction({ readSettings: readSettingsFromDiskMigrated, getTerminalRuntime });

  const models = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return {
      defaultModel: asNonEmptyString(settings?.defaultModel),
      defaultVariant: asNonEmptyString(settings?.defaultVariant),
      defaultAgent: asNonEmptyString(settings?.defaultAgent),
      favoriteModels: Array.isArray(settings?.favoriteModels) ? settings.favoriteModels : [],
      recentModels: Array.isArray(settings?.recentModels) ? settings.recentModels : [],
    };
  };

  const searchModels = async (input: ControlInput, contextDirectory: ControlInput['directory']) => {
    const client = await getClient(asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory) || '');
    const [settings, catalog, providerList] = await Promise.all([
      readSettingsFromDiskMigrated(),
      client.model.list(),
      client.provider.list(),
    ]);
    const providerNames = new Map(providerList.data.map((provider) => [provider.id, provider.name]));
    const refKey = (ref: ControlSettings['recentModels']) => {
      const fields: { providerID?: unknown; modelID?: unknown } | undefined = ref == null ? undefined : Object(ref);
      return `${fields?.providerID}/${fields?.modelID}`;
    };
    const modelKey = (model: ModelInfo) => `${model.providerID}/${model.id}`;
    const refs = (value: ControlSettings['hiddenModels']) => new Set((Array.isArray(value) ? value : []).map(refKey));
    const hidden = refs(settings?.hiddenModels);
    const rank = new Map([
      ...[...refs(settings?.recentModels)].map((key) => [key, 1] as const),
      ...[...refs(settings?.favoriteModels)].map((key) => [key, 2] as const),
    ]);
    const provider = asNonEmptyString(input.provider)?.toLowerCase();
    const terms = (asNonEmptyString(input.query) ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const candidates = catalog.data
      .filter((model) => !hidden.has(modelKey(model)))
      .filter((model) => !provider
        || model.providerID.toLowerCase() === provider
        || providerNames.get(model.providerID)?.toLowerCase() === provider)
      .filter((model) => {
        const text = `${modelKey(model)} ${model.name}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      });
    const familyOf = (model: ModelInfo) => `${model.providerID}/${model.family}`;
    const newestOfFamily = new Map<string, number>();
    for (const model of candidates) {
      if (!model.family || rank.has(modelKey(model))) continue;
      newestOfFamily.set(familyOf(model), Math.max(newestOfFamily.get(familyOf(model)) ?? 0, model.time.released));
    }
    const matching = candidates
      .toSorted((left, right) => (rank.get(modelKey(right)) ?? 0) - (rank.get(modelKey(left)) ?? 0)
        || left.providerID.localeCompare(right.providerID)
        || right.time.released - left.time.released)
      .filter((model) => input.all === true || !model.family || rank.has(modelKey(model))
        || model.time.released >= Number(newestOfFamily.get(familyOf(model))));
    const offset = isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0;
    const limit = isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 10;
    const page = matching.slice(offset, offset + limit);
    return {
      models: page.map((model) => ({
        id: modelKey(model),
        name: model.name,
        provider: providerNames.get(model.providerID) ?? model.providerID,
        preference: PREFERENCE_BY_RANK[String(rank.get(modelKey(model)))],
        released: model.time.released,
        variants: model.variants.map((variant) => variant.id),
        cost: model.cost,
        status: model.status,
      })),
      total: matching.length,
      next: offset + limit < matching.length ? offset + limit : null,
    };
  };

  const activeSessions = async (client: ControlClient) => {
    const statuses = await client.session.active();
    if (!isRecord(statuses)) {
      throw new OpenChamberControlError('Invalid session status response', 500);
    }
    return Object.fromEntries(Object.entries(statuses).filter(([id]) => !isHiddenSession(id)));
  };

  const isWaitingForUser = async (sessionID: string | undefined) => {
    const pending = readPendingRequests()[String(sessionID)];
    if (!pending) return false;
    if (pending.forms.length > 0 || pending.pages.length > 0) return true;
    const answered = await Promise.all(pending.permissions.map((permission) =>
      isPermissionAutoAnswered(sessionID, permission.directory, permission.id)));
    return answered.includes(false);
  };

  const asPublicStatus = async (statuses: Awaited<ReturnType<typeof activeSessions>>, sessionID: string | undefined): Promise<PublicSessionStatus> => {
    if (!statuses[String(sessionID)]) return { type: 'idle' };
    return await isWaitingForUser(sessionID) ? { type: 'waiting' } : { type: 'busy' };
  };

  const sessionStatus = async (client: ControlClient, sessionID: string) => asPublicStatus(await activeSessions(client), sessionID);

  const assertSessionExists = async (client: ControlClient, sessionID: string) => {
    try {
      return await client.session.get({ sessionID });
    } catch (error) {
      if (controlErrorFields(error)?._tag === 'SessionNotFoundError' || controlErrorFields(error)?._tag === 'InvalidRequestError') {
        throw new OpenChamberControlError(`Session not found: ${sessionID}`, 404);
      }
      throw new OpenChamberControlError(
        `Could not check whether session ${sessionID} exists: ${error instanceof Error ? error.message : String(error)}`,
        503,
      );
    }
  };

  const workMembership = createWorkMembership({ chatRoots });
  const isSessionWorkEnabled = async () => {
    const settings = await readSettingsFromDiskMigrated().catch(() => null);
    return settings?.sessionWorkEnabled !== false;
  };

  const { listSessions, archiveOwnSession } = createSessionListing({
    assertSingleScope,
    resolveReadDirectory,
    isSessionWorkEnabled,
    getClient,
    activeSessions,
    asPublicStatus,
    withArchiveEntry,
    isHiddenSession,
    workMembership,
    assertSessionExists,
    sessionService,
  });

  const setWorkState = async (input: ControlInput, contextSessionId: string | undefined, state: 'open' | 'done') => {
    if (!updateSessionMetadata) throw new OpenChamberControlError('Changing In work is not available on this server', 503);
    if (!(await isSessionWorkEnabled())) throw new OpenChamberControlError('In work is turned off in Settings', 409);
    const sessionID = asNonEmptyString(input.sessionId) || asNonEmptyString(contextSessionId);
    if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
    const session = await withArchiveEntry(await assertSessionExists(await getClient(), sessionID));
    if (state === 'open' && !workMembership.canBeInWork(session)) {
      throw new OpenChamberControlError(`${sessionID} cannot be in work: subsessions, Chats, reviews, /btw questions and scheduled runs never are`, 400);
    }
    if (state === 'open' && session?.time?.archived) {
      throw new OpenChamberControlError(`${sessionID} is archived; In work shows no archived sessions`, 409);
    }
    const directory = asNonEmptyString(session?.location?.directory) || '';
    if (state === 'open' && (isPinnedMetadata(session?.metadata) || (directory && await isWorktreePinned(directory)))) {
      throw new OpenChamberControlError(`${sessionID} is pinned, or its worktree is; a pinned session is never in work`, 409);
    }
    const { changed } = await updateSessionMetadata(sessionID, (metadata) => userStatePatch(metadata, { state, now: now() }), { directory });
    return { sessionId: sessionID, directory, title: asNonEmptyString(session?.title), inWork: state === 'open', changed };
  };

  const MESSAGE_PAGE_LIMIT = 200;
  const sessionMessages = async (client: ControlClient, sessionID: string, role: string, limit: number | undefined) => {
    const fetchLimit = limit === undefined ? undefined : Math.max(100, limit * 4);
    const collected: MessageRecord[] = [];
    const seenCursors = new Set();
    let cursor;
    for (;;) {
      const response = await client.message.list({
        sessionID,
        limit: fetchLimit ?? MESSAGE_PAGE_LIMIT,
        ...(cursor ? { cursor } : fetchLimit ? { order: 'desc' } : {}),
      });
      const raw = Array.isArray(response?.data) ? response.data : [];
      collected.push(...raw);
      const next = asNonEmptyString(response?.cursor?.next);
      if (!next || raw.length === 0 || seenCursors.has(next)) break;
      if (limit !== undefined && extractTextMessages(collected, role).length >= limit) break;
      seenCursors.add(next);
      cursor = next;
    }
    const messages = extractTextMessages(collected, role);
    return limit === undefined ? messages : messages.slice(-limit);
  };

  const waitForIdle = async ({ client, sessionID, timeoutMs, requireActivity, baselineMessageID, startedAt, signal }: { client: ControlClient; sessionID: string; directory: string; timeoutMs: number; requireActivity: boolean; baselineMessageID?: string | undefined; startedAt: number; signal: AbortSignal | undefined }) => {
    const deadline = now() + timeoutMs;
    let observedActivity = false;
    while (true) {
      if (signal?.aborted) throw new OpenChamberControlError('OpenChamber action was cancelled', 499);
      const status = await sessionStatus(client, sessionID);
      if (status.type === 'waiting') return status;
      if (status.type === 'busy') {
        observedActivity = true;
      } else if (!requireActivity || observedActivity) {
        return status;
      } else {
        const messages = await sessionMessages(client, sessionID, 'assistant', 1);
        const message = messages[0];
        if (message?.completedAt && (baselineMessageID ? message.id !== baselineMessageID : message.completedAt >= startedAt)) {
          return status;
        }
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new OpenChamberControlError(`Session did not become idle within ${Math.ceil(timeoutMs / 1000)} seconds`, 500);
      }
      await wait(Math.min(WAIT_POLL_INTERVAL_MS, remaining), signal);
    }
  };

  const resolveSessionDirectory = async (sessionID: string) => {
    try {
      const client = await getClient();
      let detail: ControlSession | null = null;
      try {
        detail = await client.session.get({ sessionID }).catch(() => null);
      } catch {
        detail = null;
      }
      const direct = asNonEmptyString(detail?.location?.directory) || asNonEmptyString(detail?.directory);
      if (direct) return direct;

      const seenCursors = new Set();
      let cursor;
      for (;;) {
        const response = await client.session.list(cursor ? { cursor } : {});
        const sessions = Array.isArray(response?.data) ? response.data : [];
        const session = sessions.find((item) => item?.id === sessionID);
        if (session) return asNonEmptyString(session?.location?.directory) || null;
        const next = asNonEmptyString(response?.cursor?.next);
        if (!next || seenCursors.has(next)) return null;
        seenCursors.add(next);
        cursor = next;
      }
    } catch {
      return null;
    }
  };

  const sessionClient = async (sessionID: string) => {
    const directory = await resolveSessionDirectory(sessionID);
    if (!directory) throw new OpenChamberControlError(`Session not found: ${sessionID}`, 404);
    return getClient(directory);
  };

  const GONE_TAGS = new Set(['SessionNotFoundError', 'PermissionNotFoundError', 'FormNotFoundError', 'FormAlreadySettledError']);
  const isGoneTag = (value: ControlErrorFields['_tag']): value is string => isText(value) && GONE_TAGS.has(value);
  const asAnswerError = (error: Parameters<typeof controlErrorFields>[0]) => {
    const fields = controlErrorFields(error);
    if (isGoneTag(fields?._tag)) return new OpenChamberControlError('This request is no longer waiting for an answer', 404);
    if (fields?._tag === 'FormInvalidAnswerError' || fields?._tag === 'InvalidRequestError') {
      return new OpenChamberControlError(`OpenCode refused the answer: ${fields.message || fields._tag}`, 400);
    }
    return asControlError(error, 'OpenCode did not take the answer');
  };

  const stopSession = async (sessionID: string) => {
    const client = await sessionClient(sessionID);
    try {
      const result = await client.session.interrupt({ sessionID });
      return result?.interrupted === true;
    } catch (error) {
      throw asAnswerError(error);
    }
  };

  const answerPermission = async ({ sessionID, requestID, decision, message }: PermissionReplyInput) => {
    const client = await sessionClient(sessionID);
    try {
      const reply: PermissionReply = { sessionID, requestID, decision };
      if (message) reply.message = message;
      await client.permission.reply(reply);
    } catch (error) {
      throw asAnswerError(error);
    }
  };

  const answerForm = async ({ sessionID, formID, answer, message }: { sessionID: string; formID: string; answer?: FormValues | null; message?: string | undefined }) => {
    const client = await sessionClient(sessionID);
    try {
      if (!answer) {
        const cancellation: FormCancellation = { sessionID, formID };
        if (message) cancellation.message = message;
        await client.session.form.cancel(cancellation);
        return;
      }
      const form = await client.session.form.get({ sessionID, formID });
      await client.session.form.reply({ sessionID, formID, answer: completeFormAnswer(form?.fields, answer) });
    } catch (error) {
      throw asAnswerError(error);
    }
  };

  const dismissOpenForms = async (sessionID: string) => {
    const client = await sessionClient(sessionID);
    let forms: (FormInfo & { state?: { status?: string } })[];
    try {
      forms = await client.session.form.list({ sessionID });
    } catch (error) {
      throw asAnswerError(error);
    }
    for (const form of Array.isArray(forms) ? forms : []) {
      if (!asNonEmptyString(form?.id) || (form.state && form.state.status !== 'pending')) continue;
      try {
        await client.session.form.cancel({ sessionID, formID: form.id });
      } catch (error) {
        if (!isGoneTag(controlErrorFields(error)?._tag)) throw asAnswerError(error);
      }
    }
  };

  const assertReturnResult = (action: string, input: ControlInput, parentSessionID: string | null) => {
    if (input.wait === true) throw new OpenChamberControlError('returnResult cannot be combined with wait', 400);
    if (!dispatchResults) throw new OpenChamberControlError('Returning a session result is not available on this server', 503);
    if (!parentSessionID) throw new OpenChamberControlError('returnResult needs a calling session to deliver the result to', 400);
    if (!asNonEmptyString(input.prompt)) throw new OpenChamberControlError('returnResult requires prompt', 400);
    if (action === 'session.send' && asNonEmptyString(input.sessionId) === parentSessionID) {
      throw new OpenChamberControlError('returnResult cannot deliver a session\'s result to itself', 400);
    }
    return { dispatchResults, parentSessionID };
  };

  const RESULT_PENDING_NOTE = 'The session runs in the background. Its answer will be delivered to you automatically as a message when its turn ends, and you will continue from there; a session you run with ownWork keeps sending each later answer the same way until it is archived. Do not poll, sleep, or call session.messages to wait for it; carry on with other work or end your turn.';

  const scheduleResultDelivery = async (result: SessionActionResult, delivery: ReturnType<typeof assertReturnResult>, dispatchedAt: number) => {
    const { dispatchResults, parentSessionID } = delivery;
    const afterIdleId = result.baselineIdleRecordId;
    if (result.promptDispatched !== true) {
      return { status: 'not-scheduled', reason: 'The prompt was not dispatched, so there is no result to return.' };
    }
    try {
      const registration: Parameters<typeof dispatchResults.register>[0] = {
        parentSessionId: parentSessionID,
        sessionId: result.sessionId,
        dispatchedAt,
      };
      if (afterIdleId !== undefined) registration.afterIdleId = afterIdleId;
      await dispatchResults.register(registration);
      return { status: 'pending', note: RESULT_PENDING_NOTE };
    } catch (error) {
      return {
        status: 'not-scheduled',
        reason: `The session runs, but its result will not be delivered: ${error instanceof Error ? error.message : String(error)}. Read it later with session.messages if the user asks.`,
      };
    }
  };

  const executeSessionAction = async (action: string, input: ControlInput, contextDirectory: ControlInput['directory'], signal: AbortSignal | undefined, contextSessionId: string | undefined, startedByExtension: string | undefined) => {
    for (const name of ['wait', 'returnResult', 'ownWork'] as const) {
      if (input[name] !== undefined && !isBoolean(input[name])) throw new OpenChamberControlError(`${name} must be a boolean`, 400);
    }
    if (input.timeout !== undefined && input.wait !== true) throw new OpenChamberControlError('timeout requires wait', 400);
    if (input.lastAssistant === true && input.wait !== true) throw new OpenChamberControlError('lastAssistant requires wait', 400);
    assertSingleScope(input);
    if (input.pullRequest !== undefined && action !== 'session.create') {
      throw new OpenChamberControlError('pullRequest applies only to session.create', 400);
    }
    const sessionID = asNonEmptyString(input.sessionId);
    const parentSessionID = asNonEmptyString(contextSessionId);
    const ownWork = input.ownWork === true;
    if (ownWork && action !== 'session.create') throw new OpenChamberControlError('ownWork applies only to session.create', 400);
    if (ownWork && !parentSessionID) throw new OpenChamberControlError('ownWork needs a calling session to nest the new session under', 400);
    const returnResult = input.returnResult === true
      || (ownWork && input.returnResult === undefined && input.wait !== true && Boolean(dispatchResults) && Boolean(asNonEmptyString(input.prompt)));
    const delivery = returnResult ? assertReturnResult(action, input, parentSessionID) : null;
    let directory = asNonEmptyString(input.directory) || (!input.projectId ? asNonEmptyString(contextDirectory) : null);
    if (sessionID && action !== 'session.create' && !asNonEmptyString(input.directory) && !input.projectId) {
      const resolvedSessionDirectory = await resolveSessionDirectory(sessionID);
      if (resolvedSessionDirectory) directory = resolvedSessionDirectory;
    }
    const payload: SessionPayload = {};
    if (directory) payload.directory = directory;
    if (hasText(input.projectId)) payload.projectId = input.projectId.trim();
    if (hasText(input.title)) payload.title = input.title.trim();
    if (hasText(input.prompt)) payload.prompt = input.prompt.trim();
    if (hasText(input.model)) payload.model = input.model.trim();
    if (hasText(input.agent)) payload.agent = input.agent.trim();
    if (hasText(input.variant)) payload.variant = input.variant.trim();
    if (input.goal === true) payload.goal = true;
    if (input.goalTokenBudget !== undefined) payload.goalTokenBudget = input.goalTokenBudget;
    if (hasText(input.worktree)) {
      payload.worktree = { name: input.worktree.trim() };
      if (hasText(input.branch)) payload.worktree.branchName = input.branch.trim();
      if (hasText(input.startRef)) payload.worktree.startRef = input.startRef.trim();
    }
    if (isBoolean(input.setUpstream)) payload.setUpstream = input.setUpstream;
    if (hasText(input.messageId)) payload.messageId = input.messageId.trim();
    if (input.pullRequest !== undefined) {
      payload.pullRequest = input.pullRequest;
      if (!payload.worktree) {
        payload.worktree = {};
        if (hasText(input.branch)) payload.worktree.branchName = input.branch.trim();
        if (hasText(input.startRef)) payload.worktree.startRef = input.startRef.trim();
      }
    }
    if (parentSessionID && !(action === 'session.send' && sessionID === parentSessionID)) {
      payload.promptedBySessionId = parentSessionID;
    }
    const startedAt = now();
    let result: SessionActionResult;
    if (action === 'session.create') {
      const createOptions: SessionCreateOptions = {};
      if (startedByExtension) createOptions.startedByExtension = startedByExtension;
      if (ownWork) createOptions.operatorParentId = parentSessionID;
      result = await sessionService.create(payload, ...(Object.keys(createOptions).length > 0 ? [createOptions] : []));
    } else {
      if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
      if (action === 'session.send') {
        result = await sessionService.send(sessionID, payload);
      } else {
        result = await sessionService.fork(sessionID, payload);
      }
    }
    if (delivery) {
      const publicResult = { ...result, resultDelivery: await scheduleResultDelivery(result, delivery, startedAt) };
      delete publicResult.baselineAssistantMessageId;
      delete publicResult.baselineIdleRecordId;
      return publicResult;
    }
    if (input.wait !== true) {
      const publicResult = { ...result };
      delete publicResult.baselineAssistantMessageId;
      delete publicResult.baselineIdleRecordId;
      return publicResult;
    }
    const client = await getClient(result.directory);
    const status = await waitForIdle({
      client,
      sessionID: result.sessionId,
      directory: result.directory,
      timeoutMs: normalizeWaitTimeoutMs(input.timeout),
      requireActivity: result.promptDispatched === true,
      baselineMessageID: result.baselineAssistantMessageId,
      startedAt,
      signal,
    });
    const publicResult: SessionActionResult & { sessionStatus: typeof status } = { ...result, sessionStatus: status };
    delete publicResult.baselineAssistantMessageId;
    delete publicResult.baselineIdleRecordId;
    if (input.lastAssistant === true) {
      publicResult.lastAssistantMessage = (await sessionMessages(client, result.sessionId, 'assistant', 1))[0] || null;
    }
    return publicResult;
  };

  const browserAction = async (browserControl: NonNullable<ControlDependencies['browserControl']>, action: string, input: ControlInput, signal: AbortSignal | undefined, contextDirectory: ControlInput['directory'], contextSessionId: string | undefined) => {
    const parameters: BrowserControlParameters = {};
    const tabId = asNonEmptyString(input.tabId);
    if (tabId) {
      if (tabId.length > 128) throw new OpenChamberControlError('tabId must be an id from browser.snapshot tabs', 400);
      parameters.tabId = tabId;
    }

    const readViewport = (required: boolean) => {
      const viewport = asNonEmptyString(input.viewport);
      if (!viewport) {
        if (required) throw new OpenChamberControlError('viewport is required for browser.resize', 400);
        return;
      }
      const isViewport = (value: string): value is NonNullable<BrowserControlParameters['viewport']> => ['mobile', 'tablet', 'desktop', 'fill'].includes(value);
      if (!isViewport(viewport)) {
        throw new OpenChamberControlError('viewport must be mobile, tablet, desktop, or fill', 400);
      }
      parameters.viewport = viewport;
    };

    if (action === 'browser.resize') readViewport(true);

    if (action === 'browser.capture') {
      const label = asNonEmptyString(input.label);
      if (label) parameters.label = label;
    }

    if (action === 'browser.open') {
      readViewport(false);
      const url = asNonEmptyString(input.url);
      if (!url) throw new OpenChamberControlError('url is required for browser.open', 400);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new OpenChamberControlError('url must be an absolute http(s) URL', 400);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new OpenChamberControlError('url must use http or https', 400);
      }
      parameters.url = parsed.toString();
    }

    const readTarget = ({ required, allowText = false, refKey = 'ref', selectorKey = 'selector' }: { required: boolean; allowText?: boolean; refKey?: 'ref' | 'to'; selectorKey?: 'selector' | 'toSelector' }) => {
      const ref = asNonEmptyString(input[refKey]);
      const selector = asNonEmptyString(input[selectorKey]);
      const text = allowText ? asNonEmptyString(input.text) : '';
      if (ref) {
        if (!/^e\d{1,6}$/.test(ref)) throw new OpenChamberControlError(`${refKey} must be a ref from browser.snapshot, such as e12`, 400);
        parameters[refKey] = ref;
      }
      if (selector) parameters[selectorKey] = selector;
      if (text) parameters.text = text;
      if (required && !ref && !selector && !text) {
        const names = allowText ? `${refKey}, ${selectorKey} or text` : `${refKey} or ${selectorKey}`;
        throw new OpenChamberControlError(`${action} requires ${names}`, 400);
      }
    };

    if (input.dialog !== undefined && action !== 'browser.dialog') {
      if (input.dialog !== 'accept' && input.dialog !== 'dismiss') {
        throw new OpenChamberControlError('dialog must be accept or dismiss', 400);
      }
      parameters.dialog = input.dialog;
    }

    if (action === 'browser.click' || action === 'browser.hover') readTarget({ required: true, allowText: true });

    if (action === 'browser.snapshot') {
      const selector = asNonEmptyString(input.selector);
      if (selector) parameters.selector = selector;
    }

    if (action === 'browser.inspect') readTarget({ required: true });

    if (action === 'browser.type') {
      readTarget({ required: true });
      if (!isText(input.value)) {
        throw new OpenChamberControlError('value is required for browser.type', 400);
      }
      parameters.value = input.value;
      parameters.submit = input.submit === true;
    }

    if (action === 'browser.select') {
      readTarget({ required: true });
      const hasLabel = isText(input.label);
      const hasValue = isText(input.value);
      if (hasLabel === hasValue) {
        throw new OpenChamberControlError('browser.select requires exactly one of label or value', 400);
      }
      if (hasLabel) parameters.label = input.label;
      else if (hasValue) parameters.value = input.value;
    }

    if (action === 'browser.scroll') {
      const direction = asNonEmptyString(input.direction);
      readTarget({ required: !direction });
      const isDirection = (value: string): value is NonNullable<BrowserControlParameters['direction']> => ['up', 'down', 'top', 'bottom'].includes(value);
      if (direction) {
        if (!isDirection(direction)) {
          throw new OpenChamberControlError('direction must be up, down, top, or bottom', 400);
        }
        parameters.direction = direction;
      }
    }

    if (action === 'browser.drag') {
      readTarget({ required: true });
      readTarget({ required: true, refKey: 'to', selectorKey: 'toSelector' });
    }

    if (action === 'browser.press') {
      const key = asNonEmptyString(input.key);
      if (!key || key.length > 40) throw new OpenChamberControlError('key is required, such as Enter, Escape, Tab or Meta+a', 400);
      parameters.key = key;
      readTarget({ required: false });
    }

    if (action === 'browser.dialog') {
      const answer = dialogAnswerSchema.safeParse(input);
      if (!answer.success) {
        throw new OpenChamberControlError('accept is required for browser.dialog: true to accept, false to dismiss', 400);
      }
      parameters.accept = answer.data.accept;
      if (answer.data.value !== undefined) parameters.value = answer.data.value;
    }

    if (action === 'browser.wait') {
      const text = asNonEmptyString(input.text);
      if (text) parameters.text = text;
      else readTarget({ required: true });
      if (input.gone === true) parameters.gone = true;
      if (input.timeoutMs !== undefined) {
        const timeout = Number(input.timeoutMs);
        if (!Number.isFinite(timeout) || timeout < 0) throw new OpenChamberControlError('timeoutMs must be a number of milliseconds', 400);
        parameters.timeoutMs = Math.min(15_000, Math.round(timeout));
      }
    }

    if (action === 'browser.upload') {
      readTarget({ required: true });
      if (!browserUploads) throw new OpenChamberControlError('Uploads are not available on this server', 503);
      let files;
      try {
        files = await resolveUploadFiles({ paths: input.paths, directory: asNonEmptyString(contextDirectory) });
      } catch (error) {
        if (error instanceof UploadRefusedError) throw new OpenChamberControlError(error.message, 400);
        throw error;
      }
      parameters.upload = browserUploads.put(files);
    }

    const timeoutMs = action === 'browser.open' || action === 'browser.upload' ? 45_000 : 20_000;
    const context = {
      directory: asNonEmptyString(contextDirectory),
      sessionId: asNonEmptyString(contextSessionId),
    };
    const result = await browserControl.request(action, parameters, { signal, timeoutMs, context });

    if (action === 'browser.capture') {
      const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
      if (!directory) {
        throw new OpenChamberControlError('directory is required to save a screenshot', 400);
      }
      const isCapture = (value: unknown): value is { base64?: unknown; mime?: unknown; url?: unknown; title?: unknown; viewport?: unknown; width?: unknown; height?: unknown } => Boolean(value) && typeof value === 'object';
      const capture = isCapture(result) ? result : {};
      const saved = await writeScreenshot({
        directory,
        base64: capture.base64,
        mime: capture.mime,
        label: input.label,
      });
      return {
        path: saved.path,
        hint: `Write ![](${saved.path}) in your reply to show this image to the user; it is rendered under your message.`,
        url: capture.url ?? null,
        title: capture.title ?? null,
        viewport: capture.viewport ?? null,
        width: capture.width ?? null,
        height: capture.height ?? null,
      };
    }

    return result;
  };

  const execute = async (action: string, input: ControlInput = {}, contextDirectory?: ControlInput['directory'], options: ControlOptions = {}) => {
    try {
      if (!CONTROL_ACTIONS.has(action)) {
        throw new OpenChamberControlError(`Unsupported OpenChamber action: ${action || 'missing'}`, 400);
      }
      if (OPENCHAMBER_KNOWLEDGE_ACTIONS.includes(action)) {
        return await knowledgeActions.execute(action, input, contextDirectory, options.contextSessionId);
      }
      if (action.startsWith('memory.')) {
        if (!agentMemoryActions) {
          throw new OpenChamberControlError('Agent memory is not available on this server', 503);
        }
        return agentMemoryActions.execute(action, input, contextDirectory);
      }
      if (action.startsWith('browser.')) {
        if (!browserControl) {
          throw new OpenChamberControlError('The in-app browser is not available on this server', 503);
        }
        return browserAction(browserControl, action, input, options.signal, contextDirectory, options.contextSessionId);
      }
      if (action === 'notify.send') {
        if (!notifyUser) {
          throw new OpenChamberControlError('Notifications are not available on this server', 503);
        }
        const result = await notifyUser({
          title: input.title,
          body: input.body,
          showWhenFocused: input.showWhenFocused,
          sessionId: asNonEmptyString(options.contextSessionId) || undefined,
          directory: asNonEmptyString(contextDirectory) || undefined,
        });
        if (result.status !== 200) {
          throw new OpenChamberControlError(result.body.error, result.status);
        }
        return result.body;
      }
      if (action.startsWith('workflow.')) {
        if (!workflowRuntime) throw new OpenChamberControlError('Workflows are not available on this server', 503);
        return await workflowRuntime.executeAction(action, input, {
          sessionId: asNonEmptyString(options.contextSessionId),
          directory: asNonEmptyString(contextDirectory),
        });
      }
      if (action === 'render.page') {
        return await renderPage(input, {
          sessionId: asNonEmptyString(options.contextSessionId),
          callId: asNonEmptyString(options.contextCallId),
          directory: asNonEmptyString(contextDirectory),
          signal: options.signal,
        });
      }
      if (action === 'image.generate') {
        return await generateImage(input, { directory: asNonEmptyString(contextDirectory), signal: options.signal });
      }
      if (action === 'usage.read') {
        if (!readUsage) throw new OpenChamberControlError('Usage is not available on this server', 503);
        return await readUsage(input, { signal: options.signal });
      }
      if (action.startsWith('terminal.')) {
        return await readTerminal(action, input, contextDirectory);
      }
      if (action.startsWith('secret.')) {
        return await secretRequests.execute(action, input, {
          sessionId: asNonEmptyString(options.contextSessionId),
          callId: asNonEmptyString(options.contextCallId),
          directory: asNonEmptyString(contextDirectory),
          signal: options.signal,
          authorized: options.secretRunAuthorized === true,
        });
      }
      if (action === 'file.open') {
        if (!fileOpen) {
          throw new OpenChamberControlError('The file viewer is not available on this server', 503);
        }
        return fileOpen.request({
          path: asNonEmptyString(input.path),
          directory: asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory),
          sessionId: asNonEmptyString(options.contextSessionId),
        });
      }
      if (action === 'projects.list') return { projects: await projects() };
      if (action === 'models.list') return models();
      if (action === 'models.search') return searchModels(input, contextDirectory);
      if (action === 'schedule.status') return scheduledTaskService.status();
      if (action.startsWith('schedule.')) {
        const taskID = asNonEmptyString(input.taskId);
        if (SCHEDULE_TASK_ID_ACTIONS.has(action) && !taskID) {
          throw new OpenChamberControlError('taskId is required', 400);
        }
        const explicitProjectID = asNonEmptyString(input.projectId);
        const explicitDirectory = asNonEmptyString(input.directory);
        const contextDirectoryFallback = explicitProjectID
          ? undefined
          : asNonEmptyString(contextDirectory) || undefined;
        const projectID = await scheduledTaskService.resolveProjectID({
          projectId: explicitProjectID || undefined,
          directory: explicitDirectory || contextDirectoryFallback,
        });
        switch (action) {
          case 'schedule.list':
            return { scheduler: await scheduledTaskService.status(), tasks: await scheduledTaskService.list(projectID) };
          case 'schedule.create': {
            const task = buildScheduledTask(input);
            const result = await scheduledTaskService.upsert(projectID, task);
            return { task: result.task, created: result.created };
          }
          case 'schedule.update': {
            const existing = (await scheduledTaskService.list(projectID)).find((task: ControlTask & { id: string }) => task.id === taskID);
            if (!existing) throw new OpenChamberControlError(`Scheduled task not found: ${taskID}`, 404);
            const task = patchScheduledTask(existing, input);
            const result = await scheduledTaskService.upsert(projectID, task);
            return { task: result.task, updated: true };
          }
          case 'schedule.run':
            return scheduledTaskService.run(projectID, taskID);
          case 'schedule.delete':
            return { deleted: true, tasks: await scheduledTaskService.remove(projectID, taskID) };
          case 'schedule.toggle': {
            if (!isBoolean(input.disabled)) {
              throw new OpenChamberControlError('disabled is required for schedule.toggle', 400);
            }
            const task = await scheduledTaskService.setEnabled(projectID, taskID, input.disabled === false);
            return { task, enabled: task?.enabled === true };
          }
        }
      }
      if (action === 'session.create' || action === 'session.send' || action === 'session.fork') {
        return executeSessionAction(action, input, contextDirectory, options.signal, options.contextSessionId, options.startedByExtension);
      }
      if (action === 'session.link' || action === 'session.unlink') {
        if (!sessionLinks) throw new OpenChamberControlError('Linking is not available on this server', 503);
        assertSingleScope(input);
        const explicitSessionID = asNonEmptyString(input.sessionId);
        const sessionID = explicitSessionID || asNonEmptyString(options.contextSessionId);
        const directory = asNonEmptyString(input.directory)
          || (explicitSessionID ? await resolveSessionDirectory(explicitSessionID) : null)
          || asNonEmptyString(contextDirectory);
        const link = input.link ?? { url: input.url, title: input.title, kind: input.kind, identifier: input.identifier };
        if (action === 'session.unlink') {
          const target: Parameters<typeof sessionLinks.unlink>[0]['target'] = Object(link);
          return sessionLinks.unlink({ sessionId: sessionID, directory, target });
        }
        return sessionLinks.link({ sessionId: sessionID, directory, link });
      }
      if (action === 'pr.watch' || action === 'pr.unwatch') {
        if (!prWatch) throw new OpenChamberControlError('Waiting on a pull request is not available on this server', 503);
        const sessionID = asNonEmptyString(options.contextSessionId);
        if (!sessionID) throw new OpenChamberControlError(`${action} must be called from a session`, 400);
        try {
          if (action === 'pr.unwatch') return await prWatch.unwatch(sessionID, input.url);
          const directory = (await resolveSessionDirectory(sessionID)) || asNonEmptyString(contextDirectory);
          return await prWatch.watch({ sessionID, directory, url: input.url });
        } catch (error) {
          const fields = controlErrorFields(error);
          throw new OpenChamberControlError(`${fields?.message ?? String(error)}`, isIntegerNumber(fields?.status) ? fields.status : 500);
        }
      }
      if (action === 'wait.list' || action === 'wait.start' || action === 'wait.stop') {
        if (!extensionWaits) throw new OpenChamberControlError('Waits are not available on this server', 503);
        const sessionID = asNonEmptyString(options.contextSessionId);
        if (!sessionID) throw new OpenChamberControlError(`${action} must be called from a session`, 400);
        try {
          const resolveDirectory = async () => (await resolveSessionDirectory(sessionID)) || asNonEmptyString(contextDirectory);
          return await runWaitAction({ action, input, sessionID, extensionWaits, prWatch, resolveDirectory });
        } catch (error) {
          if (error instanceof OpenChamberControlError) throw error;
          const fields = controlErrorFields(error);
          throw new OpenChamberControlError(`${fields?.message ?? String(error)}`, isIntegerNumber(fields?.status) ? fields.status : 500);
        }
      }
      if (action === 'work.name') {
        if (!workNamer) throw new OpenChamberControlError('Naming tasks is not available on this server', 503);
        const sessionID = asNonEmptyString(input.sessionId) || asNonEmptyString(options.contextSessionId);
        return workNamer.name({ sessionId: sessionID, title: input.title, branch: input.branch });
      }
      if (action === 'session.moveToWorktree') {
        assertSingleScope(input);
        const explicitSessionID = asNonEmptyString(input.sessionId);
        const sessionID = explicitSessionID || asNonEmptyString(options.contextSessionId);
        if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
        const directory = (await resolveSessionDirectory(sessionID)) || asNonEmptyString(contextDirectory);
        const worktree: MoveWorktree = { name: asNonEmptyString(input.worktree)?.trim() };
        const branch = asNonEmptyString(input.branch);
        if (branch) worktree.branchName = branch.trim();
        const startRef = asNonEmptyString(input.startRef);
        if (startRef) worktree.startRef = startRef.trim();
        const existingBranch = asNonEmptyString(input.existingBranch);
        if (existingBranch) worktree.existingBranch = existingBranch.trim();
        const payload: MovePayload = { worktree };
        if (directory) payload.directory = directory;
        if (input.carry !== undefined) payload.carry = input.carry;
        const moved = await sessionService.moveToWorktree(sessionID, payload);
        if (workNamer && !existingBranch && moved?.worktree?.path) {
          await workNamer.carryToWorktree({ sessionId: sessionID, worktree: moved.worktree.path })
            .catch((error) => console.warn('Failed to carry the task name into the new worktree:', error instanceof Error ? error.message : String(error)));
        }
        return moved;
      }
      if (action === 'session.markDone' || action === 'session.track') {
        return setWorkState(input, options.contextSessionId, action === 'session.track' ? 'open' : 'done');
      }
      if (action === 'session.list') return listSessions(input, contextDirectory, options.contextSessionId);
      if (action === 'session.archive') return archiveOwnSession(input, options.contextSessionId);
      if (action.startsWith('lead.')) {
        if (!leadActions) throw new OpenChamberControlError('Leads are not available on this server', 503);
        return leadActions.execute(action, input, asNonEmptyString(options.contextSessionId));
      }
      if (action.startsWith('session.')) {
        const sessionID = asNonEmptyString(input.sessionId);
        if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
        const scoped = asNonEmptyString(input.projectId) || asNonEmptyString(input.directory);
        const directory = (!scoped && await resolveSessionDirectory(sessionID))
          || await resolveReadDirectory(input, contextDirectory);
        const client = await getClient(directory);
        if (!directory) throw new OpenChamberControlError('directory is required', 400);
        if (action === 'session.status') {
          await assertSessionExists(client, sessionID);
          return { sessionId: sessionID, directory, sessionStatus: await sessionStatus(client, sessionID) } satisfies SessionStatusResult;
        }
        if (action === 'session.messages') {
          if (input.timeout !== undefined && input.wait !== true) throw new OpenChamberControlError('timeout requires wait', 400);
          const role = input.lastAssistant === true ? 'assistant' : (asNonEmptyString(input.role) || 'all');
          if (!['all', 'user', 'assistant'].includes(role)) throw new OpenChamberControlError('role must be all, user, or assistant', 400);
          const last = input.last === true || input.lastAssistant === true;
          if (input.all === true && (last || input.limit !== undefined)) throw new OpenChamberControlError('all cannot be combined with last or limit', 400);
          if (last && input.limit !== undefined) throw new OpenChamberControlError('last cannot be combined with limit', 400);
          await assertSessionExists(client, sessionID);
          const currentStatus = input.wait === true
            ? await waitForIdle({ client, sessionID, directory, timeoutMs: normalizeWaitTimeoutMs(input.timeout), requireActivity: false, startedAt: now(), signal: options.signal })
            : await sessionStatus(client, sessionID);
          const limit = input.all === true ? undefined : (last ? 1 : positiveInteger(input.limit, 10, 'limit'));
          return { sessionId: sessionID, directory, role, sessionStatus: currentStatus, messages: await sessionMessages(client, sessionID, role, limit) } satisfies SessionMessagesResult;
        }
      }
      throw new OpenChamberControlError(`Unsupported OpenChamber action: ${action || 'missing'}`, 400);
    } catch (error) {
      throw asControlError(error, `Failed to execute ${action || 'OpenChamber action'}`);
    }
  };

  const releaseAnswerWaits = (sessionId: string) => {
    pageAnswers.release(sessionId);
    secretRequests.release(sessionId);
  };
  const answerPage = (input: PageAnswerInput) => {
    try {
      return pageAnswers.answer(input);
    } catch (error) {
      if (!laterPages || controlErrorFields(error)?.statusCode !== 404) throw error;
      return laterPages.answer(input);
    }
  };
  return {
    execute,
    resolveSessionDirectory,
    answerPage,
    answerSecret: secretRequests.answer,
    secretFields: secretRequests.fields,
    forgetSavedSecret: secretRequests.forgetSaved,
    releaseAnswerWaits,
    stopSession,
    answerPermission,
    answerForm,
    dismissOpenForms,
  };
};
