import { asNonEmptyString, isBoolean, isPlainObject, isRecord, isString } from '../shared/guards.js';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { OpenChamberControlError, asControlError } from './error.js';
import { OPENCHAMBER_ALL_ACTIONS, OPENCHAMBER_KNOWLEDGE_ACTIONS } from './actions.js';
import { writeScreenshot } from './screenshots.js';
import { createProjectKnowledgeActions } from './project-knowledge.js';
import { createPageAnswers, createRenderPageAction } from './render-page.js';
import { createTierChooserAction } from './tier-chooser-action.js';
import { branchesOffPullRequestsByDefault } from '../git/worktree-start-ref.js';

const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
const MAX_WAIT_TIMEOUT_SECONDS = 86_400;
const WAIT_POLL_INTERVAL_MS = 500;
// Matches the fields `sanitizeProjects` keeps that Project settings edits.
const EDITABLE_PROJECT_SETTINGS = Object.freeze([
  'label', 'icon', 'color', 'iconBackground', 'sidebarCollapsed', 'defaultModel', 'defaultAgent', 'defaultVariant',
]);
// One service, both capabilities: which tool asked is the caller's concern.
const CONTROL_ACTIONS = new Set(OPENCHAMBER_ALL_ACTIONS);
// models.search ranks a favorite 2 and a recent model 1.
const PREFERENCE_BY_RANK = { 2: 'favorite', 1: 'recent' };
const SCHEDULE_TASK_ID_ACTIONS = new Set([
  'schedule.get',
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
  // Strict like versionParts in packages/ui mobileReleaseUpdate: parseInt
  // stops at the first non-digit ('1.9' -> 1, '0x1' -> 0), so an entry that
  // is not all digits is malformed, not a weekday to coerce.
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => !/^\d+$/.test(entry))) {
    throw new OpenChamberControlError('weekly must contain weekdays from 0 to 6', 400);
  }
  const weekdays = entries.map((entry) => Number(entry));
  if (weekdays.some((entry) => entry < 0 || entry > 6)) {
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
    projectContextRuntime = null,
    resolveProjectContextId = null,
    isKnowledgeToolEnabled = async () => true,
    isRenderToolEnabled = async () => true,
    // Hears when a page an agent shows starts and stops waiting for the
    // user's answer (render.page with awaitAnswer).
    onPageWaitChange = () => {},
    // Puts a plan in front of the user; answers how many windows it reached.
    showPlan = null,
    // Delivers a dispatched session's result back to the session that asked
    // (`returnResult`); absent means the server cannot offer it.
    dispatchResults = null,
    // Archive lives in OpenChamber's own store now — v2 has no route that sets
    // Session.time.archived — so an unwired store simply means nothing is archived.
    archiveStore = null,
    // Action modules (session-actions.js, config-actions.js, ...): each
    // `{ actions: string[], execute(action, input, ctx) }`, dispatched by name
    // ahead of the built-in actions below.
    actionModules = [],
    // projects.add / projects.remove reuse the same validation, id scheme and
    // settings writer the `/api/openchamber/directory` route uses, so an
    // agent-added project is indistinguishable from one a human added through
    // the UI. All three absent simply means those two actions are unavailable
    // on this server (an older embedder that has not wired them yet).
    fsPromises = null,
    validateDirectoryPath = null,
    persistSettings = null,
    createProjectIdFromPath = null,
    // The settings runtime's updateSettings: read, change and write the
    // project list under the save lock, so two changes close together cannot
    // write over each other. Unwired, projects.* read and then persist.
    updateSettings = null,
    // session.create makes a worktree by default (see resolveAutoWorktree).
    // Injectable for tests; the defaults load the git service lazily so a
    // server that never creates a session never pays for the import.
    isGitRepository = async (directory) => (await import('../git/index.js')).isGitRepository(directory),
    generateWorktreeName = async (options) => (await import('../git/worktree-name.js')).generateWorktreeName(options),
    randomWorktreeName = async () => (await import('../git/index.js')).generateOpenCodeRandomName(),
    createClient = OpenCode.make,
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

  // The store answers asynchronously; its archive timestamp, or null.
  const archivedAt = async (sessionID) => {
    if (!archiveStore) return null;
    return (await archiveStore.archivedAt(sessionID)) ?? null;
  };

  const projects = async () => {
    const settings = await readSettingsFromDiskMigrated();
    return sanitizeProjects(settings?.projects || []).map((project) => ({
      id: project.id,
      path: path.resolve(project.path),
      label: asNonEmptyString(project.label) || path.basename(project.path) || project.path,
      settings: projectSettingsOf(project),
    }));
  };

  // The per-project settings Project settings shows; the id, path and
  // timestamps are the project's identity and history, not settings.
  const projectSettingsOf = (project) => Object.fromEntries(
    EDITABLE_PROJECT_SETTINGS.filter((key) => project[key] !== undefined).map((key) => [key, project[key]]),
  );

  // Runs compute(current settings) and writes the changes it returns, under
  // the settings lock when the server wired updateSettings.
  const modifySettings = updateSettings ?? (async (compute) => {
    const changes = await compute(await readSettingsFromDiskMigrated());
    if (changes) await persistSettings(changes);
  });

  // Same writer and sanitizer as Project settings: a value the sanitizer
  // drops or rewrites is refused rather than reported as saved.
  const updateProject = async (input) => {
    if (projectActionsUnavailable) {
      throw new OpenChamberControlError('Changing projects is not available on this server', 503);
    }
    const projectID = asNonEmptyString(input.projectId);
    if (!projectID) throw new OpenChamberControlError('projectId is required', 400);
    const changes = input.projectSettings;
    if (!isPlainObject(changes) || Object.keys(changes).length === 0) {
      throw new OpenChamberControlError(`projectSettings must be an object of one or more of ${EDITABLE_PROJECT_SETTINGS.join(', ')}`, 400);
    }
    const unknown = Object.keys(changes).filter((key) => !EDITABLE_PROJECT_SETTINGS.includes(key));
    if (unknown.length > 0) {
      throw new OpenChamberControlError(`Nothing was saved. Not a project setting: ${unknown.join(', ')}. Editable: ${EDITABLE_PROJECT_SETTINGS.join(', ')}`, 400);
    }
    // The sanitizer trims text and lowercases a hex colour; either is the value kept, not a refusal.
    const kept = (key, value) => {
      if (!isString(value)) return value;
      return key === 'iconBackground' ? value.trim().toLowerCase() : value.trim();
    };
    let target = null;
    let accepted = null;
    await modifySettings((settings) => {
      const existingProjects = sanitizeProjects(settings?.projects || []) || [];
      target = existingProjects.find((project) => project.id === projectID) || null;
      if (!target) throw new OpenChamberControlError(`Unknown project: ${projectID}`, 404);

      const next = { ...target };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      const nextProjects = existingProjects.map((project) => (project.id === projectID ? next : project));
      accepted = sanitizeProjects(nextProjects).find((project) => project.id === projectID);
      const rejected = Object.entries(changes)
        .filter(([key, value]) => value !== null && JSON.stringify(accepted?.[key]) !== JSON.stringify(kept(key, value)))
        .map(([key]) => key);
      if (rejected.length > 0) {
        throw new OpenChamberControlError(`Nothing was saved. OpenChamber does not accept the value given for ${rejected.join(', ')} (defaultModel is provider/model, defaultVariant needs a defaultModel, iconBackground is a #hex color, sidebarCollapsed is a boolean)`, 400);
      }
      return { projects: nextProjects };
    });
    // A setting can depend on another: clearing defaultModel drops defaultVariant with it.
    const alsoCleared = EDITABLE_PROJECT_SETTINGS.filter((key) => (
      target[key] !== undefined && accepted?.[key] === undefined && !Object.hasOwn(changes, key)
    ));
    const result = {
      project: { id: target.id, path: path.resolve(target.path), settings: projectSettingsOf(accepted) },
      note: 'Saved. Open OpenChamber windows may need a reload to show the change',
    };
    if (alsoCleared.length > 0) {
      result.alsoCleared = alsoCleared;
      result.note += `. ${alsoCleared.join(', ')} was cleared too, since it only applies with what was removed`;
    }
    return result;
  };

  const projectActionsUnavailable = !fsPromises || !validateDirectoryPath || !persistSettings || !createProjectIdFromPath;

  // Mirrors `/api/openchamber/directory`: same validation, same id scheme,
  // same settings writer, so an agent-added project is a configured project
  // in every sense, not a parallel notion of one.
  const addProject = async (input) => {
    if (projectActionsUnavailable) {
      throw new OpenChamberControlError('Adding projects is not available on this server', 503);
    }
    const requestedPath = asNonEmptyString(input.directory);
    if (!requestedPath) {
      throw new OpenChamberControlError('directory is required', 400);
    }
    if (input.create === true) {
      await fsPromises.mkdir(path.resolve(requestedPath), { recursive: true });
    }
    const validated = await validateDirectoryPath(requestedPath);
    if (!validated.ok) {
      throw new OpenChamberControlError(validated.error, 400);
    }
    const resolvedPath = validated.directory;
    const label = asNonEmptyString(input.projectLabel);
    let existing = null;
    let entry = null;
    await modifySettings((settings) => {
      const existingProjects = sanitizeProjects(settings?.projects || []) || [];
      existing = existingProjects.find((project) => project.path === resolvedPath) || null;
      const nextProjects = existing
        ? existingProjects
        : [
            ...existingProjects,
            {
              id: createProjectIdFromPath(resolvedPath),
              path: resolvedPath,
              ...(label ? { label } : {}),
              addedAt: now(),
              lastOpenedAt: now(),
            },
          ];
      entry = existing ?? nextProjects[nextProjects.length - 1];
      return {
        projects: nextProjects,
        activeProjectId: entry.id,
        lastDirectory: resolvedPath,
      };
    });

    return {
      project: {
        id: entry.id,
        path: resolvedPath,
        label: asNonEmptyString(entry.label) || path.basename(resolvedPath) || resolvedPath,
      },
      alreadyConfigured: Boolean(existing),
    };
  };

  // Deliberately settings-only: the running sessions, worktrees and checkout
  // that belonged to this project are left exactly where they were, the same
  // boundary the control tool's description states for every action. Not
  // setting activeProjectId here is deliberate too — persistSettings already
  // falls back to the first remaining project (or clears it) on its own, so
  // recomputing that here would just be a second, possibly stale, opinion.
  const removeProject = async (input) => {
    if (projectActionsUnavailable) {
      throw new OpenChamberControlError('Removing projects is not available on this server', 503);
    }
    const projectID = asNonEmptyString(input.projectId);
    if (!projectID) {
      throw new OpenChamberControlError('projectId is required', 400);
    }
    let target = null;
    await modifySettings((settings) => {
      const existingProjects = sanitizeProjects(settings?.projects || []) || [];
      target = existingProjects.find((project) => project.id === projectID) || null;
      if (!target) {
        throw new OpenChamberControlError(`Unknown project: ${projectID}`, 404);
      }
      return { projects: existingProjects.filter((project) => project.id !== projectID) };
    });

    return {
      removed: {
        id: target.id,
        path: path.resolve(target.path),
        label: asNonEmptyString(target.label) || path.basename(target.path) || target.path,
      },
    };
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

  const pageAnswers = createPageAnswers({ onWaitChange: onPageWaitChange });
  const renderPage = createRenderPageAction({ isEnabled: isRenderToolEnabled, pageAnswers });
  // `render.tierChooser` (#14 slice 2): the tier card's production
  // caller — catalog pricing assembled here, the card rendered
  // through render.page's wait, the pick returned to the agent.
  const tierChooser = createTierChooserAction({
    listModels: async (directory) => {
      const client = await getClient(asNonEmptyString(directory) || '');
      const catalog = await client.model.list();
      return catalog.data;
    },
    renderPage,
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
  // A cursor walk must always end: a repeated cursor or this many pages
  // stops it, even when the server keeps handing out fresh cursors (the
  // house cap order: the message-search indexer walk in #1315 caps at 20).
  // Past the cap sessionMessages returns the partial history collected so
  // far flagged `truncated` (the session.messages action surfaces it, so a
  // partial history is never presented as the full one) and
  // resolveSessionDirectory returns null (directory unresolved).
  const MAX_PAGES_PER_WALK = 20;
  const sessionMessages = async (client, sessionID, role, limit) => {
    // Room for the non-text records between text messages, within the page
    // size OpenCode accepts (a larger one is refused, which reads as an error
    // about the caller's own limit).
    const fetchLimit = limit === undefined ? undefined : Math.min(MESSAGE_PAGE_LIMIT, Math.max(100, limit * 4));
    const collected = [];
    const seenCursors = new Set();
    let cursor;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES_PER_WALK; page += 1) {
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
      // The cap is the last stop and another page remains unvisited: the
      // collected history is partial, so flag it instead of presenting it
      // as the complete history the caller asked for.
      if (page === MAX_PAGES_PER_WALK - 1) {
        truncated = true;
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }
    const projected = extractTextMessages(collected, role);
    const messages = limit === undefined ? projected : projected.slice(-limit);
    return { messages, truncated };
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
        const messages = (await sessionMessages(client, sessionID, 'assistant', 1)).messages;
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
      for (let page = 0; page < MAX_PAGES_PER_WALK; page += 1) {
        const response = await client.session.list(cursor ? { cursor } : {});
        const sessions = Array.isArray(response?.data) ? response.data : [];
        const session = sessions.find((item) => item?.id === sessionID);
        if (session) return asNonEmptyString(session?.location?.directory) || null;
        if (sessions.length === 0) return null;
        const next = asNonEmptyString(response?.cursor?.next);
        if (!next || seenCursors.has(next)) return null;
        seenCursors.add(next);
        cursor = next;
      }
      return null;
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

  /**
   * session.create makes a new worktree unless told otherwise: an agent that
   * dispatches work into the user's checkout would otherwise edit the same
   * files the user (or another session) is working in. The caller either
   * names the worktree (`worktree`), opts out explicitly (`newWorktree:
   * false`, or `worktree: false`), or gets one named from the prompt by the
   * model chosen for the session (`worktreeNameModel` overrides it). A
   * directory that is not a git repository cannot have a worktree, so there
   * it silently stays in place; naming failures fall back to a random name.
   */
  const resolveAutoWorktree = async (input, payload) => {
    if (input.newWorktree === false || input.worktree === false) return { mode: 'disabled' };
    if (input.pullRequest !== undefined) return resolvePullRequestWorktreeName(input, payload);
    if (payload.worktree) return { mode: 'explicit' };
    const directory = await payloadDirectory(payload);
    if (!directory || !(await isGitRepository(directory))) {
      return { mode: 'skipped', reason: 'not a git repository' };
    }
    const settings = await readSettingsFromDiskMigrated();
    const { name, resolution } = await nameWorktree(input, payload, directory, settings);
    const worktree = { name };
    const branchName = asNonEmptyString(input.branch);
    if (branchName) worktree.branchName = branchName;
    const startRef = asNonEmptyString(input.startRef);
    if (startRef) worktree.startRef = startRef;
    payload.worktree = worktree;
    return resolution;
  };

  const payloadDirectory = async (payload) => {
    if (payload.directory) return payload.directory;
    return payload.projectId ? sessionService.resolveDirectory({ projectId: payload.projectId }) : null;
  };

  /**
   * A worktree checking out a pull request is named after its branch. One
   * starting a new branch from it (`branchOff`, else the user's Settings) is
   * named from the prompt like any other worktree an agent makes, unless the
   * call names it; the session service then names the branch from it by the
   * pull request branch template.
   */
  const resolvePullRequestWorktreeName = async (input, payload) => {
    if (payload.worktree?.name) return { mode: 'explicit' };
    // A call the session service refuses (a malformed number or branchOff, a
    // start ref or upstream beside it) gets its 400 without a naming call.
    if (!Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1
      || input.startRef !== undefined || input.setUpstream !== undefined
      || (input.branchOff !== undefined && !isBoolean(input.branchOff))) {
      return { mode: 'explicit' };
    }
    const settings = await readSettingsFromDiskMigrated();
    const branchOff = input.branchOff ?? branchesOffPullRequestsByDefault(settings);
    if (!branchOff) return { mode: 'explicit' };
    const directory = await payloadDirectory(payload);
    if (!directory) return { mode: 'explicit' };
    const { name, resolution } = await nameWorktree(input, payload, directory, settings);
    payload.worktree = { ...payload.worktree, name };
    payload.branchOff = true;
    return resolution;
  };

  /** A name from the prompt by the naming model, else a random one. */
  const nameWorktree = async (input, payload, directory, settings) => {
    const project = sanitizeProjects(settings?.projects || []).find((entry) => (
      (payload.projectId && entry.id === payload.projectId) || path.resolve(entry.path) === path.resolve(directory)
    ));
    const namingModel = asNonEmptyString(input.worktreeNameModel)
      || payload.model
      || asNonEmptyString(project?.defaultModel)
      || asNonEmptyString(settings?.defaultModel)
      || undefined;
    const namingPrompt = payload.prompt || payload.title || '';
    const generated = namingPrompt
      ? await generateWorktreeName({ prompt: namingPrompt, model: namingModel, directory })
      : '';
    const name = generated || await randomWorktreeName();
    const resolution = { mode: 'auto', name, naming: generated ? 'generated' : 'random' };
    if (generated && namingModel) resolution.model = namingModel;
    return { name, resolution };
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
    // Forwarded unchanged on create once it passes the same object check
    // the update path applies: OpenCode owns the policy shape and its
    // checks. Send and fork keep the policy the session already has.
    if (action === 'session.create' && input.subagentPolicy !== undefined) {
      if (!isRecord(input.subagentPolicy)) {
        throw new OpenChamberControlError('subagentPolicy must be an object with models, excludedModels, or agentOverrides', 400);
      }
      payload.subagentPolicy = input.subagentPolicy;
    }
    // A pull request makes a worktree of its own, so its branch name (and a
    // start ref the session service refuses) travel without a worktree name.
    if (input.pullRequest !== undefined) {
      payload.pullRequest = input.pullRequest;
      // Checked by the session service, which also applies the Settings default.
      if (input.branchOff !== undefined) payload.branchOff = input.branchOff;
      if (!payload.worktree) {
        payload.worktree = {};
        if (asNonEmptyString(input.branch)) payload.worktree.branchName = input.branch.trim();
        if (asNonEmptyString(input.startRef)) payload.worktree.startRef = input.startRef.trim();
      }
    }
    const startedAt = now();
    let result;
    let worktreeResolution = null;
    if (action === 'session.create') {
      worktreeResolution = await resolveAutoWorktree(input, payload);
      result = await sessionService.create(payload);
      if (worktreeResolution.mode === 'auto' || worktreeResolution.mode === 'skipped') {
        result = { ...result, autoWorktree: worktreeResolution };
      }
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
      publicResult.lastAssistantMessage = (await sessionMessages(client, result.sessionId, 'assistant', 1)).messages[0] || null;
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
      const actionModule = actionModules.find((entry) => entry.actions.includes(action));
      if (actionModule) {
        return await actionModule.execute(action, input, {
          contextDirectory,
          contextSessionId: options.contextSessionId,
          signal: options.signal,
          getClient,
          // Same precedence as session.send/fork: an explicit directory or
          // project wins, then the session's own directory, then the caller's.
          resolveSessionDirectory: async (scope = {}) => {
            assertSingleScope(scope);
            const explicitDirectory = asNonEmptyString(scope.directory);
            if (explicitDirectory) return explicitDirectory;
            const projectID = asNonEmptyString(scope.projectId);
            if (projectID) return sessionService.resolveDirectory({ projectId: projectID });
            const scopedSessionID = asNonEmptyString(scope.sessionId);
            const sessionDirectory = scopedSessionID ? await resolveSessionDirectory(scopedSessionID) : null;
            return sessionDirectory || asNonEmptyString(contextDirectory);
          },
        });
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
      if (action === 'render.page') {
        return await renderPage(input, {
          sessionId: asNonEmptyString(options.contextSessionId),
          callId: asNonEmptyString(options.contextCallId),
          directory: asNonEmptyString(contextDirectory),
          signal: options.signal,
        });
      }
      if (action === 'render.tierChooser') {
        return await tierChooser(input, {
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
      if (action === 'projects.add') return addProject(input);
      if (action === 'projects.remove') return removeProject(input);
      if (action === 'projects.update') return updateProject(input);
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
          case 'schedule.get': {
            const task = (await scheduledTaskService.list(projectID)).find((entry) => entry.id === taskID);
            if (!task) throw new OpenChamberControlError(`Scheduled task not found: ${taskID}`, 404);
            return { task };
          }
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
        return sessionService.moveToWorktree(sessionID, payload);
      }
      if (action.startsWith('session.')) {
        const sessionID = asNonEmptyString(input.sessionId);
        if (action !== 'session.list' && !sessionID) throw new OpenChamberControlError('sessionId is required', 400);
        let directory = await resolveReadDirectory(input, contextDirectory);
        // A read of one session belongs to that session: with no explicit
        // projectId or directory, resolve the session's own directory from
        // the global session list the way send and fork do, and keep the
        // caller's directory only as the fallback when it is not found.
        if (action !== 'session.list' && !asNonEmptyString(input.directory) && !asNonEmptyString(input.projectId)) {
          const resolvedSessionDirectory = await resolveSessionDirectory(sessionID);
          if (resolvedSessionDirectory) directory = resolvedSessionDirectory;
        }
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
            // Archive is OpenChamber state; overlay it so callers keep reading
            // it off the session the way OpenCode used to report it.
            const page = await Promise.all((Array.isArray(response?.data) ? response.data : []).map(async (session) => {
              const archived = await archivedAt(session?.id);
              return archived ? { ...session, time: { ...session.time, archived } } : session;
            }));
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
          const history = await sessionMessages(client, sessionID, role, limit);
          const messageResult = { sessionId: sessionID, directory, role, sessionStatus: currentStatus, messages: history.messages };
          if (history.truncated) messageResult.truncated = true;
          return messageResult;
        }
        if (action === 'session.archive' || action === 'session.unarchive') {
          // The session service owns the broadcast that tells open windows;
          // the bare store is the same state without it, for servers whose
          // session service predates the archive methods.
          const archiving = action === 'session.archive';
          const serviceMethod = archiving ? sessionService?.archive : sessionService?.unarchive;
          const storeMethod = archiving ? archiveStore?.archive : archiveStore?.unarchive;
          let outcome;
          if (serviceMethod) {
            outcome = await serviceMethod.call(sessionService, { ids: [sessionID] });
          } else if (storeMethod) {
            outcome = await storeMethod.call(archiveStore, [sessionID]);
          } else {
            throw new OpenChamberControlError('Archiving sessions is not available on this server', 503);
          }
          const applied = (archiving ? outcome?.archived : outcome?.restored) || [];
          if (!applied.some((entry) => entry?.id === sessionID)) {
            throw new OpenChamberControlError(`Failed to ${archiving ? 'archive' : 'restore'} session ${sessionID}`, 500);
          }
          return archiving
            ? { sessionId: sessionID, directory, archived: true, archivedAt: applied.find((entry) => entry?.id === sessionID)?.archivedAt ?? null }
            : { sessionId: sessionID, directory, archived: false };
        }
        if (action === 'session.delete') {
          // Deleting the session a call runs in would remove the very
          // conversation waiting for this answer. The CLI has no calling
          // session, so this only ever refuses the tool path's own session.
          if (asNonEmptyString(options.contextSessionId) === sessionID) {
            throw new OpenChamberControlError('session.delete cannot target the session you are running in; pass the sessionId of another session', 400);
          }
          await client.session.remove({ sessionID });
          return { sessionId: sessionID, directory, deleted: true };
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
  // awaitAnswer).
  return { execute, resolveSessionDirectory, answerPage: pageAnswers.answer };
};
