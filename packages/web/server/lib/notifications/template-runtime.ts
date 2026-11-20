import path from 'node:path';

import { summarizeText as summarizeSharedText } from '../text/summarization.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { hasErrorMessage, isJsonObject, isString } from './inputs.js';
import type { JsonValue } from './contracts.js';
import type { SessionReadFetch } from '../opencode/session-activity.js';

export interface NotificationTemplateInfo {
  id?: unknown;
  title?: unknown;
  sessionTitle?: unknown;
  agent?: unknown;
  mode?: unknown;
  modelID?: unknown;
  model?: unknown;
  parts?: unknown;
  content?: unknown;
}

export interface NotificationTemplateEvent {
  type?: string;
  properties?: {
    info?: NotificationTemplateInfo;
    parts?: unknown;
    sessionTitle?: JsonValue;
    session?: JsonValue;
    directory?: unknown;
  };
}

export interface NotificationTemplateSource {
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => HeadersInit;
  fetchImpl: SessionReadFetch;
  isSpace?: boolean;
}

export interface NotificationTemplateProject {
  id?: unknown;
  path?: unknown;
  label?: unknown;
}

export interface NotificationTemplateSettings {
  zenModel?: unknown;
  projects?: NotificationTemplateProject[];
  activeProjectId?: unknown;
}

export interface NotificationTemplateVariableValues {
  [key: string]: JsonValue | undefined;
}

export interface NotificationTemplateVariables extends NotificationTemplateVariableValues {
  project_name: string;
  worktree: string;
  branch: string;
  session_name: JsonValue;
  agent_name: string;
  model_name: string;
  last_message: string;
  session_id: string;
}

export interface NotificationTemplateDependencies {
  readSettingsFromDisk: () => Promise<NotificationTemplateSettings>;
  buildOpenCodeUrl: NotificationTemplateSource['buildOpenCodeUrl'];
  getOpenCodeAuthHeaders: NotificationTemplateSource['getOpenCodeAuthHeaders'];
  resolveGitBinaryForSpawn: () => string;
  resolvePrimaryWorktreeRoot?: (directory: string) => PromiseLike<{ root: string }>;
  chatRoots?: string[];
}

const isNotificationTextPart = (part: unknown): part is { type: 'text'; text?: unknown; content?: unknown } => {
  if (!part || typeof part !== 'object') return false;
  if (!('type' in part) || part.type !== 'text') return false;
  return ('text' in part && typeof part.text === 'string') || ('content' in part && typeof part.content === 'string');
};

const isPartsArray = (value: unknown): value is unknown[] => Array.isArray(value);

export const createNotificationTemplateRuntime = (deps: NotificationTemplateDependencies) => {
  const {
    readSettingsFromDisk,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    resolveGitBinaryForSpawn,
    resolvePrimaryWorktreeRoot = async (directory) => ({ root: directory }),
    chatRoots = [],
  } = deps;

  const NOTIFICATION_BODY_MAX_CHARS = 1000;
  const GIT_TIMEOUT_MS = 3000;
  const CHATS_PROJECT_LABEL = 'Chats';

  const hostSource: NotificationTemplateSource = { buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl: (...args) => fetch(...args) };
  const isHostSource = (source: NotificationTemplateSource) => !source?.isSpace;
  const SESSION_INFO_CACHE_TTL_MS = 60 * 1000;

  const cachedZenModels = { models: [] };

  const sessionTitleCache = new Map<string, string>();
  const sessionInfoCache = new Map<string, { data: { [key: string]: JsonValue | undefined }; at: number }>();

  const createTimeoutSignal = (timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  };

  const formatProjectLabel = (label: string) => {
    if (!label) return '';
    return label.trim();
  };

  const resolveNotificationTemplate = (template: JsonValue | undefined, variables: NotificationTemplateVariableValues) => {
    if (!template || !isString(template)) return '';
    return template.replace(/\{(\w+)\}/g, (_match: string, key: string) => {
      const value = variables[key];
      if (value === undefined || value === null) return '';
      return String(value);
    });
  };

  const shouldApplyResolvedTemplateMessage = (template: JsonValue | undefined, resolved: string, variables: NotificationTemplateVariableValues) => {
    if (!resolved) {
      return false;
    }

    if (!isString(template)) {
      return true;
    }

    if (template.includes('{last_message}')) {
      return isString(variables?.last_message) && variables.last_message.trim().length > 0;
    }

    return true;
  };

  const fetchFreeZenModels = async () => [];

  const resolveZenModel = async (override?: JsonValue) => {
    const overrideModel = isString(override) ? override.trim() : '';
    if (overrideModel) return overrideModel;
    const settings: NotificationTemplateSettings = await readSettingsFromDisk().catch(() => ({}));
    return isString(settings?.zenModel) && settings.zenModel.trim().length > 0
      ? settings.zenModel.trim()
      : '';
  };

  const validateZenModelAtStartup = async () => {};

  const summarizeText = async (text: JsonValue | undefined, targetLength: number, zenModel: string) => {
    if (!text || !isString(text) || text.trim().length === 0) return text;
    const result = await summarizeSharedText({
      text,
      threshold: 0,
      maxLength: targetLength,
        zenModel,
      mode: 'notification',
    });
    return result.summary.trim().length > 0
      ? result.summary
      : text;
  };

  const extractTextFromParts = (parts: NotificationTemplateInfo['parts'], maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
    if (!isPartsArray(parts) || parts.length === 0) return '';

    const textParts = parts
      .filter(isNotificationTextPart)
      .map((part) => part.text || part.content || '')
      .filter(Boolean);

    let text = textParts.length > 0 ? textParts.join('\n').trim() : '';

    if (maxLength > 0 && text.length > maxLength) {
      text = text.slice(0, maxLength);
    }

    return text;
  };

  const extractLastMessageText = (payload: NotificationTemplateEvent | null | undefined, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
    const info = payload?.properties?.info;
    if (!info) return '';

    const parts = info.parts || payload?.properties?.parts;
    const text = extractTextFromParts(parts, maxLength);
    if (text) return text;

    const content = info.content;
    if (isPartsArray(content)) {
      const textContent = content
        .filter(isNotificationTextPart)
        .map((entry) => entry.text || '')
        .filter(Boolean);
      if (textContent.length > 0) {
        let result = textContent.join('\n').trim();
        if (maxLength > 0 && result.length > maxLength) {
          result = result.slice(0, maxLength);
        }
        return result;
      }
    }

    return '';
  };

  const fetchLastAssistantMessageText = async (sessionId: string | undefined, messageId?: JsonValue, maxLength = NOTIFICATION_BODY_MAX_CHARS, source = hostSource) => {
    if (!sessionId) return '';

    try {
      const url = source.buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}/message`, '');
      const response = await source.fetchImpl(`${url}?limit=5`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...source.getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) return '';

      const page: JsonValue = await response.json().catch(() => null);
      const messages = isJsonObject(page) && Array.isArray(page.data) ? page.data : null;
      if (!messages) return '';

      let target = null;
      if (messageId) {
        target = messages.find((message) => isJsonObject(message) && message?.id === messageId && message?.type === 'assistant');
      }
      if (!target) {
        target = messages.find((message) => isJsonObject(message) && message?.type === 'assistant' && message?.finish === 'stop') ?? null;
      }

      if (!isJsonObject(target) || !Array.isArray(target.content)) return '';

      return extractTextFromParts(target.content, maxLength);
    } catch {
      return '';
    }
  };

  const cacheSessionTitle = (sessionId: NotificationTemplateInfo['id'], title: NotificationTemplateInfo['title']) => {
    if (isString(sessionId) && sessionId.length > 0 && isString(title) && title.length > 0) {
      sessionTitleCache.set(sessionId, title);
    }
  };

  const getCachedSessionTitle = (sessionId: string) => {
    return sessionTitleCache.get(sessionId) ?? null;
  };

  const maybeCacheSessionInfoFromEvent = (payload: NotificationTemplateEvent | null | undefined, { spaceId = null }: { spaceId?: string | null } = {}) => {
    if (!payload || spaceId) return;
    const type = payload.type;
    if (type !== 'session.updated' && type !== 'session.created') return;
    const info = payload.properties?.info;
    if (!info) return;
    cacheSessionTitle(info.id, info.title);
  };

  const fetchSessionInfo = async (sessionId: string, source: NotificationTemplateSource) => {
    if (!sessionId) return null;

    const isHost = isHostSource(source);
    const cached = isHost ? sessionInfoCache.get(sessionId) : undefined;
    if (cached && Date.now() - cached.at < SESSION_INFO_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const url = source.buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, '');
      const response = await source.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...source.getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        console.warn(`[Notification] fetchSessionInfo: ${response.status} for session ${sessionId}`);
        return null;
      }
      const body: JsonValue = await response.json().catch(() => null);
      const data = unwrapOpenCodeResponse(body);
      if (isJsonObject(data)) {
        if (isHost) sessionInfoCache.set(sessionId, { data, at: Date.now() });
        return data;
      }
      return null;
    } catch (error) {
      console.warn(`[Notification] fetchSessionInfo failed for ${sessionId}:`, (hasErrorMessage(error) ? error.message : undefined) || error);
      return null;
    }
  };

  const resolvedChatRoots = chatRoots.filter(Boolean).map((root) => path.resolve(root));
  const isChatDirectory = (directory: string) => {
    const resolved = path.resolve(directory);
    return resolvedChatRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };

  const withGitTimeout = <T>(promise: PromiseLike<T>) => Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('git timeout')), GIT_TIMEOUT_MS)),
  ]);

  const folderName = (directory: string) => directory.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';

  const findProjectByPath = (projects: NotificationTemplateProject[], directory: string) => {
    const normalized = directory.replace(/\/+$/, '');
    return projects.find((project): project is NotificationTemplateProject & { path: string } => typeof project?.path === 'string' && project.path.replace(/\/+$/, '') === normalized) ?? null;
  };

  const resolveProjectNameForDirectory = async (projects: NotificationTemplateProject[], directory: string) => {
    if (isChatDirectory(directory)) return CHATS_PROJECT_LABEL;
    let project = findProjectByPath(projects, directory);
    if (!project) {
      const primaryRoot = await withGitTimeout(resolvePrimaryWorktreeRoot(directory)).then((result) => result.root, () => '');
      if (primaryRoot) project = findProjectByPath(projects, primaryRoot);
    }
    const label = isString(project?.label) ? project.label.trim() : '';
    return label || (project ? folderName(project.path) : folderName(directory));
  };

  const buildTemplateVariables = async (payload: NotificationTemplateEvent | null | undefined, sessionId?: string, source = hostSource): Promise<NotificationTemplateVariables> => {
    const info = payload?.properties?.info || {};

    const session = payload?.properties?.session;
    let sessionTitle = payload?.properties?.sessionTitle || (isJsonObject(session) ? session.title : undefined) || (isString(info.sessionTitle) ? info.sessionTitle : '') || '';

    const isHost = isHostSource(source);
    if (!sessionTitle && sessionId && isHost) {
      const cached = getCachedSessionTitle(sessionId);
      if (cached) {
        sessionTitle = cached;
      }
    }

    let sessionInfo = null;
    if (!sessionTitle && sessionId) {
      sessionInfo = await fetchSessionInfo(sessionId, source);
      if (sessionInfo && isString(sessionInfo.title)) {
        sessionTitle = sessionInfo.title;
        if (isHost) cacheSessionTitle(sessionId, sessionTitle);
      }
    }

    const agentName = (() => {
      const mode = isString(info.agent) && info.agent.trim().length > 0
        ? info.agent.trim()
        : (isString(info.mode) ? info.mode.trim() : '');
      if (!mode) return 'Agent';
      return mode.split(/[-_\s]+/).filter(Boolean)
        .map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(' ');
    })();

    const modelName = (() => {
      const raw = isString(info.modelID) ? info.modelID.trim()
        : (isJsonObject(info.model) && isString(info.model.modelID) ? info.model.modelID.trim() : '');
      if (!raw) return 'Assistant';
      return raw.split(/[-_]+/).filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    })();

    let projectName = '';
    let branch = '';
    let worktreeDir = '';
    if (isHost) {
      worktreeDir = isString(payload?.properties?.directory) ? payload.properties.directory.trim() : '';
      if (!worktreeDir && sessionId) {
        sessionInfo ??= await fetchSessionInfo(sessionId, source);
        const sessionDirectory = isJsonObject(sessionInfo?.location) ? sessionInfo.location.directory : undefined;
        if (isString(sessionDirectory)) worktreeDir = sessionDirectory.trim();
      }
    }

    try {
      const settings = await readSettingsFromDisk();
      const projects = Array.isArray(settings.projects) ? settings.projects : [];

      if (worktreeDir) {
        projectName = await resolveProjectNameForDirectory(projects, worktreeDir);
      } else {
        const activeId = isString(settings.activeProjectId) ? settings.activeProjectId : '';
        const activeProject = activeId ? projects.find((project) => project && project.id === activeId) : projects[0];
        if (activeProject) {
          projectName = isString(activeProject.label) && activeProject.label.trim().length > 0
            ? activeProject.label.trim()
            : isString(activeProject.path)
              ? activeProject.path.split('/').pop() || ''
              : '';
          worktreeDir = isString(activeProject.path) ? activeProject.path : '';
        }
      }
    } catch {
      if (worktreeDir && !projectName) {
        projectName = folderName(worktreeDir);
      }
    }

    if (worktreeDir) {
      try {
        const { simpleGit } = await import('simple-git');
        const git = simpleGit({
          baseDir: worktreeDir,
          spawnOptions: { windowsHide: true },
          binary: resolveGitBinaryForSpawn(),
          unsafe: { allowUnsafeCustomBinary: true },
        });
        branch = await withGitTimeout(git.revparse(['--abbrev-ref', 'HEAD'])).catch(() => '');
      } catch {
        void 0;
      }
    }

    return {
      project_name: formatProjectLabel(projectName),
      worktree: worktreeDir,
      branch: branch.trim(),
      session_name: sessionTitle,
      agent_name: agentName,
      model_name: modelName,
      last_message: '',
      session_id: sessionId || '',
    };
  };

  const getCachedZenModels = () => cachedZenModels;

  return {
    createTimeoutSignal,
    formatProjectLabel,
    resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage,
    fetchFreeZenModels,
    resolveZenModel,
    validateZenModelAtStartup,
    summarizeText,
    extractTextFromParts,
    extractLastMessageText,
    fetchLastAssistantMessageText,
    maybeCacheSessionInfoFromEvent,
    buildTemplateVariables,
    getCachedZenModels,
  };
};
