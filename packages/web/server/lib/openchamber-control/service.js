import { asNonEmptyString, isBoolean } from '../shared/guards.js';
import path from 'node:path';
import nodeFsPromises from 'node:fs/promises';
import { OpenCode } from '@opencode/client';
import { OpenChamberControlError, asControlError } from './error.js';
import { OPENCHAMBER_ALL_ACTIONS, OPENCHAMBER_KNOWLEDGE_ACTIONS } from './actions.js';
import { writeScreenshot } from './screenshots.js';
import { createProjectKnowledgeActions } from './project-knowledge.js';
import { createPageAnswers, createRenderPageAction } from './render-page.js';
import { createImageGenerationAction } from './generate-image.js';
import { createSecretRequests } from './secret-request.js';
import { createWorkNamer } from '../openchamber-sessions/work-naming.js';

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_POLL_INTERVAL_MS = 500;
// One service, both capabilities: which tool asked is the caller's concern.
const CONTROL_ACTIONS = new Set(OPENCHAMBER_ALL_ACTIONS);
// models.search ranks a favorite 2 and a recent model 1.
const PREFERENCE_BY_RANK = { 2: 'favorite', 1: 'recent' };
const SCHEDULE_TASK_ID_ACTIONS = new Set([
  'schedule.update',
  'schedule.run',
  'schedule.delete',
  'schedule.toggle',
]);

const positiveInteger = (value, fallback, field) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new OpenChamberControlError(`${field} must be a positive integer`, 400);
  }
  return number;
};

const normalizeWaitTimeoutMs = (value) => {
  const seconds = value === undefined || value === null ? DEFAULT_WAIT_TIMEOUT_SECONDS : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new OpenChamberControlError(`timeout must be from 1 to ${MAX_WAIT_TIMEOUT_SECONDS} seconds`, 400);
  }
  return seconds * 1000;
};

// v2 messages are not { info, parts }: the record itself is the message, a
// user message carries `text`, and an assistant message carries `content[]`
// whose text items are the visible answer.
const messageText = (record) => {
  if (record.type === 'user') return typeof record.text === 'string' ? record.text.trim() : '';
  return (Array.isArray(record.content) ? record.content : [])
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
    .trim();
};

const extractTextMessages = (messages, role = 'all') => {
  const result = [];
  for (const record of Array.isArray(messages) ? messages : []) {
    const messageRole = record?.type;
    if ((messageRole !== 'user' && messageRole !== 'assistant') || (role !== 'all' && role !== messageRole)) continue;
    const text = messageText(record);
    if (!text) continue;
    const providerID = asNonEmptyString(record.model?.providerID);
    const modelID = asNonEmptyString(record.model?.id);
    result.push({
      id: asNonEmptyString(record.id) || '',
      role: messageRole,
      createdAt: Number.isFinite(record?.time?.created) ? record.time.created : null,
      completedAt: Number.isFinite(record?.time?.completed) ? record.time.completed : null,
      model: providerID && modelID ? `${providerID}/${modelID}` : null,
      text,
    });
  }
  return result.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
};

const parseModel = (value) => {
  const model = asNonEmptyString(value);
  if (!model) throw new OpenChamberControlError('model is required', 400);
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex === model.length - 1) {
    throw new OpenChamberControlError('model must be in provider/model format', 400);
  }
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
};

const parseWeekdays = (value) => {
  const raw = asNonEmptyString(value);
  if (!raw) throw new OpenChamberControlError('weekly is required', 400);
  const weekdays = raw.split(',').map((entry) => Number.parseInt(entry.trim(), 10));
  if (weekdays.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 6)) {
    throw new OpenChamberControlError('weekly must contain weekdays from 0 to 6', 400);
  }
  return Array.from(new Set(weekdays)).sort((a, b) => a - b);
};

const buildSchedule = (input) => {
  const daily = asNonEmptyString(input.daily);
  const weekly = asNonEmptyString(input.weekly);
  const once = asNonEmptyString(input.once);
  const cron = asNonEmptyString(input.cron);
  const selectors = [daily, weekly, once, cron].filter(Boolean);
  if (selectors.length !== 1) {
    throw new OpenChamberControlError('Provide exactly one of daily, weekly, once, or cron', 400);
  }
  const timezone = asNonEmptyString(input.timezone);
  if (daily) return { kind: 'daily', times: [daily], ...(timezone ? { timezone } : {}) };
  if (weekly) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new OpenChamberControlError('time is required with weekly', 400);
    return { kind: 'weekly', weekdays: parseWeekdays(weekly), times: [time], ...(timezone ? { timezone } : {}) };
  }
  if (once) {
    const time = asNonEmptyString(input.time);
    if (!time) throw new OpenChamberControlError('time is required with once', 400);
    return { kind: 'once', date: once, time, ...(timezone ? { timezone } : {}) };
  }
  return { kind: 'cron', cron, ...(timezone ? { timezone } : {}) };
};

const buildScheduledTask = (input) => {
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
  if (goalTokenBudget !== undefined && (!Number.isSafeInteger(goalTokenBudget) || goalTokenBudget < 1000 || goalTokenBudget > 100_000_000)) {
    throw new OpenChamberControlError('goalTokenBudget must be from 1000 to 100000000', 400);
  }
  const task = {
    name,
    enabled: input.disabled !== true,
    schedule: buildSchedule(input),
    execution: {
      prompt,
      ...model,
      ...(asNonEmptyString(input.agent) ? { agent: input.agent.trim() } : {}),
      ...(asNonEmptyString(input.variant) ? { variant: input.variant.trim() } : {}),
      ...(input.goal === true ? { goalEnabled: true } : {}),
      ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
    },
  };
  if (input.targetSessionId !== undefined) task.targetSessionId = targetSessionId ?? input.targetSessionId;
  return task;
};

/**
 * `schedule.update`: the stored task with only the fields the call names
 * changed. The id and the run state stay, so history and references survive;
 * the scheduler re-arms from the new schedule on save.
 */
const patchScheduledTask = (existing, input) => {
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
    // A thinking level belongs to the model it was chosen for.
    delete execution.variant;
    delete execution.useDefaults;
  }
  for (const field of ['variant', 'agent']) {
    if (input[field] === undefined) continue;
    const value = asNonEmptyString(input[field]);
    if (value) execution[field] = value;
    else delete execution[field];
    if (field === 'agent' && value && (input.targetSessionId || existing.targetSessionId)) delete execution.useDefaults;
  }
  if (typeof input.goal === 'boolean') {
    if (input.goal) execution.goalEnabled = true;
    else {
      delete execution.goalEnabled;
      delete execution.goalTokenBudget;
    }
  }
  if (input.goalTokenBudget !== undefined) {
    if (!execution.goalEnabled) throw new OpenChamberControlError('goalTokenBudget requires goal', 400);
    if (!Number.isSafeInteger(input.goalTokenBudget) || input.goalTokenBudget < 1000 || input.goalTokenBudget > 100_000_000) {
      throw new OpenChamberControlError('goalTokenBudget must be from 1000 to 100000000', 400);
    }
    execution.goalTokenBudget = input.goalTokenBudget;
  }
  let name = existing.name;
  if (input.name !== undefined) {
    name = asNonEmptyString(input.name);
    if (!name) throw new OpenChamberControlError('name cannot be empty', 400);
  }
  const replacesSchedule = ['daily', 'weekly', 'once', 'cron'].some((key) => asNonEmptyString(input[key]));
  const timezone = asNonEmptyString(input.timezone);
  const schedule = replacesSchedule
    ? buildSchedule(input)
    : (timezone ? { ...existing.schedule, timezone } : existing.schedule);
  return {
    id: existing.id,
    targetSessionId: input.targetSessionId === undefined ? existing.targetSessionId : input.targetSessionId,
    name,
    enabled: typeof input.disabled === 'boolean' ? !input.disabled : existing.enabled,
    schedule,
    execution,
  };
};

export const createOpenChamberControlService = (dependencies) => {
  const {
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    sessionService,
    scheduledTaskService,
    browserControl = null,
    fileOpen = null,
    notifyUser = null,
    agentMemoryActions = null,
    sessionLinks = null,
    // Git and metadata access for `work.name`; absent means the server cannot name tasks.
    workNaming = null,
    projectContextRuntime = null,
    resolveProjectContextId = null,
    isKnowledgeToolEnabled = async () => true,
    isRenderToolEnabled = async () => true,
    isSecretToolEnabled = async () => true,
    // Where `secret.request` writes what the user saves
    // (`createSecretFiles`); absent means the server cannot take secrets.
    secretFiles = null,
    // Hears when a page an agent shows starts and stops waiting for the
    // user's answer (render.page with awaitAnswer, and secret.request).
    onPageWaitChange = () => {},
    // Puts a plan in front of the user; answers how many windows it reached.
    showPlan = null,
    // Delivers a dispatched session's result back to the session that asked
    // (`returnResult`); absent means the server cannot offer it.
    dispatchResults = null,
    // An agent waiting on its pull request (../pr-watch); absent means the
    // server cannot offer it.
    prWatch = null,
    // Agent workflows (../workflows/runtime.js); absent where they are not
    // available, which is every build without OPENCHAMBER_WORKFLOWS_ENABLE.
    workflowRuntime = null,
    // Archive lives in OpenChamber's own store now — v2 has no route that sets
    // Session.time.archived — so an unwired store simply means nothing is archived.
    archiveStore = null,
    // Whether OpenCode may open a folder (../opencode-trust); absent opens every folder.
    isOpenCodeDirectoryTrusted = null,
    createClient = OpenCode.make,
    // Reads an agent's reference images and writes the generated ones.
    imageFsPromises = nodeFsPromises,
    sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    now = Date.now,
  } = dependencies;

  const wait = (duration, signal) => {
    if (!signal) return sleep(duration);
    if (signal.aborted) return Promise.reject(new OpenChamberControlError('OpenChamber action was cancelled', 499));
    return new Promise((resolve, reject) => {
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

  // Every v2 route lives under /api and the client appends it, so it only
  // wants the origin. Per-directory scoping is a request header.
  const getClient = async (directory = '') => {
    // An agent can name any folder, a pull request checkout included. One whose
    // OpenCode configuration runs code waits until the user trusts it in the app.
    if (directory && isOpenCodeDirectoryTrusted && !(await isOpenCodeDirectoryTrusted(directory))) {
      throw new OpenChamberControlError(
        `OpenCode is paused for ${directory}: its configuration runs plugins or commands the user has not trusted. Ask the user to open the folder in OpenChamber and trust it.`,
        403,
      );
    }
    if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
    return createClient({
      baseUrl: new URL(buildOpenCodeUrl('/api/info', '')).origin,
      headers: {
        ...getOpenCodeAuthHeaders(),
        ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
      },
      fetch,
    });
  };

  const workNamer = workNaming ? createWorkNamer({
    ...workNaming,
    getSession: async (sessionID) => {
      const client = await getClient();
      return client.session.get({ sessionID }).catch(() => null);
    },
    renameSession: async (sessionID, title, directory) => {
      const client = await getClient(directory);
      await client.session.update({ sessionID, title });
    },
    createError: (message, status) => new OpenChamberControlError(message, status),
  }) : null;

  // OpenCode holds archive state; the archive file holds it for sessions whose
  // directory is gone, and its entry wins: a timestamp archives, null restores.
  const withArchiveEntry = async (session) => {
    if (!archiveStore || !session?.id) return session;
    const entry = await archiveStore.entry(session.id);
    if (entry === undefined) return session;
    if (entry !== null) return { ...session, time: { ...session.time, archived: entry } };
    const { archived: _archived, ...time } = session.time ?? {};
    return { ...session, time };
  };

  const projects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []).map((project) => ({
      id: project.id,
      path: path.resolve(project.path),
      label: asNonEmptyString(project.label) || path.basename(project.path) || project.path,
    }));
  };

  // projectId and directory are two names for one scope. Accepting both let
  // one silently win over the other, so every session action refuses the pair.
  const assertSingleScope = (input) => {
    if (asNonEmptyString(input.projectId) && asNonEmptyString(input.directory)) {
      throw new OpenChamberControlError('Provide only one of projectId or directory', 400);
    }
  };

  // An explicit projectId scopes a session read to that project's directory,
  // resolved the same way create/send/fork resolve it. An unknown project is
  // an error, never a silent read of the caller's directory or of every project.
  const resolveReadDirectory = async (input, contextDirectory) => {
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

  // A message the user steered into the turn stays in OpenCode's inbox until
  // a step ends. A queued one waits for the turn to end, so the page's call
  // returning would not deliver it. A failed read counts as none, so the page
  // waits as it did before this check.
  const hasUnreadChat = async (sessionID) => {
    try {
      const client = await getClient();
      const items = await client.session.inbox.list({ sessionID });
      return items.some((item) => item.type === 'user' && item.delivery === 'steer');
    } catch (error) {
      console.warn('[render.page] could not read the session inbox:', error?.message ?? error);
      return false;
    }
  };
  const pageAnswers = createPageAnswers({ onWaitChange: onPageWaitChange });
  const renderPage = createRenderPageAction({ isEnabled: isRenderToolEnabled, pageAnswers, hasUnreadChat });
  const secretRequests = createSecretRequests({ isEnabled: isSecretToolEnabled, files: secretFiles, onWaitChange: onPageWaitChange, hasUnreadChat });
  const generateImage = createImageGenerationAction({
    getClient,
    readSettings: readSettingsFromDiskMigrated,
    fsPromises: imageFsPromises,
  });

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

  /**
   * `models.search`: the catalog of the caller's directory, the way the model
   * picker sees it. Models the user hid in the picker stay out, favorites and
   * then recent models come first, and only the newest of a family shows
   * unless `all` asks for older versions. OpenCode's own `models` tool is
   * removed from the agent's list in favour of this one.
   */
  const searchModels = async (input, contextDirectory) => {
    const client = await getClient(asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory) || '');
    const [settings, catalog, providerList] = await Promise.all([
      readSettingsFromDiskMigrated(),
      client.model.list(),
      client.provider.list(),
    ]);
    const providerNames = new Map(providerList.data.map((provider) => [provider.id, provider.name]));
    const refKey = (ref) => `${ref?.providerID}/${ref?.modelID}`;
    const modelKey = (model) => `${model.providerID}/${model.id}`;
    const refs = (value) => new Set((Array.isArray(value) ? value : []).map(refKey));
    const hidden = refs(settings?.hiddenModels);
    // 2 for a favorite, 1 for a recent model, absent for the rest.
    const rank = new Map([
      ...[...refs(settings?.recentModels)].map((key) => [key, 1]),
      ...[...refs(settings?.favoriteModels)].map((key) => [key, 2]),
    ]);
    const provider = asNonEmptyString(input.provider)?.toLowerCase();
    const terms = (asNonEmptyString(input.query) ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const shownFamilies = new Set();
    const matching = catalog.data
      .filter((model) => !hidden.has(modelKey(model)))
      .filter((model) => !provider
        || model.providerID.toLowerCase() === provider
        || providerNames.get(model.providerID)?.toLowerCase() === provider)
      .filter((model) => {
        const text = `${modelKey(model)} ${model.name}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .toSorted((left, right) => (rank.get(modelKey(right)) ?? 0) - (rank.get(modelKey(left)) ?? 0)
        || left.providerID.localeCompare(right.providerID)
        || right.time.released - left.time.released)
      // Newest first within a provider, so the first of a family is its newest.
      .filter((model) => {
        if (input.all === true || !model.family || rank.has(modelKey(model))) return true;
        const family = `${model.providerID}/${model.family}`;
        if (shownFamilies.has(family)) return false;
        shownFamilies.add(family);
        return true;
      });
    const offset = Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0;
    const limit = Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 10;
    const page = matching.slice(offset, offset + limit);
    return {
      models: page.map((model) => ({
        id: modelKey(model),
        name: model.name,
        provider: providerNames.get(model.providerID) ?? model.providerID,
        // Absent for a model the user has not picked; JSON drops the undefined.
        preference: PREFERENCE_BY_RANK[rank.get(modelKey(model))],
        released: model.time.released,
        variants: model.variants.map((variant) => variant.id),
        cost: model.cost,
        status: model.status,
      })),
      total: matching.length,
      next: offset + limit < matching.length ? offset + limit : null,
    };
  };

  // /api/session/active is global in v2 and reports only `{ type: 'running' }`.
  // The action contract stays busy/idle, so running is reported as busy.
  const activeSessions = async (client) => {
    const statuses = await client.session.active();
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
      throw new OpenChamberControlError('Invalid session status response', 500);
    }
    return statuses;
  };

  const asPublicStatus = (active) => (active ? { type: 'busy' } : { type: 'idle' });

  const sessionStatus = async (client, sessionID) => {
    const statuses = await activeSessions(client);
    return asPublicStatus(statuses[sessionID]);
  };

  // The message list is cursor-paginated and `order: 'desc'` puts the newest
  // messages in the page, so a single call returns only the recent tail.
  // `all: true` walks `cursor.next` until the history is exhausted; a bounded
  // `limit` stops once enough text messages are collected. Later pages carry
  // the order inside the cursor, and OpenCode rejects a cursor combined with
  // `order`, so only the first page sends it. An empty page or a repeated
  // cursor ends the walk. `extractTextMessages` sorts the gathered records
  // oldest-first for the caller.
  const MESSAGE_PAGE_LIMIT = 200;
  const sessionMessages = async (client, sessionID, role, limit) => {
    const fetchLimit = limit === undefined ? undefined : Math.max(100, limit * 4);
    const collected = [];
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
      // A bounded read only needs enough pages to project `limit` text messages.
      if (limit !== undefined && extractTextMessages(collected, role).length >= limit) break;
      seenCursors.add(next);
      cursor = next;
    }
    const messages = extractTextMessages(collected, role);
    return limit === undefined ? messages : messages.slice(-limit);
  };

  const waitForIdle = async ({ client, sessionID, directory, timeoutMs, requireActivity, baselineMessageID, startedAt, signal }) => {
    const deadline = now() + timeoutMs;
    let observedActivity = false;
    while (true) {
      if (signal?.aborted) throw new OpenChamberControlError('OpenChamber action was cancelled', 499);
      const status = await sessionStatus(client, sessionID);
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

  // session.send/fork default the directory to the caller's context directory,
  // which is wrong for sessions living in other worktrees: the prompt then
  // targets an instance that does not hold the session and the run dies with
  // UnknownError. Resolve the target session's directory from the global
  // session list when the caller did not scope explicitly.
  const resolveSessionDirectory = async (sessionID) => {
    try {
      const client = await getClient();
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

  // Checked before anything is created or sent: a result nobody can deliver
  // must fail the call, not leave a dispatched session the agent waits on.
  const assertReturnResult = (action, input, parentSessionID) => {
    if (input.wait === true) throw new OpenChamberControlError('returnResult cannot be combined with wait', 400);
    if (!dispatchResults) throw new OpenChamberControlError('Returning a session result is not available on this server', 503);
    if (!parentSessionID) throw new OpenChamberControlError('returnResult needs a calling session to deliver the result to', 400);
    if (!asNonEmptyString(input.prompt)) throw new OpenChamberControlError('returnResult requires prompt', 400);
    // A fork is a new session, so only a send can target the caller itself.
    if (action === 'session.send' && asNonEmptyString(input.sessionId) === parentSessionID) {
      throw new OpenChamberControlError('returnResult cannot deliver a session\'s result to itself', 400);
    }
  };

  // What the agent is told when its result is on the way. It replaces a wait,
  // so it has to stop the agent from building one out of polls or sleeps.
  const RESULT_PENDING_NOTE = 'The session runs in the background. Its final answer will be delivered to you automatically as a message when it finishes, and you will continue from there. Do not poll, sleep, or call session.messages to wait for it; carry on with other work or end your turn.';

  /**
   * After the dispatch: the session is already running, so a failure here is
   * reported in the result rather than thrown, and the agent is told plainly
   * that no answer is coming instead of waiting for one.
   */
  const scheduleResultDelivery = async (result, parentSessionID, dispatchedAt) => {
    // The newest end-of-run record before the prompt went out (null: none yet).
    // Absent when the history could not be read; the runtime then compares times.
    const afterIdleId = result.baselineIdleRecordId;
    if (result.promptDispatched !== true) {
      return { status: 'not-scheduled', reason: 'The prompt was not dispatched, so there is no result to return.' };
    }
    try {
      await dispatchResults.register({
        parentSessionId: parentSessionID,
        sessionId: result.sessionId,
        dispatchedAt,
        ...(afterIdleId !== undefined ? { afterIdleId } : {}),
      });
      return { status: 'pending', note: RESULT_PENDING_NOTE };
    } catch (error) {
      return {
        status: 'not-scheduled',
        reason: `The session runs, but its result will not be delivered: ${error instanceof Error ? error.message : String(error)}. Read it later with session.messages if the user asks.`,
      };
    }
  };

  const executeSessionAction = async (action, input, contextDirectory, signal, contextSessionId) => {
    // The tool path forwards raw JSON, so a boolean parameter can arrive as the
    // string "true". Both of these are compared with `=== true` below, which
    // would read a string as false and silently drop the behavior: a dispatch
    // whose result is never delivered, or a call that returns before the turn
    // it asked to wait for. Reject a non-boolean loudly instead.
    if (input.wait !== undefined && !isBoolean(input.wait)) {
      throw new OpenChamberControlError('wait must be a boolean', 400);
    }
    if (input.returnResult !== undefined && !isBoolean(input.returnResult)) {
      throw new OpenChamberControlError('returnResult must be a boolean', 400);
    }
    if (input.timeout !== undefined && input.wait !== true) throw new OpenChamberControlError('timeout requires wait', 400);
    if (input.lastAssistant === true && input.wait !== true) throw new OpenChamberControlError('lastAssistant requires wait', 400);
    assertSingleScope(input);
    // Only a new session gets a worktree; elsewhere the number would be ignored.
    if (input.pullRequest !== undefined && action !== 'session.create') {
      throw new OpenChamberControlError('pullRequest applies only to session.create', 400);
    }
    const sessionID = asNonEmptyString(input.sessionId);
    const parentSessionID = asNonEmptyString(contextSessionId);
    const returnResult = input.returnResult === true;
    if (returnResult) assertReturnResult(action, input, parentSessionID);
    let directory = asNonEmptyString(input.directory) || (!input.projectId ? asNonEmptyString(contextDirectory) : null);
    if (sessionID && action !== 'session.create' && !asNonEmptyString(input.directory) && !input.projectId) {
      const resolvedSessionDirectory = await resolveSessionDirectory(sessionID);
      if (resolvedSessionDirectory) directory = resolvedSessionDirectory;
    }
    const payload = {
      ...(directory ? { directory } : {}),
      ...(asNonEmptyString(input.projectId) ? { projectId: input.projectId.trim() } : {}),
      ...(asNonEmptyString(input.title) ? { title: input.title.trim() } : {}),
      ...(asNonEmptyString(input.prompt) ? { prompt: input.prompt.trim() } : {}),
      ...(asNonEmptyString(input.model) ? { model: input.model.trim() } : {}),
      ...(asNonEmptyString(input.agent) ? { agent: input.agent.trim() } : {}),
      ...(asNonEmptyString(input.variant) ? { variant: input.variant.trim() } : {}),
      ...(input.goal === true ? { goal: true } : {}),
      ...(input.goalTokenBudget !== undefined ? { goalTokenBudget: input.goalTokenBudget } : {}),
      ...(asNonEmptyString(input.worktree) ? { worktree: {
        name: input.worktree.trim(),
        ...(asNonEmptyString(input.branch) ? { branchName: input.branch.trim() } : {}),
        ...(asNonEmptyString(input.startRef) ? { startRef: input.startRef.trim() } : {}),
      } } : {}),
      ...(typeof input.setUpstream === 'boolean' ? { setUpstream: input.setUpstream } : {}),
      ...(asNonEmptyString(input.messageId) ? { messageId: input.messageId.trim() } : {}),
    };
    // A pull request makes a worktree of its own, so its branch name (and a
    // start ref the session service refuses) travel without a worktree name.
    if (input.pullRequest !== undefined) {
      payload.pullRequest = input.pullRequest;
      if (!payload.worktree) {
        payload.worktree = {};
        if (asNonEmptyString(input.branch)) payload.worktree.branchName = input.branch.trim();
        if (asNonEmptyString(input.startRef)) payload.worktree.startRef = input.startRef.trim();
      }
    }
    // The prompt's message names the session whose agent sent it, so the
    // receiving transcript can link back. A session prompting itself has
    // nothing to link to.
    if (parentSessionID && !(action === 'session.send' && sessionID === parentSessionID)) {
      payload.promptedBySessionId = parentSessionID;
    }
    const startedAt = now();
    let result;
    if (action === 'session.create') {
      result = await sessionService.create(payload);
    } else {
      if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
      if (action === 'session.send') {
        result = await sessionService.send(sessionID, payload);
      } else {
        result = await sessionService.fork(sessionID, payload);
      }
    }
    if (returnResult) {
      const publicResult = { ...result, resultDelivery: await scheduleResultDelivery(result, parentSessionID, startedAt) };
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
    const publicResult = { ...result, sessionStatus: status };
    delete publicResult.baselineAssistantMessageId;
    delete publicResult.baselineIdleRecordId;
    if (input.lastAssistant === true) {
      publicResult.lastAssistantMessage = (await sessionMessages(client, result.sessionId, 'assistant', 1))[0] || null;
    }
    return publicResult;
  };

  /**
   * Validates browser inputs here rather than in the renderer: an invalid call
   * should come back as a usage error the agent can correct, without waking a
   * client or waiting for a round trip.
   */
  const browserAction = async (action, input, signal, contextDirectory, contextSessionId) => {
    const parameters = {};
    // Any action may name a tab; the browser that issued the id resolves it.
    const tabId = asNonEmptyString(input.tabId);
    if (tabId) {
      if (tabId.length > 128) throw new OpenChamberControlError('tabId must be an id from browser.snapshot tabs', 400);
      parameters.tabId = tabId;
    }

    const readViewport = (required) => {
      const viewport = asNonEmptyString(input.viewport);
      if (!viewport) {
        if (required) throw new OpenChamberControlError('viewport is required for browser.resize', 400);
        return;
      }
      if (!['mobile', 'tablet', 'desktop', 'fill'].includes(viewport)) {
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

    if (action === 'browser.click') {
      const selector = asNonEmptyString(input.selector);
      const text = asNonEmptyString(input.text);
      if (!selector && !text) {
        throw new OpenChamberControlError('browser.click requires selector or text', 400);
      }
      if (selector) parameters.selector = selector;
      if (text) parameters.text = text;
    }

    if (action === 'browser.snapshot') {
      const selector = asNonEmptyString(input.selector);
      if (selector) parameters.selector = selector;
    }

    if (action === 'browser.inspect') {
      const selector = asNonEmptyString(input.selector);
      if (!selector) throw new OpenChamberControlError('selector is required for browser.inspect', 400);
      parameters.selector = selector;
    }

    if (action === 'browser.type') {
      const selector = asNonEmptyString(input.selector);
      if (!selector) throw new OpenChamberControlError('selector is required for browser.type', 400);
      if (typeof input.value !== 'string') {
        throw new OpenChamberControlError('value is required for browser.type', 400);
      }
      parameters.selector = selector;
      parameters.value = input.value;
      parameters.submit = input.submit === true;
    }

    if (action === 'browser.select') {
      const selector = asNonEmptyString(input.selector);
      if (!selector) throw new OpenChamberControlError('selector is required for browser.select', 400);
      const hasLabel = typeof input.label === 'string';
      const hasValue = typeof input.value === 'string';
      if (hasLabel === hasValue) {
        throw new OpenChamberControlError('browser.select requires exactly one of label or value', 400);
      }
      parameters.selector = selector;
      if (hasLabel) parameters.label = input.label;
      else parameters.value = input.value;
    }

    if (action === 'browser.scroll') {
      const selector = asNonEmptyString(input.selector);
      const direction = asNonEmptyString(input.direction);
      if (!selector && !direction) {
        throw new OpenChamberControlError('browser.scroll requires direction or selector', 400);
      }
      if (direction && !['up', 'down', 'top', 'bottom'].includes(direction)) {
        throw new OpenChamberControlError('direction must be up, down, top, or bottom', 400);
      }
      if (selector) parameters.selector = selector;
      if (direction) parameters.direction = direction;
    }

    // Opening a page waits for the navigation to settle, so its budget has to
    // exceed the client's own wait; sharing one timeout with the quick actions
    // made a slow page indistinguishable from an unreachable browser.
    const timeoutMs = action === 'browser.open' ? 45_000 : 20_000;
    // Where the call came from, for a provider that keeps one browser per
    // project or chat. Filled by the tool plugin, never by the model.
    const context = {
      directory: asNonEmptyString(contextDirectory),
      sessionId: asNonEmptyString(contextSessionId),
    };
    const result = await browserControl.request(action, parameters, { signal, timeoutMs, context });

    // The image is written here rather than in the renderer: the file belongs
    // beside the code it documents, and the client that took it may be on a
    // different machine than the repository.
    if (action === 'browser.capture') {
      const directory = asNonEmptyString(input.directory) || asNonEmptyString(contextDirectory);
      if (!directory) {
        throw new OpenChamberControlError('directory is required to save a screenshot', 400);
      }
      const capture = result && typeof result === 'object' ? result : {};
      const saved = await writeScreenshot({
        directory,
        base64: capture.base64,
        mime: capture.mime,
        label: input.label,
      });
      // The base64 never goes back to the caller: it is large, and the path is
      // what an answer, a commit, or a review can actually use.
      return {
        path: saved.path,
        // Saving the file is only half of showing it. Chat collects the image
        // paths written in a finished answer and renders them below it, so the
        // agent is told the one thing it cannot infer: that writing the path is
        // what puts the picture in front of the user.
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

  const execute = async (action, input = {}, contextDirectory, options = {}) => {
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
        return browserAction(action, input, options.signal, contextDirectory, options.contextSessionId);
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
      if (action === 'secret.request') {
        return await secretRequests.request(input, {
          sessionId: asNonEmptyString(options.contextSessionId),
          callId: asNonEmptyString(options.contextCallId),
          directory: asNonEmptyString(contextDirectory),
          signal: options.signal,
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
            const result = await scheduledTaskService.upsert(projectID, buildScheduledTask(input));
            return { task: result.task, created: result.created };
          }
          case 'schedule.update': {
            const existing = (await scheduledTaskService.list(projectID)).find((task) => task.id === taskID);
            if (!existing) throw new OpenChamberControlError(`Scheduled task not found: ${taskID}`, 404);
            const result = await scheduledTaskService.upsert(projectID, patchScheduledTask(existing, input));
            return { task: result.task, updated: true };
          }
          case 'schedule.run':
            return scheduledTaskService.run(projectID, taskID);
          case 'schedule.delete':
            return { deleted: true, tasks: await scheduledTaskService.remove(projectID, taskID) };
          case 'schedule.toggle': {
            if (typeof input.disabled !== 'boolean') {
              throw new OpenChamberControlError('disabled is required for schedule.toggle', 400);
            }
            const task = await scheduledTaskService.setEnabled(projectID, taskID, input.disabled === false);
            // What was saved, which is what the scheduler acts on.
            return { task, enabled: task?.enabled === true };
          }
        }
      }
      if (action === 'session.create' || action === 'session.send' || action === 'session.fork') {
        return executeSessionAction(action, input, contextDirectory, options.signal, options.contextSessionId);
      }
      if (action === 'session.link') {
        if (!sessionLinks) throw new OpenChamberControlError('Linking is not available on this server', 503);
        assertSingleScope(input);
        // An explicit session is linked where it lives; the calling session
        // uses the directory the tool call came from.
        const explicitSessionID = asNonEmptyString(input.sessionId);
        const sessionID = explicitSessionID || asNonEmptyString(options.contextSessionId);
        const directory = asNonEmptyString(input.directory)
          || (explicitSessionID ? await resolveSessionDirectory(explicitSessionID) : null)
          || asNonEmptyString(contextDirectory);
        // Models put the link's fields beside the action as often as inside
        // `link`; session.link has no other use for them, so both are read.
        const link = input.link ?? { url: input.url, title: input.title, kind: input.kind, identifier: input.identifier };
        return sessionLinks.link({ sessionId: sessionID, directory, link });
      }
      if (action === 'pr.watch' || action === 'pr.unwatch') {
        if (!prWatch) throw new OpenChamberControlError('Waiting on a pull request is not available on this server', 503);
        // Always the calling session: it is the one a change wakes.
        const sessionID = asNonEmptyString(options.contextSessionId);
        if (!sessionID) throw new OpenChamberControlError(`${action} must be called from a session`, 400);
        try {
          if (action === 'pr.unwatch') return await prWatch.unwatch(sessionID);
          const directory = (await resolveSessionDirectory(sessionID)) || asNonEmptyString(contextDirectory);
          return await prWatch.watch({ sessionID, directory, url: input.url });
        } catch (error) {
          throw new OpenChamberControlError(error?.message ?? String(error), Number.isInteger(error?.status) ? error.status : 500);
        }
      }
      if (action === 'work.name') {
        if (!workNamer) throw new OpenChamberControlError('Naming tasks is not available on this server', 503);
        const sessionID = asNonEmptyString(input.sessionId) || asNonEmptyString(options.contextSessionId);
        return workNamer.name({ sessionId: sessionID, title: input.title, branch: input.branch });
      }
      if (action === 'session.moveToWorktree') {
        assertSingleScope(input);
        // The calling session by default: the agent moves its own work.
        const explicitSessionID = asNonEmptyString(input.sessionId);
        const sessionID = explicitSessionID || asNonEmptyString(options.contextSessionId);
        if (!sessionID) throw new OpenChamberControlError('sessionId is required', 400);
        // Where the session lives now, which is where the changes are taken
        // from; never a directory of the caller's choosing, so the action
        // cannot carry away another checkout's changes.
        const directory = (await resolveSessionDirectory(sessionID)) || asNonEmptyString(contextDirectory);
        const worktree = { name: asNonEmptyString(input.worktree)?.trim() };
        const branch = asNonEmptyString(input.branch);
        if (branch) worktree.branchName = branch.trim();
        const startRef = asNonEmptyString(input.startRef);
        if (startRef) worktree.startRef = startRef.trim();
        const existingBranch = asNonEmptyString(input.existingBranch);
        if (existingBranch) worktree.existingBranch = existingBranch.trim();
        const payload = { worktree };
        if (directory) payload.directory = directory;
        if (input.carry !== undefined) payload.carry = input.carry;
        const moved = await sessionService.moveToWorktree(sessionID, payload);
        // A new branch takes the task's name along; an existing branch keeps its own.
        if (workNamer && !existingBranch && moved?.worktree?.path) {
          await workNamer.carryToWorktree({ sessionId: sessionID, worktree: moved.worktree.path })
            .catch((error) => console.warn('Failed to carry the task name into the new worktree:', error instanceof Error ? error.message : String(error)));
        }
        return moved;
      }
      if (action.startsWith('session.')) {
        const sessionID = asNonEmptyString(input.sessionId);
        if (action !== 'session.list' && !sessionID) throw new OpenChamberControlError('sessionId is required', 400);
        const directory = await resolveReadDirectory(input, contextDirectory);
        const client = await getClient(directory);
        if (action === 'session.list') {
          const limit = positiveInteger(input.limit, 10, 'limit');
          // Session reads are cursor-paginated: one upstream page is not the
          // collection. Collect only until the limit is satisfied, skip ids a
          // repeated page already contributed, and stop on a cursor seen twice
          // so a pathological server cannot spin the walk.
          const collected = [];
          const seenCursors = new Set();
          const seenSessionIds = new Set();
          let cursor;
          for (;;) {
            const listInput = {};
            if (directory) listInput.directory = directory;
            if (cursor) listInput.cursor = cursor;
            const response = await client.session.list(listInput);
            const page = await Promise.all((Array.isArray(response?.data) ? response.data : []).map(withArchiveEntry));
            for (const session of page) {
              const id = asNonEmptyString(session?.id);
              if (id) {
                if (seenSessionIds.has(id)) continue;
                seenSessionIds.add(id);
              }
              if (input.all !== true && session?.time?.archived) continue;
              collected.push(session);
              if (collected.length >= limit) break;
            }
            if (collected.length >= limit) break;
            const next = asNonEmptyString(response?.cursor?.next);
            if (!next || page.length === 0 || seenCursors.has(next)) break;
            seenCursors.add(next);
            cursor = next;
          }
          let sessions = collected.slice(0, limit);
          if (input.withStatus === true) {
            // One global call now: v2 reports active sessions across directories.
            const statuses = await activeSessions(client).catch(() => null);
            sessions = sessions.map((session) => ({
              ...session,
              status: statuses ? asPublicStatus(statuses[session.id]) : { type: 'unknown' },
            }));
          }
          return { sessions, limit, directory, archived: input.all === true ? 'included' : 'excluded' };
        }
        if (!directory) throw new OpenChamberControlError('directory is required', 400);
        if (action === 'session.status') {
          return { sessionId: sessionID, directory, sessionStatus: await sessionStatus(client, sessionID) };
        }
        if (action === 'session.messages') {
          if (input.timeout !== undefined && input.wait !== true) throw new OpenChamberControlError('timeout requires wait', 400);
          const role = input.lastAssistant === true ? 'assistant' : (asNonEmptyString(input.role) || 'all');
          if (!['all', 'user', 'assistant'].includes(role)) throw new OpenChamberControlError('role must be all, user, or assistant', 400);
          const last = input.last === true || input.lastAssistant === true;
          if (input.all === true && (last || input.limit !== undefined)) throw new OpenChamberControlError('all cannot be combined with last or limit', 400);
          if (last && input.limit !== undefined) throw new OpenChamberControlError('last cannot be combined with limit', 400);
          const currentStatus = input.wait === true
            ? await waitForIdle({ client, sessionID, directory, timeoutMs: normalizeWaitTimeoutMs(input.timeout), requireActivity: false, startedAt: now(), signal: options.signal })
            : await sessionStatus(client, sessionID);
          const limit = input.all === true ? undefined : (last ? 1 : positiveInteger(input.limit, 10, 'limit'));
          return { sessionId: sessionID, directory, role, sessionStatus: currentStatus, messages: await sessionMessages(client, sessionID, role, limit) };
        }
      }
      throw new OpenChamberControlError(`Unsupported OpenChamber action: ${action || 'missing'}`, 400);
    } catch (error) {
      throw asControlError(error, `Failed to execute ${action || 'OpenChamber action'}`);
    }
  };

  // The managed agent-tool plugin can no longer report the session's directory
  // (v2 dropped `context.directory` from a tool call), so it sends the session
  // id and the directory is resolved here, where it is authoritative.
  // `answerPage` is the chat's side of a page that waits (render.page with
  // awaitAnswer), `answerSecret` the chat's side of a secret.request card.
  return { execute, resolveSessionDirectory, answerPage: pageAnswers.answer, answerSecret: secretRequests.answer };
};
