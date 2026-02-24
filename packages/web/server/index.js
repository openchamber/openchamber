import express from 'express';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import { createUiAuth } from './lib/opencode/ui-auth.js';
import { startCloudflareTunnel, printTunnelWarning, checkCloudflaredAvailable } from './lib/cloudflare-tunnel.js';
import { prepareNotificationLastMessage } from './lib/notifications/index.js';
import {
  TERMINAL_INPUT_WS_MAX_PAYLOAD_BYTES,
  TERMINAL_INPUT_WS_PATH,
  createTerminalInputWsControlFrame,
  isRebindRateLimited,
  normalizeTerminalInputWsMessageToText,
  parseRequestPathname,
  pruneRebindTimestamps,
  readTerminalInputWsControlFrame,
} from './lib/terminal/index.js';
import webPush from 'web-push';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 3000;
const DESKTOP_NOTIFY_PREFIX = '[OpenChamberDesktopNotify] ';
const uiNotificationClients = new Set();
const HEALTH_CHECK_INTERVAL = 15000;
const SHUTDOWN_TIMEOUT = 10000;
const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_METADATA_CACHE_TTL = 5 * 60 * 1000;
const CLIENT_RELOAD_DELAY_MS = 800;
const OPEN_CODE_READY_GRACE_MS = 12000;
const LONG_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
const fsPromises = fs.promises;
const DEFAULT_FILE_SEARCH_LIMIT = 60;
const MAX_FILE_SEARCH_LIMIT = 400;
const FILE_SEARCH_MAX_CONCURRENCY = 5;
const FILE_SEARCH_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'tmp',
  'logs'
]);

// Lock to prevent race conditions in persistSettings
let persistSettingsLock = Promise.resolve();

const normalizeDirectoryPath = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return os.homedir();
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
};

const OPENCHAMBER_USER_CONFIG_ROOT = path.join(os.homedir(), '.config', 'openchamber');
const OPENCHAMBER_USER_THEMES_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'themes');

const MAX_THEME_JSON_BYTES = 512 * 1024;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const isValidThemeColor = (value) => isNonEmptyString(value);

const normalizeThemeJson = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : null;
  const colors = raw.colors && typeof raw.colors === 'object' ? raw.colors : null;
  if (!metadata || !colors) {
    return null;
  }

  const id = metadata.id;
  const name = metadata.name;
  const variant = metadata.variant;
  if (!isNonEmptyString(id) || !isNonEmptyString(name) || (variant !== 'light' && variant !== 'dark')) {
    return null;
  }

  const primary = colors.primary;
  const surface = colors.surface;
  const interactive = colors.interactive;
  const status = colors.status;
  const syntax = colors.syntax;
  const syntaxBase = syntax && typeof syntax === 'object' ? syntax.base : null;
  const syntaxHighlights = syntax && typeof syntax === 'object' ? syntax.highlights : null;

  if (!primary || !surface || !interactive || !status || !syntaxBase || !syntaxHighlights) {
    return null;
  }

  // Minimal fields required by CSSVariableGenerator and diff/syntax rendering.
  const required = [
    primary.base,
    primary.foreground,
    surface.background,
    surface.foreground,
    surface.muted,
    surface.mutedForeground,
    surface.elevated,
    surface.elevatedForeground,
    surface.subtle,
    interactive.border,
    interactive.selection,
    interactive.selectionForeground,
    interactive.focusRing,
    interactive.hover,
    status.error,
    status.errorForeground,
    status.errorBackground,
    status.errorBorder,
    status.warning,
    status.warningForeground,
    status.warningBackground,
    status.warningBorder,
    status.success,
    status.successForeground,
    status.successBackground,
    status.successBorder,
    status.info,
    status.infoForeground,
    status.infoBackground,
    status.infoBorder,
    syntaxBase.background,
    syntaxBase.foreground,
    syntaxBase.keyword,
    syntaxBase.string,
    syntaxBase.number,
    syntaxBase.function,
    syntaxBase.variable,
    syntaxBase.type,
    syntaxBase.comment,
    syntaxBase.operator,
    syntaxHighlights.diffAdded,
    syntaxHighlights.diffRemoved,
    syntaxHighlights.lineNumber,
  ];

  if (!required.every(isValidThemeColor)) {
    return null;
  }

  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
    : [];

  return {
    ...raw,
    metadata: {
      ...metadata,
      id: id.trim(),
      name: name.trim(),
      description: typeof metadata.description === 'string' ? metadata.description : '',
      version: typeof metadata.version === 'string' && metadata.version.trim().length > 0 ? metadata.version : '1.0.0',
      variant,
      tags,
    },
  };
};

const readCustomThemesFromDisk = async () => {
  try {
    const entries = await fsPromises.readdir(OPENCHAMBER_USER_THEMES_DIR, { withFileTypes: true });
    const themes = [];
    const seen = new Set();

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.json')) continue;

      const filePath = path.join(OPENCHAMBER_USER_THEMES_DIR, entry.name);
      try {
        const stat = await fsPromises.stat(filePath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_THEME_JSON_BYTES) {
          console.warn(`[themes] Skip ${entry.name}: too large (${stat.size} bytes)`);
          continue;
        }

        const rawText = await fsPromises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(rawText);
        const normalized = normalizeThemeJson(parsed);
        if (!normalized) {
          console.warn(`[themes] Skip ${entry.name}: invalid theme JSON`);
          continue;
        }

        const id = normalized.metadata.id;
        if (seen.has(id)) {
          console.warn(`[themes] Skip ${entry.name}: duplicate theme id "${id}"`);
          continue;
        }

        seen.add(id);
        themes.push(normalized);
      } catch (error) {
        console.warn(`[themes] Failed to read ${entry.name}:`, error);
      }
    }

    return themes;
  } catch (error) {
    // Missing dir is fine.
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return [];
    }
    console.warn('[themes] Failed to list custom themes dir:', error);
    return [];
  }
};

const isPathWithinRoot = (resolvedPath, rootPath) => {
  const resolvedRoot = path.resolve(rootPath || os.homedir());
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return true;
};

const resolveWorkspacePath = (targetPath, baseDirectory) => {
  const normalized = normalizeDirectoryPath(targetPath);
  if (!normalized || typeof normalized !== 'string') {
    return { ok: false, error: 'Path is required' };
  }

  const resolved = path.resolve(normalized);
  const resolvedBase = path.resolve(baseDirectory || os.homedir());

  if (isPathWithinRoot(resolved, resolvedBase)) {
    return { ok: true, base: resolvedBase, resolved };
  }

  // Allow writing OpenChamber per-project config under ~/.config/openchamber.
  // LEGACY_PROJECT_CONFIG: migration target root; allowed outside workspace.
  if (isPathWithinRoot(resolved, OPENCHAMBER_USER_CONFIG_ROOT)) {
    return { ok: true, base: path.resolve(OPENCHAMBER_USER_CONFIG_ROOT), resolved };
  }

  return { ok: false, error: 'Path is outside of active workspace' };
};

const resolveWorkspacePathFromWorktrees = async (targetPath, baseDirectory) => {
  const normalized = normalizeDirectoryPath(targetPath);
  if (!normalized || typeof normalized !== 'string') {
    return { ok: false, error: 'Path is required' };
  }

  const resolved = path.resolve(normalized);
  const resolvedBase = path.resolve(baseDirectory || os.homedir());

  try {
    const { getWorktrees } = await import('./lib/git/index.js');
    const worktrees = await getWorktrees(resolvedBase);

    for (const worktree of worktrees) {
      const candidatePath = typeof worktree?.path === 'string'
        ? worktree.path
        : (typeof worktree?.worktree === 'string' ? worktree.worktree : '');
      const candidate = normalizeDirectoryPath(candidatePath);
      if (!candidate) {
        continue;
      }
      const candidateResolved = path.resolve(candidate);
      if (isPathWithinRoot(resolved, candidateResolved)) {
        return { ok: true, base: candidateResolved, resolved };
      }
    }
  } catch (error) {
    console.warn('Failed to resolve worktree roots:', error);
  }

  return { ok: false, error: 'Path is outside of active workspace' };
};

const resolveWorkspacePathFromContext = async (req, targetPath) => {
  const resolvedProject = await resolveProjectDirectory(req);
  if (!resolvedProject.directory) {
    return { ok: false, error: resolvedProject.error || 'Active workspace is required' };
  }

  const resolved = resolveWorkspacePath(targetPath, resolvedProject.directory);
  if (resolved.ok || resolved.error !== 'Path is outside of active workspace') {
    return resolved;
  }

  return resolveWorkspacePathFromWorktrees(targetPath, resolvedProject.directory);
};


const normalizeRelativeSearchPath = (rootPath, targetPath) => {
  const relative = path.relative(rootPath, targetPath) || path.basename(targetPath);
  return relative.split(path.sep).join('/') || targetPath;
};

const shouldSkipSearchDirectory = (name, includeHidden) => {
  if (!name) {
    return false;
  }
  if (!includeHidden && name.startsWith('.')) {
    return true;
  }
  return FILE_SEARCH_EXCLUDED_DIRS.has(name.toLowerCase());
};

const listDirectoryEntries = async (dirPath) => {
  try {
    return await fsPromises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
};

/**
 * Fuzzy match scoring function.
 * Returns a score > 0 if the query fuzzy-matches the candidate, null otherwise.
 * Higher scores indicate better matches.
 */
const fuzzyMatchScoreNormalized = (normalizedQuery, candidate) => {
  if (!normalizedQuery) return 0;

  const q = normalizedQuery;
  const c = candidate.toLowerCase();

  // Fast path: exact substring match gets high score
  if (c.includes(q)) {
    const idx = c.indexOf(q);
    // Bonus for match at start or after word boundary
    let bonus = 0;
    if (idx === 0) {
      bonus = 20;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        bonus = 15;
      }
    }
    return 100 + bonus - Math.min(idx, 20) - Math.floor(c.length / 5);
  }

  // Fuzzy match: all query chars must appear in order
  let score = 0;
  let lastIndex = -1;
  let consecutive = 0;

  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (!ch || ch === ' ') continue;

    const idx = c.indexOf(ch, lastIndex + 1);
    if (idx === -1) {
      return null; // No match
    }

    const gap = idx - lastIndex - 1;
    if (gap === 0) {
      consecutive++;
    } else {
      consecutive = 0;
    }

    score += 10;
    score += Math.max(0, 18 - idx); // Prefer matches near start
    score -= Math.min(gap, 10); // Penalize gaps

    // Bonus for word boundary matches
    if (idx === 0) {
      score += 12;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        score += 10;
      }
    }

    score += consecutive > 0 ? 12 : 0; // Bonus for consecutive matches
    lastIndex = idx;
  }

  // Prefer shorter paths
  score += Math.max(0, 24 - Math.floor(c.length / 3));

  return score;
};

const searchFilesystemFiles = async (rootPath, options) => {
  const { limit, query, includeHidden, respectGitignore } = options;
  const includeHiddenEntries = Boolean(includeHidden);
  const normalizedQuery = query.trim().toLowerCase();
  const matchAll = normalizedQuery.length === 0;
  const queue = [rootPath];
  const visited = new Set([rootPath]);
  const shouldRespectGitignore = respectGitignore !== false;
  // Collect more candidates for fuzzy matching, then sort and trim
  const collectLimit = matchAll ? limit : Math.max(limit * 3, 200);
  const candidates = [];

  while (queue.length > 0 && candidates.length < collectLimit) {
    const batch = queue.splice(0, FILE_SEARCH_MAX_CONCURRENCY);

    const dirResults = await Promise.all(
      batch.map(async (dir) => {
        if (!shouldRespectGitignore) {
          return { dir, dirents: await listDirectoryEntries(dir), ignoredPaths: new Set() };
        }

        try {
          const dirents = await listDirectoryEntries(dir);
          const pathsToCheck = dirents.map((dirent) => dirent.name).filter(Boolean);
          if (pathsToCheck.length === 0) {
            return { dir, dirents, ignoredPaths: new Set() };
          }

          const result = await new Promise((resolve) => {
            const child = spawn('git', ['check-ignore', '--', ...pathsToCheck], {
              cwd: dir,
              stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            child.stdout.on('data', (data) => { stdout += data.toString(); });
            child.on('close', () => resolve(stdout));
            child.on('error', () => resolve(''));
          });

          const ignoredNames = new Set(
            String(result)
              .split('\n')
              .map((name) => name.trim())
              .filter(Boolean)
          );

          return { dir, dirents, ignoredPaths: ignoredNames };
        } catch {
          return { dir, dirents: await listDirectoryEntries(dir), ignoredPaths: new Set() };
        }
      })
    );

    for (const { dir: currentDir, dirents, ignoredPaths } of dirResults) {
      for (const dirent of dirents) {
        const entryName = dirent.name;
        if (!entryName || (!includeHiddenEntries && entryName.startsWith('.'))) {
          continue;
        }

        if (shouldRespectGitignore && ignoredPaths.has(entryName)) {
          continue;
        }

        const entryPath = path.join(currentDir, entryName);

        if (dirent.isDirectory()) {
          if (shouldSkipSearchDirectory(entryName, includeHiddenEntries)) {
            continue;
          }
          if (!visited.has(entryPath)) {
            visited.add(entryPath);
            queue.push(entryPath);
          }
          continue;
        }

        if (!dirent.isFile()) {
          continue;
        }

        const relativePath = normalizeRelativeSearchPath(rootPath, entryPath);
        const extension = entryName.includes('.') ? entryName.split('.').pop()?.toLowerCase() : undefined;

        if (matchAll) {
          candidates.push({
            name: entryName,
            path: entryPath,
            relativePath,
            extension,
            score: 0
          });
        } else {
          // Try fuzzy match against relative path (includes filename)
          const score = fuzzyMatchScoreNormalized(normalizedQuery, relativePath);
          if (score !== null) {
            candidates.push({
              name: entryName,
              path: entryPath,
              relativePath,
              extension,
              score
            });
          }
        }

        if (candidates.length >= collectLimit) {
          queue.length = 0;
          break;
        }
      }

      if (candidates.length >= collectLimit) {
        break;
      }
    }
  }

  // Sort by score descending, then by path length, then alphabetically
  if (!matchAll) {
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.relativePath.length !== b.relativePath.length) {
        return a.relativePath.length - b.relativePath.length;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });
  }

  // Return top results without the score field
  return candidates.slice(0, limit).map(({ name, path: filePath, relativePath, extension }) => ({
    name,
    path: filePath,
    relativePath,
    extension
  }));
};

const createTimeoutSignal = (timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
};

/** Humanize a project label: replace dashes/underscores with spaces, title-case each word. Mirrors the UI's formatProjectLabel. */
const formatProjectLabel = (label) => {
  if (!label || typeof label !== 'string') return '';
  return label
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const resolveNotificationTemplate = (template, variables) => {
  if (!template || typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = variables[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
};

const shouldApplyResolvedTemplateMessage = (template, resolved, variables) => {
  if (!resolved) {
    return false;
  }

  if (typeof template !== 'string') {
    return true;
  }

  if (template.includes('{last_message}')) {
    return typeof variables?.last_message === 'string' && variables.last_message.trim().length > 0;
  }

  return true;
};

const ZEN_DEFAULT_MODEL = 'gpt-5-nano';

/**
 * Validated fallback zen model determined at startup by checking available free
 * models from the zen API. When `null`, startup validation hasn't run yet (or
 * failed), so `resolveZenModel` falls back to `ZEN_DEFAULT_MODEL`.
 */
let validatedZenFallback = null;

/** Cached free zen models response and timestamp (shared by startup + endpoint). */
let cachedZenModels = null;
let cachedZenModelsTimestamp = 0;
const ZEN_MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch free models from the zen API with caching. Returns an array of
 * `{ id, owned_by }` objects (may be empty on failure). Results are cached
 * for `ZEN_MODELS_CACHE_TTL` ms.
 */
const fetchFreeZenModels = async () => {
  const now = Date.now();
  if (cachedZenModels && now - cachedZenModelsTimestamp < ZEN_MODELS_CACHE_TTL) {
    return cachedZenModels.models;
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;
  try {
    const response = await fetch('https://opencode.ai/zen/v1/models', {
      signal: controller?.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`zen/v1/models responded with status ${response.status}`);
    }
    const data = await response.json();
    const allModels = Array.isArray(data?.data) ? data.data : [];
    const freeModels = allModels
      .filter((m) => typeof m?.id === 'string' && m.id.endsWith('-free'))
      .map((m) => ({ id: m.id, owned_by: m.owned_by }));

    cachedZenModels = { models: freeModels };
    cachedZenModelsTimestamp = Date.now();
    return freeModels;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

/**
 * Resolve the zen model to use. Checks the provided override first,
 * then falls back to the stored zenModel setting, then to the validated
 * startup fallback, then to the hardcoded default.
 */
const resolveZenModel = async (override) => {
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  try {
    const settings = await readSettingsFromDisk();
    if (typeof settings?.zenModel === 'string' && settings.zenModel.trim().length > 0) {
      return settings.zenModel.trim();
    }
  } catch {
    // ignore
  }
  return validatedZenFallback || ZEN_DEFAULT_MODEL;
};

const summarizeText = async (text, targetLength, zenModel) => {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return text;

  try {
    const prompt = `Summarize the following text in approximately ${targetLength} characters. Be concise and capture the key point. Output ONLY the summary text, nothing else.\n\nText:\n${text}`;

    const completionTimeout = createTimeoutSignal(15000);
    let response;
    try {
      response = await fetch('https://opencode.ai/zen/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: zenModel || ZEN_DEFAULT_MODEL,
          input: [{ role: 'user', content: prompt }],
          max_output_tokens: 1000,
          stream: false,
          reasoning: { effort: 'low' },
        }),
        signal: completionTimeout.signal,
      });
    } finally {
      completionTimeout.cleanup();
    }

    if (!response.ok) return text;

    const data = await response.json();
    const summary = data?.output?.find((item) => item?.type === 'message')
      ?.content?.find((item) => item?.type === 'output_text')?.text?.trim();

    return summary || text;
  } catch {
    return text;
  }
};

const NOTIFICATION_BODY_MAX_CHARS = 1000;

/**
 * Extract text from parts array (used when parts are available inline or fetched from API).
 */
const extractTextFromParts = (parts, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
  if (!Array.isArray(parts) || parts.length === 0) return '';

  const textParts = parts
    .filter((p) => p && (p.type === 'text' || typeof p.text === 'string' || typeof p.content === 'string'))
    .map((p) => p.text || p.content || '')
    .filter(Boolean);

  let text = textParts.length > 0 ? textParts.join('\n').trim() : '';

  // Truncate to prevent oversized notification payloads
  if (maxLength > 0 && text.length > maxLength) {
    text = text.slice(0, maxLength);
  }

  return text;
};

/**
 * Try to extract message text from the payload itself (fast path).
 * Note: message.updated events from the OpenCode SSE stream typically do NOT include
 * parts inline — parts are sent via separate message.part.updated events. This function
 * is a fast path for the rare case where parts are included.
 */
const extractLastMessageText = (payload, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
  const info = payload?.properties?.info;
  if (!info) return '';

  // Try inline parts on info or on properties
  const parts = info.parts || payload?.properties?.parts;
  const text = extractTextFromParts(parts, maxLength);
  if (text) return text;

  // Fallback: try content array (legacy)
  const content = info.content;
  if (Array.isArray(content)) {
    const textContent = content
      .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
      .map((c) => c.text || '')
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

/**
 * Fetch the last assistant message text from the OpenCode API.
 * This is needed because message.updated events don't include parts;
 * we must fetch them separately via the session messages endpoint.
 */
const fetchLastAssistantMessageText = async (sessionId, messageId, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
  if (!sessionId) return '';

  try {
    // Fetch last few messages to find the one that triggered the notification
    const url = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
    const response = await fetch(`${url}?limit=5`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) return '';

    const messages = await response.json().catch(() => null);
    if (!Array.isArray(messages)) return '';

    // Find the specific message by ID, or fall back to the last assistant message
    let target = null;
    if (messageId) {
      target = messages.find((m) => m?.info?.id === messageId && m?.info?.role === 'assistant');
    }
    if (!target) {
      // Find the last assistant message with finish === 'stop'
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.info?.role === 'assistant' && m?.info?.finish === 'stop') {
          target = m;
          break;
        }
      }
    }

    if (!target || !Array.isArray(target.parts)) return '';

    return extractTextFromParts(target.parts, maxLength);
  } catch {
    return '';
  }
};

/**
 * In-memory cache of session titles populated from SSE session.updated / session.created events.
 * This is the preferred source for session titles since it is populated passively and doesn't
 * require a separate API call.
 */
const sessionTitleCache = new Map();

const cacheSessionTitle = (sessionId, title) => {
  if (typeof sessionId === 'string' && sessionId.length > 0 &&
      typeof title === 'string' && title.length > 0) {
    sessionTitleCache.set(sessionId, title);
  }
};

const getCachedSessionTitle = (sessionId) => {
  return sessionTitleCache.get(sessionId) ?? null;
};

/**
 * Extract and cache session title from session.updated / session.created SSE events.
 * Called by the global event watcher to passively maintain the title cache.
 */
const maybeCacheSessionInfoFromEvent = (payload) => {
  if (!payload || typeof payload !== 'object') return;
  const type = payload.type;
  if (type !== 'session.updated' && type !== 'session.created') return;
  const info = payload.properties?.info;
  if (!info || typeof info !== 'object') return;
  const sessionId = info.id;
  const title = info.title;
  cacheSessionTitle(sessionId, title);
};

/**
 * Fetch session metadata (title, directory) from the OpenCode API.
 * Cached for 60s per session to avoid repeated API calls.
 */
const sessionInfoCache = new Map();
const SESSION_INFO_CACHE_TTL_MS = 60 * 1000;

const fetchSessionInfo = async (sessionId) => {
  if (!sessionId) return null;

  const cached = sessionInfoCache.get(sessionId);
  if (cached && Date.now() - cached.at < SESSION_INFO_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      console.warn(`[Notification] fetchSessionInfo: ${response.status} for session ${sessionId}`);
      return null;
    }
    const data = await response.json().catch(() => null);
    if (data && typeof data === 'object') {
      sessionInfoCache.set(sessionId, { data, at: Date.now() });
      return data;
    }
    return null;
  } catch (err) {
    console.warn(`[Notification] fetchSessionInfo failed for ${sessionId}:`, err?.message || err);
    return null;
  }
};

const buildTemplateVariables = async (payload, sessionId) => {
  const info = payload?.properties?.info || {};

  // Session title — try inline payload, then SSE cache, then API fetch
  let sessionTitle = payload?.properties?.sessionTitle ||
    payload?.properties?.session?.title ||
    (typeof info.sessionTitle === 'string' ? info.sessionTitle : '') ||
    '';

  // Try the SSE-populated session title cache (filled from session.updated / session.created events)
  if (!sessionTitle && sessionId) {
    const cached = getCachedSessionTitle(sessionId);
    if (cached) {
      sessionTitle = cached;
    }
  }

  // Last resort: fetch session info from the API
  let sessionInfo = null;
  if (!sessionTitle && sessionId) {
    sessionInfo = await fetchSessionInfo(sessionId);
    if (sessionInfo && typeof sessionInfo.title === 'string') {
      sessionTitle = sessionInfo.title;
      // Populate the SSE cache so future notifications don't need an API call
      cacheSessionTitle(sessionId, sessionTitle);
    }
  }

  // Agent name from mode or agent field (v2 has both mode and agent)
  const agentName = (() => {
    const mode = typeof info.agent === 'string' && info.agent.trim().length > 0
      ? info.agent.trim()
      : (typeof info.mode === 'string' ? info.mode.trim() : '');
    if (!mode) return 'Agent';
    return mode.split(/[-_\s]+/).filter(Boolean)
      .map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' ');
  })();

  // Model name — v2 has modelID directly on info, v1 user messages nest it under info.model.modelID
  const modelName = (() => {
    const raw = typeof info.modelID === 'string' ? info.modelID.trim()
      : (typeof info.model?.modelID === 'string' ? info.model.modelID.trim() : '');
    if (!raw) return 'Assistant';
    return raw.split(/[-_]+/).filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  })();

  // Project name, branch, worktree — derived from multiple sources with fallbacks
  let projectName = '';
  let branch = '';
  let worktreeDir = '';

  // 1. Primary source: the message payload's path (always accurate for the session)
  const infoPath = info.path;
  if (typeof infoPath?.root === 'string' && infoPath.root.length > 0) {
    worktreeDir = infoPath.root;
  } else if (typeof infoPath?.cwd === 'string' && infoPath.cwd.length > 0) {
    worktreeDir = infoPath.cwd;
  }

  // 2. Look up the user-facing project label from stored settings
  try {
    const settings = await readSettingsFromDisk();
    const projects = Array.isArray(settings.projects) ? settings.projects : [];

    if (worktreeDir) {
      // Match the session directory against stored projects to find the label
      const normalizedDir = worktreeDir.replace(/\/+$/, '');
      const matchedProject = projects.find((p) => {
        if (!p || typeof p.path !== 'string') return false;
        return p.path.replace(/\/+$/, '') === normalizedDir;
      });
      if (matchedProject && typeof matchedProject.label === 'string' && matchedProject.label.trim().length > 0) {
        projectName = matchedProject.label.trim();
      } else {
        // No label stored — derive from directory name
        projectName = normalizedDir.split('/').filter(Boolean).pop() || '';
      }
    } else {
      // No directory from payload — fall back to active project
      const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
      const activeProject = activeId ? projects.find((p) => p && p.id === activeId) : projects[0];
      if (activeProject) {
        projectName = typeof activeProject.label === 'string' && activeProject.label.trim().length > 0
          ? activeProject.label.trim()
          : typeof activeProject.path === 'string'
            ? activeProject.path.split('/').pop() || ''
            : '';
        worktreeDir = typeof activeProject.path === 'string' ? activeProject.path : '';
      }
    }
  } catch {
    // Settings read failed — derive from directory if available
    if (worktreeDir && !projectName) {
      projectName = worktreeDir.split('/').filter(Boolean).pop() || '';
    }
  }

  // 3. Get branch from git
  if (worktreeDir) {
    try {
      const { simpleGit } = await import('simple-git');
      const git = simpleGit(worktreeDir);
      branch = await Promise.race([
        git.revparse(['--abbrev-ref', 'HEAD']),
        new Promise((_, reject) => setTimeout(() => reject(new Error('git timeout')), 3000)),
      ]).catch(() => '');
    } catch {
      // ignore — git may not be available
    }
  }

  return {
    project_name: formatProjectLabel(projectName),
    worktree: worktreeDir,
    branch: typeof branch === 'string' ? branch.trim() : '',
    session_name: sessionTitle,
    agent_name: agentName,
    model_name: modelName,
    last_message: '', // Populated by caller
    session_id: sessionId || '',
  };
};

const stripJsonMarkdownWrapper = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  let trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '');
    const closingFenceIndex = trimmed.lastIndexOf('```');
    if (closingFenceIndex !== -1) {
      trimmed = trimmed.slice(0, closingFenceIndex);
    }
    trimmed = trimmed.trim();
  }
  if (trimmed.endsWith('```')) {
    trimmed = trimmed.slice(0, -3).trim();
  }
  return trimmed;
};

const extractJsonObject = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const source = value.trim();
  if (!source) {
    return null;
  }
  let start = source.indexOf('{');
  while (start !== -1) {
    let end = source.indexOf('}', start + 1);
    while (end !== -1) {
      const candidate = source.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        end = source.indexOf('}', end + 1);
      }
    }
    start = source.indexOf('{', start + 1);
  }
  return null;
};

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');
const SETTINGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'push-subscriptions.json');

const readSettingsFromDisk = async () => {
  try {
    const raw = await fsPromises.readFile(SETTINGS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    return {};
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return {};
    }
    console.warn('Failed to read settings file:', error);
    return {};
  }
};

const writeSettingsToDisk = async (settings) => {
  try {
    await fsPromises.mkdir(path.dirname(SETTINGS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(SETTINGS_FILE_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.warn('Failed to write settings file:', error);
    throw error;
  }
};

const PUSH_SUBSCRIPTIONS_VERSION = 1;
let persistPushSubscriptionsLock = Promise.resolve();

const readPushSubscriptionsFromDisk = async () => {
  try {
    const raw = await fsPromises.readFile(PUSH_SUBSCRIPTIONS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }
    if (typeof parsed.version !== 'number' || parsed.version !== PUSH_SUBSCRIPTIONS_VERSION) {
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }

    const subscriptionsBySession =
      parsed.subscriptionsBySession && typeof parsed.subscriptionsBySession === 'object'
        ? parsed.subscriptionsBySession
        : {};

    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
    }
    console.warn('Failed to read push subscriptions file:', error);
    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: {} };
  }
};

const writePushSubscriptionsToDisk = async (data) => {
  await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
  await fsPromises.writeFile(PUSH_SUBSCRIPTIONS_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
};

const persistPushSubscriptionUpdate = async (mutate) => {
  persistPushSubscriptionsLock = persistPushSubscriptionsLock.then(async () => {
    await fsPromises.mkdir(path.dirname(PUSH_SUBSCRIPTIONS_FILE_PATH), { recursive: true });
    const current = await readPushSubscriptionsFromDisk();
    const next = mutate({
      version: PUSH_SUBSCRIPTIONS_VERSION,
      subscriptionsBySession: current.subscriptionsBySession || {},
    });
    await writePushSubscriptionsToDisk(next);
    return next;
  });

  return persistPushSubscriptionsLock;
};

const resolveDirectoryCandidate = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeDirectoryPath(trimmed);
  return path.resolve(normalized);
};

const validateDirectoryPath = async (candidate) => {
  const resolved = resolveDirectoryCandidate(candidate);
  if (!resolved) {
    return { ok: false, error: 'Directory parameter is required' };
  }
  try {
    const stats = await fsPromises.stat(resolved);
    if (!stats.isDirectory()) {
      return { ok: false, error: 'Specified path is not a directory' };
    }
    return { ok: true, directory: resolved };
  } catch (error) {
    const err = error;
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      return { ok: false, error: 'Directory not found' };
    }
    if (err && typeof err === 'object' && err.code === 'EACCES') {
      return { ok: false, error: 'Access to directory denied' };
    }
    return { ok: false, error: 'Failed to validate directory' };
  }
};

const resolveProjectDirectory = async (req) => {
  const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
  const queryDirectory = Array.isArray(req.query?.directory)
    ? req.query.directory[0]
    : req.query?.directory;
  const requested = headerDirectory || queryDirectory || null;

  if (requested) {
    const validated = await validateDirectoryPath(requested);
    if (!validated.ok) {
      return { directory: null, error: validated.error };
    }
    return { directory: validated.directory, error: null };
  }

  const settings = await readSettingsFromDiskMigrated();
  const projects = sanitizeProjects(settings.projects) || [];
  if (projects.length === 0) {
    return { directory: null, error: 'Directory parameter or active project is required' };
  }

  const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
  const active = projects.find((project) => project.id === activeId) || projects[0];
  if (!active || !active.path) {
    return { directory: null, error: 'Directory parameter or active project is required' };
  }

  const validated = await validateDirectoryPath(active.path);
  if (!validated.ok) {
    return { directory: null, error: validated.error };
  }

  return { directory: validated.directory, error: null };
};

const resolveOptionalProjectDirectory = async (req) => {
  const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
  const queryDirectory = Array.isArray(req.query?.directory)
    ? req.query.directory[0]
    : req.query?.directory;
  const requested = headerDirectory || queryDirectory || null;

  if (!requested) {
    return { directory: null, error: null };
  }

  const validated = await validateDirectoryPath(requested);
  if (!validated.ok) {
    return { directory: null, error: validated.error };
  }

  return { directory: validated.directory, error: null };
};

const sanitizeTypographySizesPartial = (input) => {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const candidate = input;
  const result = {};
  let populated = false;

  const assign = (key) => {
    if (typeof candidate[key] === 'string' && candidate[key].length > 0) {
      result[key] = candidate[key];
      populated = true;
    }
  };

  assign('markdown');
  assign('code');
  assign('uiHeader');
  assign('uiLabel');
  assign('meta');
  assign('micro');

  return populated ? result : undefined;
};

const normalizeStringArray = (input) => {
  if (!Array.isArray(input)) {
    return [];
  }
  return Array.from(
    new Set(
      input.filter((entry) => typeof entry === 'string' && entry.length > 0)
    )
  );
};

const sanitizeModelRefs = (input, limit) => {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const result = [];
  const seen = new Set();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const providerID = typeof entry.providerID === 'string' ? entry.providerID.trim() : '';
    const modelID = typeof entry.modelID === 'string' ? entry.modelID.trim() : '';
    if (!providerID || !modelID) continue;
    const key = `${providerID}/${modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ providerID, modelID });
    if (result.length >= limit) break;
  }

  return result;
};

const sanitizeSkillCatalogs = (input) => {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const result = [];
  const seen = new Set();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    const source = typeof entry.source === 'string' ? entry.source.trim() : '';
    const subpath = typeof entry.subpath === 'string' ? entry.subpath.trim() : '';
    const gitIdentityId = typeof entry.gitIdentityId === 'string' ? entry.gitIdentityId.trim() : '';

    if (!id || !label || !source) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    result.push({
      id,
      label,
      source,
      ...(subpath ? { subpath } : {}),
      ...(gitIdentityId ? { gitIdentityId } : {}),
    });
  }

  return result;
};

const sanitizeProjects = (input) => {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const result = [];
  const seenIds = new Set();
  const seenPaths = new Set();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;

    const candidate = entry;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    const normalizedPath = rawPath ? path.resolve(normalizeDirectoryPath(rawPath)) : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const icon = typeof candidate.icon === 'string' ? candidate.icon.trim() : '';
    const color = typeof candidate.color === 'string' ? candidate.color.trim() : '';
    const addedAt = Number.isFinite(candidate.addedAt) ? Number(candidate.addedAt) : null;
    const lastOpenedAt = Number.isFinite(candidate.lastOpenedAt)
      ? Number(candidate.lastOpenedAt)
      : null;

    if (!id || !normalizedPath) continue;
    if (seenIds.has(id)) continue;
    if (seenPaths.has(normalizedPath)) continue;

    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project = {
      id,
      path: normalizedPath,
      ...(label ? { label } : {}),
      ...(icon ? { icon } : {}),
      ...(color ? { color } : {}),
      ...(Number.isFinite(addedAt) && addedAt >= 0 ? { addedAt } : {}),
      ...(Number.isFinite(lastOpenedAt) && lastOpenedAt >= 0 ? { lastOpenedAt } : {}),
    };

    if (typeof candidate.sidebarCollapsed === 'boolean') {
      project.sidebarCollapsed = candidate.sidebarCollapsed;
    }

    result.push(project);
  }

  return result;
};

const sanitizeSettingsUpdate = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const candidate = payload;
  const result = {};

  if (typeof candidate.themeId === 'string' && candidate.themeId.length > 0) {
    result.themeId = candidate.themeId;
  }
  if (typeof candidate.themeVariant === 'string' && (candidate.themeVariant === 'light' || candidate.themeVariant === 'dark')) {
    result.themeVariant = candidate.themeVariant;
  }
  if (typeof candidate.useSystemTheme === 'boolean') {
    result.useSystemTheme = candidate.useSystemTheme;
  }
  if (typeof candidate.lightThemeId === 'string' && candidate.lightThemeId.length > 0) {
    result.lightThemeId = candidate.lightThemeId;
  }
  if (typeof candidate.darkThemeId === 'string' && candidate.darkThemeId.length > 0) {
    result.darkThemeId = candidate.darkThemeId;
  }
  if (typeof candidate.lastDirectory === 'string' && candidate.lastDirectory.length > 0) {
    result.lastDirectory = candidate.lastDirectory;
  }
  if (typeof candidate.homeDirectory === 'string' && candidate.homeDirectory.length > 0) {
    result.homeDirectory = candidate.homeDirectory;
  }

  // Absolute path to the opencode CLI binary (optional override).
  // Accept empty-string to clear (we persist an empty string sentinel so the running
  // process can reliably drop a previously applied OPENCODE_BINARY override).
  if (typeof candidate.opencodeBinary === 'string') {
    const normalized = normalizeDirectoryPath(candidate.opencodeBinary).trim();
    result.opencodeBinary = normalized;
  }
  if (Array.isArray(candidate.projects)) {
    const projects = sanitizeProjects(candidate.projects);
    if (projects) {
      result.projects = projects;
    }
  }
  if (typeof candidate.activeProjectId === 'string' && candidate.activeProjectId.length > 0) {
    result.activeProjectId = candidate.activeProjectId;
  }

  if (Array.isArray(candidate.approvedDirectories)) {
    result.approvedDirectories = normalizeStringArray(candidate.approvedDirectories);
  }
  if (Array.isArray(candidate.securityScopedBookmarks)) {
    result.securityScopedBookmarks = normalizeStringArray(candidate.securityScopedBookmarks);
  }
  if (Array.isArray(candidate.pinnedDirectories)) {
    result.pinnedDirectories = normalizeStringArray(candidate.pinnedDirectories);
  }


  if (typeof candidate.uiFont === 'string' && candidate.uiFont.length > 0) {
    result.uiFont = candidate.uiFont;
  }
  if (typeof candidate.monoFont === 'string' && candidate.monoFont.length > 0) {
    result.monoFont = candidate.monoFont;
  }
  if (typeof candidate.markdownDisplayMode === 'string' && candidate.markdownDisplayMode.length > 0) {
    result.markdownDisplayMode = candidate.markdownDisplayMode;
  }
  if (typeof candidate.githubClientId === 'string') {
    const trimmed = candidate.githubClientId.trim();
    if (trimmed.length > 0) {
      result.githubClientId = trimmed;
    }
  }
  if (typeof candidate.githubScopes === 'string') {
    const trimmed = candidate.githubScopes.trim();
    if (trimmed.length > 0) {
      result.githubScopes = trimmed;
    }
  }
  if (typeof candidate.showReasoningTraces === 'boolean') {
    result.showReasoningTraces = candidate.showReasoningTraces;
  }
  if (typeof candidate.showTextJustificationActivity === 'boolean') {
    result.showTextJustificationActivity = candidate.showTextJustificationActivity;
  }
  if (typeof candidate.showDeletionDialog === 'boolean') {
    result.showDeletionDialog = candidate.showDeletionDialog;
  }
  if (typeof candidate.nativeNotificationsEnabled === 'boolean') {
    result.nativeNotificationsEnabled = candidate.nativeNotificationsEnabled;
  }
  if (typeof candidate.notificationMode === 'string') {
    const mode = candidate.notificationMode.trim();
    if (mode === 'always' || mode === 'hidden-only') {
      result.notificationMode = mode;
    }
  }
  if (typeof candidate.notifyOnSubtasks === 'boolean') {
    result.notifyOnSubtasks = candidate.notifyOnSubtasks;
  }
  if (typeof candidate.notifyOnCompletion === 'boolean') {
    result.notifyOnCompletion = candidate.notifyOnCompletion;
  }
  if (typeof candidate.notifyOnError === 'boolean') {
    result.notifyOnError = candidate.notifyOnError;
  }
  if (typeof candidate.notifyOnQuestion === 'boolean') {
    result.notifyOnQuestion = candidate.notifyOnQuestion;
  }
  if (candidate.notificationTemplates && typeof candidate.notificationTemplates === 'object') {
    result.notificationTemplates = candidate.notificationTemplates;
  }
  if (typeof candidate.summarizeLastMessage === 'boolean') {
    result.summarizeLastMessage = candidate.summarizeLastMessage;
  }
  if (typeof candidate.summaryThreshold === 'number' && Number.isFinite(candidate.summaryThreshold)) {
    result.summaryThreshold = Math.max(0, Math.round(candidate.summaryThreshold));
  }
  if (typeof candidate.summaryLength === 'number' && Number.isFinite(candidate.summaryLength)) {
    result.summaryLength = Math.max(10, Math.round(candidate.summaryLength));
  }
  if (typeof candidate.maxLastMessageLength === 'number' && Number.isFinite(candidate.maxLastMessageLength)) {
    result.maxLastMessageLength = Math.max(10, Math.round(candidate.maxLastMessageLength));
  }
  if (typeof candidate.usageAutoRefresh === 'boolean') {
    result.usageAutoRefresh = candidate.usageAutoRefresh;
  }
  if (typeof candidate.usageRefreshIntervalMs === 'number' && Number.isFinite(candidate.usageRefreshIntervalMs)) {
    result.usageRefreshIntervalMs = Math.max(30000, Math.min(300000, Math.round(candidate.usageRefreshIntervalMs)));
  }
  if (Array.isArray(candidate.usageDropdownProviders)) {
    result.usageDropdownProviders = normalizeStringArray(candidate.usageDropdownProviders);
  }
  if (typeof candidate.autoDeleteEnabled === 'boolean') {
    result.autoDeleteEnabled = candidate.autoDeleteEnabled;
  }
  if (typeof candidate.autoDeleteAfterDays === 'number' && Number.isFinite(candidate.autoDeleteAfterDays)) {
    const normalizedDays = Math.max(1, Math.min(365, Math.round(candidate.autoDeleteAfterDays)));
    result.autoDeleteAfterDays = normalizedDays;
  }

  const typography = sanitizeTypographySizesPartial(candidate.typographySizes);
  if (typography) {
    result.typographySizes = typography;
  }

  if (typeof candidate.defaultModel === 'string') {
    const trimmed = candidate.defaultModel.trim();
    result.defaultModel = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.defaultVariant === 'string') {
    const trimmed = candidate.defaultVariant.trim();
    result.defaultVariant = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.defaultAgent === 'string') {
    const trimmed = candidate.defaultAgent.trim();
    result.defaultAgent = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.defaultGitIdentityId === 'string') {
    const trimmed = candidate.defaultGitIdentityId.trim();
    result.defaultGitIdentityId = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.queueModeEnabled === 'boolean') {
    result.queueModeEnabled = candidate.queueModeEnabled;
  }
  if (typeof candidate.autoCreateWorktree === 'boolean') {
    result.autoCreateWorktree = candidate.autoCreateWorktree;
  }
  if (typeof candidate.gitmojiEnabled === 'boolean') {
    result.gitmojiEnabled = candidate.gitmojiEnabled;
  }
  if (typeof candidate.zenModel === 'string') {
    const trimmed = candidate.zenModel.trim();
    result.zenModel = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.toolCallExpansion === 'string') {
    const mode = candidate.toolCallExpansion.trim();
    if (mode === 'collapsed' || mode === 'activity' || mode === 'detailed') {
      result.toolCallExpansion = mode;
    }
  }
  if (typeof candidate.fontSize === 'number' && Number.isFinite(candidate.fontSize)) {
    result.fontSize = Math.max(50, Math.min(200, Math.round(candidate.fontSize)));
  }
  if (typeof candidate.terminalFontSize === 'number' && Number.isFinite(candidate.terminalFontSize)) {
    result.terminalFontSize = Math.max(9, Math.min(52, Math.round(candidate.terminalFontSize)));
  }
  if (typeof candidate.padding === 'number' && Number.isFinite(candidate.padding)) {
    result.padding = Math.max(50, Math.min(200, Math.round(candidate.padding)));
  }
  if (typeof candidate.cornerRadius === 'number' && Number.isFinite(candidate.cornerRadius)) {
    result.cornerRadius = Math.max(0, Math.min(32, Math.round(candidate.cornerRadius)));
  }
  if (typeof candidate.inputBarOffset === 'number' && Number.isFinite(candidate.inputBarOffset)) {
    result.inputBarOffset = Math.max(0, Math.min(100, Math.round(candidate.inputBarOffset)));
  }

  const favoriteModels = sanitizeModelRefs(candidate.favoriteModels, 64);
  if (favoriteModels) {
    result.favoriteModels = favoriteModels;
  }

  const recentModels = sanitizeModelRefs(candidate.recentModels, 16);
  if (recentModels) {
    result.recentModels = recentModels;
  }
  if (typeof candidate.diffLayoutPreference === 'string') {
    const mode = candidate.diffLayoutPreference.trim();
    if (mode === 'dynamic' || mode === 'inline' || mode === 'side-by-side') {
      result.diffLayoutPreference = mode;
    }
  }
  if (typeof candidate.diffViewMode === 'string') {
    const mode = candidate.diffViewMode.trim();
    if (mode === 'single' || mode === 'stacked') {
      result.diffViewMode = mode;
    }
  }
  if (typeof candidate.directoryShowHidden === 'boolean') {
    result.directoryShowHidden = candidate.directoryShowHidden;
  }
  if (typeof candidate.filesViewShowGitignored === 'boolean') {
    result.filesViewShowGitignored = candidate.filesViewShowGitignored;
  }
  if (typeof candidate.openInAppId === 'string') {
    const trimmed = candidate.openInAppId.trim();
    if (trimmed.length > 0) {
      result.openInAppId = trimmed;
    }
  }

  // Message limit — single setting for fetch / trim / Load More chunk
  if (typeof candidate.messageLimit === 'number' && Number.isFinite(candidate.messageLimit)) {
    result.messageLimit = Math.max(10, Math.min(500, Math.round(candidate.messageLimit)));
  }

  const skillCatalogs = sanitizeSkillCatalogs(candidate.skillCatalogs);
  if (skillCatalogs) {
    result.skillCatalogs = skillCatalogs;
  }

  // Usage model selections - which models appear in dropdown
  if (candidate.usageSelectedModels && typeof candidate.usageSelectedModels === 'object') {
    const sanitized = {};
    for (const [providerId, models] of Object.entries(candidate.usageSelectedModels)) {
      if (typeof providerId === 'string' && Array.isArray(models)) {
        const validModels = models.filter((m) => typeof m === 'string' && m.length > 0);
        if (validModels.length > 0) {
          sanitized[providerId] = validModels;
        }
      }
    }
    if (Object.keys(sanitized).length > 0) {
      result.usageSelectedModels = sanitized;
    }
  }

  // Usage page collapsed families - for "Other Models" section
  if (candidate.usageCollapsedFamilies && typeof candidate.usageCollapsedFamilies === 'object') {
    const sanitized = {};
    for (const [providerId, families] of Object.entries(candidate.usageCollapsedFamilies)) {
      if (typeof providerId === 'string' && Array.isArray(families)) {
        const validFamilies = families.filter((f) => typeof f === 'string' && f.length > 0);
        if (validFamilies.length > 0) {
          sanitized[providerId] = validFamilies;
        }
      }
    }
    if (Object.keys(sanitized).length > 0) {
      result.usageCollapsedFamilies = sanitized;
    }
  }

  // Header dropdown expanded families (inverted - stores EXPANDED, default all collapsed)
  if (candidate.usageExpandedFamilies && typeof candidate.usageExpandedFamilies === 'object') {
    const sanitized = {};
    for (const [providerId, families] of Object.entries(candidate.usageExpandedFamilies)) {
      if (typeof providerId === 'string' && Array.isArray(families)) {
        const validFamilies = families.filter((f) => typeof f === 'string' && f.length > 0);
        if (validFamilies.length > 0) {
          sanitized[providerId] = validFamilies;
        }
      }
    }
    if (Object.keys(sanitized).length > 0) {
      result.usageExpandedFamilies = sanitized;
    }
  }

  // Custom model groups configuration
  if (candidate.usageModelGroups && typeof candidate.usageModelGroups === 'object') {
    const sanitized = {};
    for (const [providerId, config] of Object.entries(candidate.usageModelGroups)) {
      if (typeof providerId !== 'string') continue;

      const providerConfig = {};

      // customGroups: array of {id, label, models, order}
      if (Array.isArray(config.customGroups)) {
        const validGroups = config.customGroups
          .filter((g) => g && typeof g.id === 'string' && typeof g.label === 'string')
          .map((g) => ({
            id: g.id.slice(0, 64),
            label: g.label.slice(0, 128),
            models: Array.isArray(g.models)
              ? g.models.filter((m) => typeof m === 'string').slice(0, 500)
              : [],
            order: typeof g.order === 'number' ? g.order : 0,
          }));
        if (validGroups.length > 0) {
          providerConfig.customGroups = validGroups;
        }
      }

      // modelAssignments: Record<modelName, groupId>
      if (config.modelAssignments && typeof config.modelAssignments === 'object') {
        const assignments = {};
        for (const [model, groupId] of Object.entries(config.modelAssignments)) {
          if (typeof model === 'string' && typeof groupId === 'string') {
            assignments[model] = groupId;
          }
        }
        if (Object.keys(assignments).length > 0) {
          providerConfig.modelAssignments = assignments;
        }
      }

      // renamedGroups: Record<groupId, label>
      if (config.renamedGroups && typeof config.renamedGroups === 'object') {
        const renamed = {};
        for (const [groupId, label] of Object.entries(config.renamedGroups)) {
          if (typeof groupId === 'string' && typeof label === 'string') {
            renamed[groupId] = label.slice(0, 128);
          }
        }
        if (Object.keys(renamed).length > 0) {
          providerConfig.renamedGroups = renamed;
        }
      }

      if (Object.keys(providerConfig).length > 0) {
        sanitized[providerId] = providerConfig;
      }
    }
    if (Object.keys(sanitized).length > 0) {
      result.usageModelGroups = sanitized;
    }
  }

  return result;
};

const mergePersistedSettings = (current, changes) => {
  const baseApproved = Array.isArray(changes.approvedDirectories)
    ? changes.approvedDirectories
    : Array.isArray(current.approvedDirectories)
      ? current.approvedDirectories
      : [];

  const additionalApproved = [];
  if (typeof changes.lastDirectory === 'string' && changes.lastDirectory.length > 0) {
    additionalApproved.push(changes.lastDirectory);
  }
  if (typeof changes.homeDirectory === 'string' && changes.homeDirectory.length > 0) {
    additionalApproved.push(changes.homeDirectory);
  }
  const projectEntries = Array.isArray(changes.projects)
    ? changes.projects
    : Array.isArray(current.projects)
      ? current.projects
      : [];
  projectEntries.forEach((project) => {
    if (project && typeof project.path === 'string' && project.path.length > 0) {
      additionalApproved.push(project.path);
    }
  });
  const approvedSource = [...baseApproved, ...additionalApproved];

  const baseBookmarks = Array.isArray(changes.securityScopedBookmarks)
    ? changes.securityScopedBookmarks
    : Array.isArray(current.securityScopedBookmarks)
      ? current.securityScopedBookmarks
      : [];

  const nextTypographySizes = changes.typographySizes
    ? {
        ...(current.typographySizes || {}),
        ...changes.typographySizes
      }
    : current.typographySizes;

  const next = {
    ...current,
    ...changes,
    approvedDirectories: Array.from(
      new Set(
        approvedSource.filter((entry) => typeof entry === 'string' && entry.length > 0)
      )
    ),
    securityScopedBookmarks: Array.from(
      new Set(
        baseBookmarks.filter((entry) => typeof entry === 'string' && entry.length > 0)
      )
    ),
    typographySizes: nextTypographySizes
  };

  return next;
};

const formatSettingsResponse = (settings) => {
  const sanitized = sanitizeSettingsUpdate(settings);
  const approved = normalizeStringArray(settings.approvedDirectories);
  const bookmarks = normalizeStringArray(settings.securityScopedBookmarks);

  return {
    ...sanitized,
    approvedDirectories: approved,
    securityScopedBookmarks: bookmarks,
    pinnedDirectories: normalizeStringArray(settings.pinnedDirectories),
    typographySizes: sanitizeTypographySizesPartial(settings.typographySizes),
    showReasoningTraces:
      typeof settings.showReasoningTraces === 'boolean'
        ? settings.showReasoningTraces
        : typeof sanitized.showReasoningTraces === 'boolean'
          ? sanitized.showReasoningTraces
          : false
  };
};

const validateProjectEntries = async (projects) => {
  console.log(`[validateProjectEntries] Starting validation for ${projects.length} projects`);

  if (!Array.isArray(projects)) {
    console.warn(`[validateProjectEntries] Input is not an array, returning empty`);
    return [];
  }

  const validations = projects.map(async (project) => {
    if (!project || typeof project.path !== 'string' || project.path.length === 0) {
      console.error(`[validateProjectEntries] Invalid project entry: missing or empty path`, project);
      return null;
    }
    try {
      const stats = await fsPromises.stat(project.path);
      if (!stats.isDirectory()) {
        console.error(`[validateProjectEntries] Project path is not a directory: ${project.path}`);
        return null;
      }
      return project;
    } catch (error) {
      const err = error;
      console.error(`[validateProjectEntries] Failed to validate project "${project.path}": ${err.code || err.message || err}`);
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        console.log(`[validateProjectEntries] Removing project with ENOENT: ${project.path}`);
        return null;
      }
      console.log(`[validateProjectEntries] Keeping project despite non-ENOENT error: ${project.path}`);
      return project;
    }
  });

  const results = (await Promise.all(validations)).filter((p) => p !== null);

  console.log(`[validateProjectEntries] Validation complete: ${results.length}/${projects.length} projects valid`);
  return results;
};

const migrateSettingsFromLegacyLastDirectory = async (current) => {
  const settings = current && typeof current === 'object' ? current : {};
  const now = Date.now();

  const sanitizedProjects = sanitizeProjects(settings.projects) || [];
  let nextProjects = sanitizedProjects;
  let nextActiveProjectId =
    typeof settings.activeProjectId === 'string' ? settings.activeProjectId : undefined;

  let changed = false;

  if (nextProjects.length === 0) {
    const legacy = typeof settings.lastDirectory === 'string' ? settings.lastDirectory.trim() : '';
    const candidate = legacy ? resolveDirectoryCandidate(legacy) : null;

    if (candidate) {
      try {
        const stats = await fsPromises.stat(candidate);
        if (stats.isDirectory()) {
          const id = crypto.randomUUID();
          nextProjects = [
            {
              id,
              path: candidate,
              addedAt: now,
              lastOpenedAt: now,
            },
          ];
          nextActiveProjectId = id;
          changed = true;
        }
      } catch {
        // ignore invalid lastDirectory
      }
    }
  }

  if (nextProjects.length > 0) {
    const active = nextProjects.find((project) => project.id === nextActiveProjectId) || null;
    if (!active) {
      nextActiveProjectId = nextProjects[0].id;
      changed = true;
    }
  } else if (nextActiveProjectId) {
    nextActiveProjectId = undefined;
    changed = true;
  }

  if (!changed) {
    return { settings, changed: false };
  }

  const merged = mergePersistedSettings(settings, {
    ...settings,
    projects: nextProjects,
    ...(nextActiveProjectId ? { activeProjectId: nextActiveProjectId } : { activeProjectId: undefined }),
  });

  return { settings: merged, changed: true };
};

const migrateSettingsFromLegacyThemePreferences = async (current) => {
  const settings = current && typeof current === 'object' ? current : {};

  const themeId = typeof settings.themeId === 'string' ? settings.themeId.trim() : '';
  const themeVariant = typeof settings.themeVariant === 'string' ? settings.themeVariant.trim() : '';

  const hasLight = typeof settings.lightThemeId === 'string' && settings.lightThemeId.trim().length > 0;
  const hasDark = typeof settings.darkThemeId === 'string' && settings.darkThemeId.trim().length > 0;

  if (hasLight && hasDark) {
    return { settings, changed: false };
  }

  const defaultLight = 'flexoki-light';
  const defaultDark = 'flexoki-dark';

  let nextLightThemeId = hasLight ? settings.lightThemeId : undefined;
  let nextDarkThemeId = hasDark ? settings.darkThemeId : undefined;

  if (!hasLight) {
    if (themeId && themeVariant === 'light') {
      nextLightThemeId = themeId;
    } else {
      nextLightThemeId = defaultLight;
    }
  }

  if (!hasDark) {
    if (themeId && themeVariant === 'dark') {
      nextDarkThemeId = themeId;
    } else {
      nextDarkThemeId = defaultDark;
    }
  }

  const merged = mergePersistedSettings(settings, {
    ...settings,
    ...(nextLightThemeId ? { lightThemeId: nextLightThemeId } : {}),
    ...(nextDarkThemeId ? { darkThemeId: nextDarkThemeId } : {}),
  });

  return { settings: merged, changed: true };
};

const migrateSettingsFromLegacyCollapsedProjects = async (current) => {
  const settings = current && typeof current === 'object' ? current : {};
  const collapsed = Array.isArray(settings.collapsedProjects)
    ? normalizeStringArray(settings.collapsedProjects)
    : [];

  if (collapsed.length === 0 || !Array.isArray(settings.projects)) {
    if (collapsed.length === 0) {
      return { settings, changed: false };
    }
    // Nothing to apply to; drop legacy key.
    const next = { ...settings };
    delete next.collapsedProjects;
    return { settings: next, changed: true };
  }

  const set = new Set(collapsed);
  const projects = sanitizeProjects(settings.projects) || [];
  let changed = false;

  const nextProjects = projects.map((project) => {
    const shouldCollapse = set.has(project.id);
    if (project.sidebarCollapsed !== shouldCollapse) {
      changed = true;
      return { ...project, sidebarCollapsed: shouldCollapse };
    }
    return project;
  });

  if (!changed) {
    // Still drop legacy key if present.
    if (Object.prototype.hasOwnProperty.call(settings, 'collapsedProjects')) {
      const next = { ...settings };
      delete next.collapsedProjects;
      return { settings: next, changed: true };
    }
    return { settings, changed: false };
  }

  const next = { ...settings, projects: nextProjects };
  delete next.collapsedProjects;
  return { settings: next, changed: true };
};

const DEFAULT_NOTIFICATION_TEMPLATES = {
  completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  error: { title: 'Tool error', message: '{last_message}' },
  question: { title: 'Input needed', message: '{last_message}' },
  subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
};

const ensureNotificationTemplateShape = (templates) => {
  const input = templates && typeof templates === 'object' ? templates : {};
  let changed = false;
  const next = {};

  for (const event of Object.keys(DEFAULT_NOTIFICATION_TEMPLATES)) {
    const currentEntry = input[event];
    const base = DEFAULT_NOTIFICATION_TEMPLATES[event];
    const currentTitle = typeof currentEntry?.title === 'string' ? currentEntry.title : base.title;
    const currentMessage = typeof currentEntry?.message === 'string' ? currentEntry.message : base.message;
    if (!currentEntry || typeof currentEntry.title !== 'string' || typeof currentEntry.message !== 'string') {
      changed = true;
    }
    next[event] = { title: currentTitle, message: currentMessage };
  }

  return { templates: next, changed };
};

const migrateSettingsNotificationDefaults = async (current) => {
  const settings = current && typeof current === 'object' ? current : {};
  let changed = false;
  const next = { ...settings };

  if (typeof settings.notifyOnSubtasks !== 'boolean') {
    next.notifyOnSubtasks = true;
    changed = true;
  }
  if (typeof settings.notifyOnCompletion !== 'boolean') {
    next.notifyOnCompletion = true;
    changed = true;
  }
  if (typeof settings.notifyOnError !== 'boolean') {
    next.notifyOnError = true;
    changed = true;
  }
  if (typeof settings.notifyOnQuestion !== 'boolean') {
    next.notifyOnQuestion = true;
    changed = true;
  }

  const { templates, changed: templatesChanged } = ensureNotificationTemplateShape(settings.notificationTemplates);
  if (templatesChanged || !settings.notificationTemplates || typeof settings.notificationTemplates !== 'object') {
    next.notificationTemplates = templates;
    changed = true;
  }

  return { settings: changed ? next : settings, changed };
};

const readSettingsFromDiskMigrated = async () => {
  const current = await readSettingsFromDisk();
  const migration1 = await migrateSettingsFromLegacyLastDirectory(current);
  const migration2 = await migrateSettingsFromLegacyThemePreferences(migration1.settings);
  const migration3 = await migrateSettingsFromLegacyCollapsedProjects(migration2.settings);
  const migration4 = await migrateSettingsNotificationDefaults(migration3.settings);
  if (migration1.changed || migration2.changed || migration3.changed || migration4.changed) {
    await writeSettingsToDisk(migration4.settings);
  }
  return migration4.settings;
};

const getOrCreateVapidKeys = async () => {
  const settings = await readSettingsFromDiskMigrated();
  const existing = settings?.vapidKeys;
  if (existing && typeof existing.publicKey === 'string' && typeof existing.privateKey === 'string') {
    return { publicKey: existing.publicKey, privateKey: existing.privateKey };
  }

  const generated = webPush.generateVAPIDKeys();
  const next = {
    ...settings,
    vapidKeys: {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    },
  };

  await writeSettingsToDisk(next);
  return { publicKey: generated.publicKey, privateKey: generated.privateKey };
};

const getUiSessionTokenFromRequest = (req) => {
  const cookieHeader = req?.headers?.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return null;
  }
  const segments = cookieHeader.split(';');
  for (const segment of segments) {
    const [rawName, ...rest] = segment.split('=');
    const name = rawName?.trim();
    if (!name) continue;
    if (name !== 'oc_ui_session') continue;
    const value = rest.join('=').trim();
    try {
      return decodeURIComponent(value || '');
    } catch {
      return value || null;
    }
  }
  return null;
};

const TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW = 128;
const TERMINAL_INPUT_WS_REBIND_WINDOW_MS = 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const rejectWebSocketUpgrade = (socket, statusCode, reason) => {
  if (!socket || socket.destroyed) {
    return;
  }

  const message = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'Bad Request';
  const body = Buffer.from(message, 'utf8');
  const statusText = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
  }[statusCode] || 'Bad Request';

  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n\r\n`
    );
    socket.write(body);
  } catch {
  }

  try {
    socket.destroy();
  } catch {
  }
};


const getRequestOriginCandidates = async (req) => {
  const origins = new Set();
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase()
    : '';
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');

  const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : '';
  const host = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');

  if (host) {
    origins.add(`${protocol}://${host}`);
    const [hostname, port] = host.split(':');
    const normalizedHost = typeof hostname === 'string' ? hostname.toLowerCase() : '';
    const portSuffix = typeof port === 'string' && port.length > 0 ? `:${port}` : '';
    if (normalizedHost === 'localhost') {
      origins.add(`${protocol}://127.0.0.1${portSuffix}`);
      origins.add(`${protocol}://[::1]${portSuffix}`);
    } else if (normalizedHost === '127.0.0.1' || normalizedHost === '[::1]') {
      origins.add(`${protocol}://localhost${portSuffix}`);
    }
  }

  try {
    const settings = await readSettingsFromDiskMigrated();
    if (typeof settings?.publicOrigin === 'string' && settings.publicOrigin.trim().length > 0) {
      origins.add(new URL(settings.publicOrigin.trim()).origin);
    }
  } catch {
  }

  return origins;
};

const isRequestOriginAllowed = async (req) => {
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!originHeader) {
    return false;
  }

  let normalizedOrigin = '';
  try {
    normalizedOrigin = new URL(originHeader).origin;
  } catch {
    return false;
  }

  const allowedOrigins = await getRequestOriginCandidates(req);
  return allowedOrigins.has(normalizedOrigin);
};

const normalizePushSubscriptions = (record) => {
  if (!Array.isArray(record)) return [];
  return record
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const endpoint = entry.endpoint;
      const p256dh = entry.p256dh;
      const auth = entry.auth;
      if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
        return null;
      }
      return {
        endpoint,
        p256dh,
        auth,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
      };
    })
    .filter(Boolean);
};

const getPushSubscriptionsForUiSession = async (uiSessionToken) => {
  if (!uiSessionToken) return [];
  const store = await readPushSubscriptionsFromDisk();
  const record = store.subscriptionsBySession?.[uiSessionToken];
  return normalizePushSubscriptions(record);
};

const addOrUpdatePushSubscription = async (uiSessionToken, subscription, userAgent) => {
  if (!uiSessionToken) {
    return;
  }

  await ensurePushInitialized();

  const now = Date.now();

  await persistPushSubscriptionUpdate((current) => {
    const subsBySession = { ...(current.subscriptionsBySession || {}) };
    const existing = Array.isArray(subsBySession[uiSessionToken]) ? subsBySession[uiSessionToken] : [];

    const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== subscription.endpoint);

    filtered.unshift({
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      createdAt: now,
      lastSeenAt: now,
      userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
    });

    subsBySession[uiSessionToken] = filtered.slice(0, 10);

    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
  });
};

const removePushSubscription = async (uiSessionToken, endpoint) => {
  if (!uiSessionToken || !endpoint) return;

  await ensurePushInitialized();

  await persistPushSubscriptionUpdate((current) => {
    const subsBySession = { ...(current.subscriptionsBySession || {}) };
    const existing = Array.isArray(subsBySession[uiSessionToken]) ? subsBySession[uiSessionToken] : [];
    const filtered = existing.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
    if (filtered.length === 0) {
      delete subsBySession[uiSessionToken];
    } else {
      subsBySession[uiSessionToken] = filtered;
    }
    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
  });
};

const removePushSubscriptionFromAllSessions = async (endpoint) => {
  if (!endpoint) return;

  await ensurePushInitialized();

  await persistPushSubscriptionUpdate((current) => {
    const subsBySession = { ...(current.subscriptionsBySession || {}) };
    for (const [token, entries] of Object.entries(subsBySession)) {
      if (!Array.isArray(entries)) continue;
      const filtered = entries.filter((entry) => entry && typeof entry.endpoint === 'string' && entry.endpoint !== endpoint);
      if (filtered.length === 0) {
        delete subsBySession[token];
      } else {
        subsBySession[token] = filtered;
      }
    }
    return { version: PUSH_SUBSCRIPTIONS_VERSION, subscriptionsBySession: subsBySession };
  });
};

const buildSessionDeepLinkUrl = (sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') {
    return '/';
  }
  return `/?session=${encodeURIComponent(sessionId)}`;
};

const sendPushToSubscription = async (sub, payload) => {
  await ensurePushInitialized();
  const body = JSON.stringify(payload);

  const pushSubscription = {
    endpoint: sub.endpoint,
    keys: {
      p256dh: sub.p256dh,
      auth: sub.auth,
    }
  };

  try {
    await webPush.sendNotification(pushSubscription, body);
  } catch (error) {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : null;
    if (statusCode === 410 || statusCode === 404) {
      await removePushSubscriptionFromAllSessions(sub.endpoint);
      return;
    }
    console.warn('[Push] Failed to send notification:', error);
  }
};

const sendPushToAllUiSessions = async (payload, options = {}) => {
  const requireNoSse = options.requireNoSse === true;
  const store = await readPushSubscriptionsFromDisk();
  const sessions = store.subscriptionsBySession || {};
  const subscriptionsByEndpoint = new Map();

  for (const [token, record] of Object.entries(sessions)) {
    const subscriptions = normalizePushSubscriptions(record);
    if (subscriptions.length === 0) continue;

    for (const sub of subscriptions) {
      if (!subscriptionsByEndpoint.has(sub.endpoint)) {
        subscriptionsByEndpoint.set(sub.endpoint, sub);
      }
    }
  }

  await Promise.all(Array.from(subscriptionsByEndpoint.entries()).map(async ([endpoint, sub]) => {
    if (requireNoSse && isAnyUiVisible()) {
      return;
    }
    await sendPushToSubscription(sub, payload);
  }));
};

let pushInitialized = false;



const uiVisibilityByToken = new Map();
let globalVisibilityState = false;

const updateUiVisibility = (token, visible) => {
  if (!token) return;
  const now = Date.now();
  const nextVisible = Boolean(visible);
  uiVisibilityByToken.set(token, { visible: nextVisible, updatedAt: now });
  globalVisibilityState = nextVisible;

};

const isAnyUiVisible = () => globalVisibilityState === true;

const isUiVisible = (token) => uiVisibilityByToken.get(token)?.visible === true;

// Session activity tracking (mirrors desktop session_activity.rs)
const sessionActivityPhases = new Map(); // sessionId -> { phase: 'idle'|'busy'|'cooldown', updatedAt: number }
const sessionActivityCooldowns = new Map(); // sessionId -> timeoutId
const SESSION_COOLDOWN_DURATION_MS = 2000;

// Complete session status tracking - source of truth for web clients
// This maintains the authoritative state, clients only cache it
const sessionStates = new Map(); // sessionId -> {
//   status: 'idle'|'busy'|'retry',
//   lastUpdateAt: number,
//   lastEventId: string,
//   metadata: { attempt?: number, message?: string, next?: number }
// }
const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const updateSessionState = (sessionId, status, eventId, metadata = {}) => {
  if (!sessionId || typeof sessionId !== 'string') return;

  const now = Date.now();
  const existing = sessionStates.get(sessionId);

  // Only update if this is a newer event (simple ordering protection)
  if (existing && existing.lastUpdateAt > now - 5000 && status === existing.status) {
    // Same status within 5 seconds, skip to reduce noise
    return;
  }

  sessionStates.set(sessionId, {
    status,
    lastUpdateAt: now,
    lastEventId: eventId || `server-${now}`,
    metadata: { ...existing?.metadata, ...metadata }
  });

  // Update attention tracking state (must be called before broadcasting)
  updateSessionAttentionStatus(sessionId, status, eventId);

  // Broadcast status change to connected web clients via SSE
  // This enables real-time updates without polling
  // Include needsAttention in the same event to ensure atomic updates
  if (uiNotificationClients.size > 0 && (!existing || existing.status !== status)) {
    const state = sessionStates.get(sessionId);
    const attentionState = sessionAttentionStates.get(sessionId);
    for (const res of uiNotificationClients) {
      try {
        writeSseEvent(res, {
          type: 'openchamber:session-status',
          properties: {
            sessionId,
            status: state.status,
            timestamp: state.lastUpdateAt,
            metadata: state.metadata,
            needsAttention: attentionState?.needsAttention ?? false
          }
        });
      } catch {
        // Client disconnected, will be cleaned up by close handler
      }
    }
  }

  // Also update activity phases for backward compatibility
  const phase = status === 'busy' || status === 'retry' ? 'busy' : 'idle';
  setSessionActivityPhase(sessionId, phase);
};

const getSessionStateSnapshot = () => {
  const result = {};
  const now = Date.now();

  for (const [sessionId, data] of sessionStates) {
    // Skip very old states (session likely gone)
    if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) continue;

    result[sessionId] = {
      status: data.status,
      lastUpdateAt: data.lastUpdateAt,
      metadata: data.metadata
    };
  }

  return result;
};

const getSessionState = (sessionId) => {
  if (!sessionId) return null;
  return sessionStates.get(sessionId) || null;
};

// Session attention tracking - authoritative source for unread/needs-attention state
// Tracks which sessions need user attention based on activity and view state
const sessionAttentionStates = new Map(); // sessionId -> {
//   needsAttention: boolean,
//   lastUserMessageAt: number | null,
//   lastStatusChangeAt: number,
//   viewedByClients: Set<clientId>,
//   status: 'idle' | 'busy' | 'retry'
// }
const SESSION_ATTENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const getOrCreateAttentionState = (sessionId) => {
  if (!sessionId || typeof sessionId !== 'string') return null;

  let state = sessionAttentionStates.get(sessionId);
  if (!state) {
    state = {
      needsAttention: false,
      lastUserMessageAt: null,
      lastStatusChangeAt: Date.now(),
      viewedByClients: new Set(),
      status: 'idle'
    };
    sessionAttentionStates.set(sessionId, state);
  }
  return state;
};

const updateSessionAttentionStatus = (sessionId, status, eventId) => {
  const state = getOrCreateAttentionState(sessionId);
  if (!state) return;

  const prevStatus = state.status;
  state.status = status;
  state.lastStatusChangeAt = Date.now();

  // Check if we need to mark as needsAttention
  // Condition: transitioning from busy/retry to idle + user sent message + not currently viewed
  // Note: The actual broadcast with needsAttention is done in updateSessionState
  // to ensure both status and attention are sent in a single event
  if ((prevStatus === 'busy' || prevStatus === 'retry') && status === 'idle') {
    if (state.lastUserMessageAt && state.viewedByClients.size === 0) {
      state.needsAttention = true;
    }
  }
};

const markSessionViewed = (sessionId, clientId) => {
  const state = getOrCreateAttentionState(sessionId);
  if (!state) return;

  const wasNeedsAttention = state.needsAttention;
  state.viewedByClients.add(clientId);

  // Clear needsAttention when viewed
  if (wasNeedsAttention) {
    state.needsAttention = false;

    // Broadcast attention cleared event
    if (uiNotificationClients.size > 0) {
      for (const res of uiNotificationClients) {
        try {
          writeSseEvent(res, {
            type: 'openchamber:session-status',
            properties: {
              sessionId,
              status: state.status,
              timestamp: Date.now(),
              metadata: {},
              needsAttention: false
            }
          });
        } catch {
          // Client disconnected
        }
      }
    }
  }
};

const markSessionUnviewed = (sessionId, clientId) => {
  const state = sessionAttentionStates.get(sessionId);
  if (!state) return;

  state.viewedByClients.delete(clientId);
};

const markUserMessageSent = (sessionId) => {
  const state = getOrCreateAttentionState(sessionId);
  if (!state) return;

  state.lastUserMessageAt = Date.now();
};

const getSessionAttentionSnapshot = () => {
  const result = {};
  const now = Date.now();

  for (const [sessionId, state] of sessionAttentionStates) {
    // Skip very old states
    if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) continue;

    result[sessionId] = {
      needsAttention: state.needsAttention,
      lastUserMessageAt: state.lastUserMessageAt,
      lastStatusChangeAt: state.lastStatusChangeAt,
      status: state.status,
      isViewed: state.viewedByClients.size > 0
    };
  }

  return result;
};

const getSessionAttentionState = (sessionId) => {
  if (!sessionId) return null;
  const state = sessionAttentionStates.get(sessionId);
  if (!state) return null;

  return {
    needsAttention: state.needsAttention,
    lastUserMessageAt: state.lastUserMessageAt,
    lastStatusChangeAt: state.lastStatusChangeAt,
    status: state.status,
    isViewed: state.viewedByClients.size > 0
  };
};

const cleanupOldSessionStates = () => {
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, data] of sessionStates) {
    if (now - data.lastUpdateAt > SESSION_STATE_MAX_AGE_MS) {
      sessionStates.delete(sessionId);
      cleaned++;
    }
  }

  // Also cleanup attention states
  for (const [sessionId, state] of sessionAttentionStates) {
    if (now - state.lastStatusChangeAt > SESSION_ATTENTION_MAX_AGE_MS) {
      sessionAttentionStates.delete(sessionId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.info(`[SessionState] Cleaned up ${cleaned} old session states`);
  }
};

// Start periodic cleanup
setInterval(cleanupOldSessionStates, SESSION_STATE_CLEANUP_INTERVAL_MS);

const setSessionActivityPhase = (sessionId, phase) => {
  if (!sessionId || typeof sessionId !== 'string') return false;

  const current = sessionActivityPhases.get(sessionId);
  if (current?.phase === phase) return false; // No change

  // Match desktop semantics: only enter cooldown from busy.
  if (phase === 'cooldown' && current?.phase !== 'busy') {
    return false;
  }

  // Cancel existing cooldown timer only on phase change.
  const existingTimer = sessionActivityCooldowns.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionActivityCooldowns.delete(sessionId);
  }

  sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

  // Schedule transition from cooldown to idle
  if (phase === 'cooldown') {
    const timer = setTimeout(() => {
      const now = sessionActivityPhases.get(sessionId);
      if (now?.phase === 'cooldown') {
        sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: Date.now() });
      }
      sessionActivityCooldowns.delete(sessionId);
    }, SESSION_COOLDOWN_DURATION_MS);
    sessionActivityCooldowns.set(sessionId, timer);
  }

  return true;
};

const getSessionActivitySnapshot = () => {
  const result = {};
  for (const [sessionId, data] of sessionActivityPhases) {
    result[sessionId] = { type: data.phase };
  }
  return result;
};

const resetAllSessionActivityToIdle = () => {
  // Cancel all cooldown timers
  for (const timer of sessionActivityCooldowns.values()) {
    clearTimeout(timer);
  }
  sessionActivityCooldowns.clear();
  
  // Reset all phases to idle
  const now = Date.now();
  for (const [sessionId] of sessionActivityPhases) {
    sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: now });
  }
};

const resolveVapidSubject = async () => {
  const configured = process.env.OPENCHAMBER_VAPID_SUBJECT;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }

  const originEnv = process.env.OPENCHAMBER_PUBLIC_ORIGIN;
  if (typeof originEnv === 'string' && originEnv.trim().length > 0) {
    const trimmed = originEnv.trim();
    // Convert http://localhost to mailto for VAPID compatibility
    if (trimmed.startsWith('http://localhost')) {
      return 'mailto:openchamber@localhost';
    }
    return trimmed;
  }

  try {
    const settings = await readSettingsFromDiskMigrated();
    const stored = settings?.publicOrigin;
    if (typeof stored === 'string' && stored.trim().length > 0) {
      const trimmed = stored.trim();
      // Convert http://localhost to mailto for VAPID compatibility
      if (trimmed.startsWith('http://localhost')) {
        return 'mailto:openchamber@localhost';
      }
      return trimmed;
    }
  } catch {
    // ignore
  }

  return 'mailto:openchamber@localhost';
};

const ensurePushInitialized = async () => {
  if (pushInitialized) return;
  const keys = await getOrCreateVapidKeys();
  const subject = await resolveVapidSubject();

  if (subject === 'mailto:openchamber@localhost') {
    console.warn('[Push] No public origin configured for VAPID; set OPENCHAMBER_VAPID_SUBJECT or enable push once from a real origin.');
  }

  webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  pushInitialized = true;
};

const persistSettings = async (changes) => {
  // Serialize concurrent calls using lock
  persistSettingsLock = persistSettingsLock.then(async () => {
    console.log(`[persistSettings] Called with changes:`, JSON.stringify(changes, null, 2));
    const current = await readSettingsFromDisk();
    console.log(`[persistSettings] Current projects count:`, Array.isArray(current.projects) ? current.projects.length : 'N/A');
    const sanitized = sanitizeSettingsUpdate(changes);
    let next = mergePersistedSettings(current, sanitized);

    if (Array.isArray(next.projects)) {
      console.log(`[persistSettings] Validating ${next.projects.length} projects...`);
      const validated = await validateProjectEntries(next.projects);
      console.log(`[persistSettings] After validation: ${validated.length} projects remain`);
      next = { ...next, projects: validated };
    }

    if (Array.isArray(next.projects) && next.projects.length > 0) {
      const activeId = typeof next.activeProjectId === 'string' ? next.activeProjectId : '';
      const active = next.projects.find((project) => project.id === activeId) || null;
      if (!active) {
        console.log(`[persistSettings] Active project ID ${activeId} not found, switching to ${next.projects[0].id}`);
        next = { ...next, activeProjectId: next.projects[0].id };
      }
    } else if (next.activeProjectId) {
      console.log(`[persistSettings] No projects found, clearing activeProjectId ${next.activeProjectId}`);
      next = { ...next, activeProjectId: undefined };
    }

    await writeSettingsToDisk(next);
    console.log(`[persistSettings] Successfully saved ${next.projects?.length || 0} projects to disk`);
    return formatSettingsResponse(next);
  });

  return persistSettingsLock;
};

// HMR-persistent state via globalThis
// These values survive Vite HMR reloads to prevent zombie OpenCode processes
const HMR_STATE_KEY = '__openchamberHmrState';
const getHmrState = () => {
  if (!globalThis[HMR_STATE_KEY]) {
    globalThis[HMR_STATE_KEY] = {
      openCodeProcess: null,
      openCodePort: null,
        openCodeWorkingDirectory: os.homedir(),
        isShuttingDown: false,
        signalsAttached: false,
        userProvidedOpenCodePassword: undefined,
        openCodeAuthPassword: null,
        openCodeAuthSource: null,
      };
  }
  return globalThis[HMR_STATE_KEY];
};
const hmrState = getHmrState();

const normalizeOpenCodePassword = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

if (typeof hmrState.userProvidedOpenCodePassword === 'undefined') {
  const initialPassword = normalizeOpenCodePassword(process.env.OPENCODE_SERVER_PASSWORD);
  hmrState.userProvidedOpenCodePassword = initialPassword || null;
}

// Non-HMR state (safe to reset on reload)
let healthCheckInterval = null;
let server = null;
let cachedModelsMetadata = null;
let cachedModelsMetadataTimestamp = 0;
let expressApp = null;
let currentRestartPromise = null;
let isRestartingOpenCode = false;
let openCodeApiPrefix = '';
let openCodeApiPrefixDetected = true;
let openCodeApiDetectionTimer = null;
let lastOpenCodeError = null;
let isOpenCodeReady = false;
let openCodeNotReadySince = 0;
let isExternalOpenCode = false;
let exitOnShutdown = true;
let uiAuthController = null;
let cloudflareTunnelController = null;
let terminalInputWsServer = null;
const userProvidedOpenCodePassword =
  typeof hmrState.userProvidedOpenCodePassword === 'string' && hmrState.userProvidedOpenCodePassword.length > 0
    ? hmrState.userProvidedOpenCodePassword
    : null;
let openCodeAuthPassword =
  typeof hmrState.openCodeAuthPassword === 'string' && hmrState.openCodeAuthPassword.length > 0
    ? hmrState.openCodeAuthPassword
    : userProvidedOpenCodePassword;
let openCodeAuthSource =
  typeof hmrState.openCodeAuthSource === 'string' && hmrState.openCodeAuthSource.length > 0
    ? hmrState.openCodeAuthSource
    : (userProvidedOpenCodePassword ? 'user-env' : null);

// Sync helper - call after modifying any HMR state variable
const syncToHmrState = () => {
  hmrState.openCodeProcess = openCodeProcess;
  hmrState.openCodePort = openCodePort;
  hmrState.isShuttingDown = isShuttingDown;
  hmrState.signalsAttached = signalsAttached;
  hmrState.openCodeWorkingDirectory = openCodeWorkingDirectory;
  hmrState.openCodeAuthPassword = openCodeAuthPassword;
  hmrState.openCodeAuthSource = openCodeAuthSource;
};

// Sync helper - call to restore state from HMR (e.g., on module reload)
const syncFromHmrState = () => {
  openCodeProcess = hmrState.openCodeProcess;
  openCodePort = hmrState.openCodePort;
  isShuttingDown = hmrState.isShuttingDown;
  signalsAttached = hmrState.signalsAttached;
  openCodeWorkingDirectory = hmrState.openCodeWorkingDirectory;
  openCodeAuthPassword =
    typeof hmrState.openCodeAuthPassword === 'string' && hmrState.openCodeAuthPassword.length > 0
      ? hmrState.openCodeAuthPassword
      : userProvidedOpenCodePassword;
  openCodeAuthSource =
    typeof hmrState.openCodeAuthSource === 'string' && hmrState.openCodeAuthSource.length > 0
      ? hmrState.openCodeAuthSource
      : (userProvidedOpenCodePassword ? 'user-env' : null);
};

// Module-level variables that shadow HMR state
// These are synced to/from hmrState to survive HMR reloads
let openCodeProcess = hmrState.openCodeProcess;
let openCodePort = hmrState.openCodePort;
let isShuttingDown = hmrState.isShuttingDown;
let signalsAttached = hmrState.signalsAttached;
let openCodeWorkingDirectory = hmrState.openCodeWorkingDirectory;

/**
 * Check if an existing OpenCode process is still alive and responding
 * Used to reuse process across HMR reloads
 */
async function isOpenCodeProcessHealthy() {
  if (!openCodeProcess || !openCodePort) {
    return false;
  }

  // Health check via HTTP since SDK object doesn't expose exitCode
  try {
    const response = await fetch(`http://127.0.0.1:${openCodePort}/session`, {
      method: 'GET',
      headers: getOpenCodeAuthHeaders(),
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Probe if an external OpenCode instance is already running on the given port.
 * Unlike isOpenCodeProcessHealthy(), this doesn't require openCodeProcess to be set.
 * Used to auto-detect and connect to an existing OpenCode instance on startup.
 */
async function probeExternalOpenCode(port) {
  if (!port || port <= 0) {
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.healthy === true;
  } catch {
    return false;
  }
}

const ENV_CONFIGURED_OPENCODE_PORT = (() => {
  const raw =
    process.env.OPENCODE_PORT ||
    process.env.OPENCHAMBER_OPENCODE_PORT ||
    process.env.OPENCHAMBER_INTERNAL_PORT;
  if (!raw) {
    return null;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
})();

const ENV_SKIP_OPENCODE_START = process.env.OPENCODE_SKIP_START === 'true' ||
                                    process.env.OPENCHAMBER_SKIP_OPENCODE_START === 'true';
const ENV_DESKTOP_NOTIFY = process.env.OPENCHAMBER_DESKTOP_NOTIFY === 'true';

// OpenCode server authentication (Basic Auth with username "opencode")

/**
 * Returns auth headers for OpenCode server requests if OPENCODE_SERVER_PASSWORD is set.
 * Uses Basic Auth with username "opencode" and the password from the env variable.
 */
function getOpenCodeAuthHeaders() {
  const password = normalizeOpenCodePassword(openCodeAuthPassword || process.env.OPENCODE_SERVER_PASSWORD || '');
  
  if (!password) {
    return {};
  }
  
  const credentials = Buffer.from(`opencode:${password}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

function isOpenCodeConnectionSecure() {
  return Object.prototype.hasOwnProperty.call(getOpenCodeAuthHeaders(), 'Authorization');
}

function generateSecureOpenCodePassword() {
  return crypto
    .randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function isValidOpenCodePassword(password) {
  return typeof password === 'string' && password.trim().length > 0;
}

function setOpenCodeAuthState(password, source) {
  const normalized = normalizeOpenCodePassword(password);
  if (!isValidOpenCodePassword(normalized)) {
    openCodeAuthPassword = null;
    openCodeAuthSource = null;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    syncToHmrState();
    return null;
  }

  openCodeAuthPassword = normalized;
  openCodeAuthSource = source;
  process.env.OPENCODE_SERVER_PASSWORD = normalized;
  syncToHmrState();
  return normalized;
}

async function ensureLocalOpenCodeServerPassword({ rotateManaged = false } = {}) {
  if (isValidOpenCodePassword(userProvidedOpenCodePassword)) {
    return setOpenCodeAuthState(userProvidedOpenCodePassword, 'user-env');
  }

  if (rotateManaged) {
    const rotatedPassword = setOpenCodeAuthState(generateSecureOpenCodePassword(), 'rotated');
    console.log('Rotated secure password for managed local OpenCode instance');
    return rotatedPassword;
  }

  if (isValidOpenCodePassword(openCodeAuthPassword)) {
    return setOpenCodeAuthState(openCodeAuthPassword, openCodeAuthSource || 'generated');
  }

  const generatedPassword = setOpenCodeAuthState(generateSecureOpenCodePassword(), 'generated');
  console.log('Generated secure password for managed local OpenCode instance');
  return generatedPassword;
}

let cachedLoginShellEnvSnapshot = undefined;

function parseNullSeparatedEnvSnapshot(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  const result = {};
  const entries = raw.split('\0');
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    const idx = entry.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = entry.slice(0, idx);
    const value = entry.slice(idx + 1);
    result[key] = value;
  }

  return Object.keys(result).length > 0 ? result : null;
}

function getLoginShellEnvSnapshot() {
  if (cachedLoginShellEnvSnapshot !== undefined) {
    return cachedLoginShellEnvSnapshot;
  }

  if (process.platform === 'win32') {
    const windowsSnapshot = getWindowsShellEnvSnapshot();
    cachedLoginShellEnvSnapshot = windowsSnapshot;
    return windowsSnapshot;
  }

  const shellCandidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);

  for (const shellPath of shellCandidates) {
    if (!isExecutable(shellPath)) {
      continue;
    }

    try {
      const result = spawnSync(shellPath, ['-lic', 'env -0'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });

      if (result.status !== 0) {
        continue;
      }

      const parsed = parseNullSeparatedEnvSnapshot(result.stdout || '');
      if (parsed) {
        cachedLoginShellEnvSnapshot = parsed;
        return parsed;
      }
    } catch {
      // ignore
    }
  }

  cachedLoginShellEnvSnapshot = null;
  return null;
}

function getWindowsShellEnvSnapshot() {
  const parseResult = (stdout) => parseNullSeparatedEnvSnapshot(typeof stdout === 'string' ? stdout : '');

  const psScript =
    "Get-ChildItem Env: | ForEach-Object { [Console]::Out.Write($_.Name); [Console]::Out.Write('='); [Console]::Out.Write($_.Value); [Console]::Out.Write([char]0) }";

  const powershellCandidates = [
    'pwsh.exe',
    'powershell.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];

  for (const shellPath of powershellCandidates) {
    try {
      const result = spawnSync(shellPath, ['-NoLogo', '-Command', psScript], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
      if (result.status !== 0) {
        continue;
      }
      const parsed = parseResult(result.stdout);
      if (parsed) {
        return parsed;
      }
    } catch {
      // ignore
    }
  }

  const comspec = process.env.ComSpec || 'cmd.exe';
  try {
    const result = spawnSync(comspec, ['/d', '/s', '/c', 'set'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.length > 0) {
      return parseNullSeparatedEnvSnapshot(result.stdout.replace(/\r?\n/g, '\0'));
    }
  } catch {
    // ignore
  }

  return null;
}

function mergePathValues(preferred, fallback) {
  const merged = new Set();

  const addSegments = (value) => {
    if (typeof value !== 'string' || !value) {
      return;
    }
    for (const segment of value.split(path.delimiter)) {
      if (segment) {
        merged.add(segment);
      }
    }
  };

  addSegments(preferred);
  addSegments(fallback);

  return Array.from(merged).join(path.delimiter);
}

function applyLoginShellEnvSnapshot() {
  const snapshot = getLoginShellEnvSnapshot();
  if (!snapshot) {
    return;
  }

  const skipKeys = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);

  for (const [key, value] of Object.entries(snapshot)) {
    if (skipKeys.has(key)) {
      continue;
    }
    const existing = process.env[key];
    if (typeof existing === 'string' && existing.length > 0) {
      continue;
    }
    process.env[key] = value;
  }

  process.env.PATH = mergePathValues(snapshot.PATH || '', process.env.PATH || '');
}

applyLoginShellEnvSnapshot();

const ENV_CONFIGURED_API_PREFIX = normalizeApiPrefix(
  process.env.OPENCODE_API_PREFIX || process.env.OPENCHAMBER_API_PREFIX || ''
);

  if (ENV_CONFIGURED_API_PREFIX && ENV_CONFIGURED_API_PREFIX !== '') {
  console.warn('Ignoring configured OpenCode API prefix; API runs at root.');
}

let globalEventWatcherAbortController = null;

let resolvedOpencodeBinary = null;
let resolvedOpencodeBinarySource = null;
let resolvedNodeBinary = null;
let resolvedBunBinary = null;

function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      if (!ext) return true;
      return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function prependToPath(dir) {
  const trimmed = typeof dir === 'string' ? dir.trim() : '';
  if (!trimmed) return;
  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(trimmed)) return;
  process.env.PATH = [trimmed, ...parts].join(path.delimiter);
}

function searchPathFor(binaryName) {
  const current = process.env.PATH || '';
  const parts = current.split(path.delimiter).filter(Boolean);
  for (const dir of parts) {
    const candidate = path.join(dir, binaryName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveOpencodeCliPath() {
  const explicit = [
    process.env.OPENCODE_BINARY,
    process.env.OPENCODE_PATH,
    process.env.OPENCHAMBER_OPENCODE_PATH,
    process.env.OPENCHAMBER_OPENCODE_BIN,
  ]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      resolvedOpencodeBinarySource = 'env';
      return candidate;
    }
  }

  const resolvedFromPath = searchPathFor('opencode');
  if (resolvedFromPath) {
    resolvedOpencodeBinarySource = 'path';
    return resolvedFromPath;
  }

  const home = os.homedir();
  const unixFallbacks = [
    path.join(home, '.opencode', 'bin', 'opencode'),
    path.join(home, '.bun', 'bin', 'opencode'),
    path.join(home, '.local', 'bin', 'opencode'),
    path.join(home, 'bin', 'opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
    '/bin/opencode',
  ];

  const winFallbacks = (() => {
    const userProfile = process.env.USERPROFILE || home;
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    const programData = process.env.ProgramData || 'C:\\ProgramData';

    return [
      path.join(userProfile, '.opencode', 'bin', 'opencode.exe'),
      path.join(userProfile, '.opencode', 'bin', 'opencode.cmd'),
      path.join(appData, 'npm', 'opencode.cmd'),
      path.join(userProfile, 'scoop', 'shims', 'opencode.cmd'),
      path.join(programData, 'chocolatey', 'bin', 'opencode.exe'),
      path.join(programData, 'chocolatey', 'bin', 'opencode.cmd'),
      path.join(userProfile, '.bun', 'bin', 'opencode.exe'),
      path.join(userProfile, '.bun', 'bin', 'opencode.cmd'),
      localAppData ? path.join(localAppData, 'Programs', 'opencode', 'opencode.exe') : '',
    ].filter(Boolean);
  })();

  const fallbacks = process.platform === 'win32' ? winFallbacks : unixFallbacks;
  for (const candidate of fallbacks) {
    if (isExecutable(candidate)) {
      resolvedOpencodeBinarySource = 'fallback';
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where', ['opencode'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0) {
        const lines = (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const found = lines.find((line) => isExecutable(line));
        if (found) {
          resolvedOpencodeBinarySource = 'where';
          return found;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
  for (const shell of shells) {
    if (!isExecutable(shell)) continue;
    try {
      const result = spawnSync(shell, ['-lic', 'command -v opencode'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0) {
        const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
        if (found && isExecutable(found)) {
          resolvedOpencodeBinarySource = 'shell';
          return found;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function resolveNodeCliPath() {
  const explicit = [process.env.NODE_BINARY, process.env.OPENCHAMBER_NODE_BINARY]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const resolvedFromPath = searchPathFor('node');
  if (resolvedFromPath) {
    return resolvedFromPath;
  }

  const unixFallbacks = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    '/bin/node',
  ];
  for (const candidate of unixFallbacks) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    try {
      const result = spawnSync('where', ['node'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0) {
        const lines = (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const found = lines.find((line) => isExecutable(line));
        if (found) return found;
      }
    } catch {
      // ignore
    }
    return null;
  }

  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
  for (const shell of shells) {
    if (!isExecutable(shell)) continue;
    try {
      const result = spawnSync(shell, ['-lic', 'command -v node'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0) {
        const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
        if (found && isExecutable(found)) {
          return found;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function resolveBunCliPath() {
  const explicit = [process.env.BUN_BINARY, process.env.OPENCHAMBER_BUN_BINARY]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);

  for (const candidate of explicit) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  const resolvedFromPath = searchPathFor('bun');
  if (resolvedFromPath) {
    return resolvedFromPath;
  }

  const home = os.homedir();
  const unixFallbacks = [
    path.join(home, '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    '/bin/bun',
  ];
  for (const candidate of unixFallbacks) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || home;
    const winFallbacks = [
      path.join(userProfile, '.bun', 'bin', 'bun.exe'),
      path.join(userProfile, '.bun', 'bin', 'bun.cmd'),
    ];
    for (const candidate of winFallbacks) {
      if (isExecutable(candidate)) return candidate;
    }

    try {
      const result = spawnSync('where', ['bun'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0) {
        const lines = (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const found = lines.find((line) => isExecutable(line));
        if (found) return found;
      }
    } catch {
      // ignore
    }
    return null;
  }

  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
  for (const shell of shells) {
    if (!isExecutable(shell)) continue;
    try {
      const result = spawnSync(shell, ['-lic', 'command -v bun'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0) {
        const found = (result.stdout || '').trim().split(/\s+/).pop() || '';
        if (found && isExecutable(found)) {
          return found;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function ensureBunCliEnv() {
  if (resolvedBunBinary) {
    return resolvedBunBinary;
  }

  const resolved = resolveBunCliPath();
  if (resolved) {
    prependToPath(path.dirname(resolved));
    resolvedBunBinary = resolved;
    return resolved;
  }

  return null;
}

function ensureNodeCliEnv() {
  if (resolvedNodeBinary) {
    return resolvedNodeBinary;
  }

  const resolved = resolveNodeCliPath();
  if (resolved) {
    prependToPath(path.dirname(resolved));
    resolvedNodeBinary = resolved;
    return resolved;
  }

  return null;
}

function readShebang(opencodePath) {
  if (!opencodePath || typeof opencodePath !== 'string') {
    return null;
  }
  try {
    // Best effort: detect "#!/usr/bin/env <runtime>" without reading whole file.
    const fd = fs.openSync(opencodePath, 'r');
    try {
      const buf = Buffer.alloc(256);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytes).toString('utf8');
      const firstLine = head.split(/\r?\n/, 1)[0] || '';
      if (!firstLine.startsWith('#!')) {
        return null;
      }
      const shebang = firstLine.slice(2).trim();
      if (!shebang) {
        return null;
      }
      return shebang;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  } catch {
    return null;
  }
}

function opencodeShimInterpreter(opencodePath) {
  const shebang = readShebang(opencodePath);
  if (!shebang) return null;
  if (/\bnode\b/i.test(shebang)) return 'node';
  if (/\bbun\b/i.test(shebang)) return 'bun';
  return null;
}

function ensureOpencodeShimRuntime(opencodePath) {
  const runtime = opencodeShimInterpreter(opencodePath);
  if (runtime === 'node') {
    ensureNodeCliEnv();
  }
  if (runtime === 'bun') {
    ensureBunCliEnv();
  }
}

function normalizeOpencodeBinarySetting(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = normalizeDirectoryPath(raw).trim();
  if (!trimmed) {
    return '';
  }

  try {
    const stat = fs.statSync(trimmed);
    if (stat.isDirectory()) {
      const bin = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
      return path.join(trimmed, bin);
    }
  } catch {
    // ignore
  }

  return trimmed;
}

async function applyOpencodeBinaryFromSettings() {
  try {
    const settings = await readSettingsFromDiskMigrated();
    if (!settings || typeof settings !== 'object') {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(settings, 'opencodeBinary')) {
      return null;
    }

    const normalized = normalizeOpencodeBinarySetting(settings.opencodeBinary);

    if (normalized === '') {
      delete process.env.OPENCODE_BINARY;
      resolvedOpencodeBinary = null;
      resolvedOpencodeBinarySource = null;
      return null;
    }

    if (normalized && isExecutable(normalized)) {
      process.env.OPENCODE_BINARY = normalized;
      prependToPath(path.dirname(normalized));
      resolvedOpencodeBinary = normalized;
      resolvedOpencodeBinarySource = 'settings';
      ensureOpencodeShimRuntime(normalized);
      return normalized;
    }

    const raw = typeof settings.opencodeBinary === 'string' ? settings.opencodeBinary.trim() : '';
    if (raw) {
      console.warn(`Configured settings.opencodeBinary is not executable: ${raw}`);
    }
  } catch {
    // ignore
  }

  return null;
}

function ensureOpencodeCliEnv() {
  if (resolvedOpencodeBinary) {
    ensureOpencodeShimRuntime(resolvedOpencodeBinary);
    return resolvedOpencodeBinary;
  }

  const existing = typeof process.env.OPENCODE_BINARY === 'string' ? process.env.OPENCODE_BINARY.trim() : '';
  if (existing && isExecutable(existing)) {
    resolvedOpencodeBinary = existing;
    resolvedOpencodeBinarySource = resolvedOpencodeBinarySource || 'env';
    prependToPath(path.dirname(existing));
    ensureOpencodeShimRuntime(existing);
    return resolvedOpencodeBinary;
  }

  const resolved = resolveOpencodeCliPath();
  if (resolved) {
    process.env.OPENCODE_BINARY = resolved;
    prependToPath(path.dirname(resolved));
    ensureOpencodeShimRuntime(resolved);
    resolvedOpencodeBinary = resolved;
    resolvedOpencodeBinarySource = resolvedOpencodeBinarySource || 'unknown';
    console.log(`Resolved opencode CLI: ${resolved}`);
    return resolved;
  }

  return null;
}

const startGlobalEventWatcher = async () => {
  if (globalEventWatcherAbortController) {
    return;
  }

  await waitForOpenCodePort();

  globalEventWatcherAbortController = new AbortController();
  const signal = globalEventWatcherAbortController.signal;

  let attempt = 0;

  const run = async () => {
    while (!signal.aborted) {
      attempt += 1;
      let upstream;
      let reader;
      try {
        const url = buildOpenCodeUrl('/global/event', '');
        upstream = await fetch(url, {
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...getOpenCodeAuthHeaders(),
          },
          signal,
        });

        if (!upstream.ok || !upstream.body) {
          throw new Error(`bad status ${upstream.status}`);
        }

        console.log('[PushWatcher] connected');

        const decoder = new TextDecoder();
        reader = upstream.body.getReader();
        let buffer = '';

        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

          let separatorIndex = buffer.indexOf('\n\n');
          while (separatorIndex !== -1) {
            const block = buffer.slice(0, separatorIndex);
            buffer = buffer.slice(separatorIndex + 2);
            separatorIndex = buffer.indexOf('\n\n');
            const payload = parseSseDataPayload(block);
            // Cache session titles from session.updated/session.created events
            maybeCacheSessionInfoFromEvent(payload);
            void maybeSendPushForTrigger(payload);
            // Track session activity independently of UI (mirrors Tauri desktop behavior)
            const transitions = deriveSessionActivityTransitions(payload);
            if (transitions && transitions.length > 0) {
              for (const activity of transitions) {
                setSessionActivityPhase(activity.sessionId, activity.phase);
              }
            }

            // Update authoritative session state from OpenCode events
            if (payload && payload.type === 'session.status') {
              const update = extractSessionStatusUpdate(payload);
              if (update) {
                updateSessionState(update.sessionId, update.type, update.eventId || `sse-${Date.now()}`, {
                  attempt: update.attempt,
                  message: update.message,
                  next: update.next,
                });
              }
            }
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[PushWatcher] disconnected', error?.message ?? error);
      } finally {
        try {
          if (reader) {
            await reader.cancel();
            reader.releaseLock();
          } else if (upstream?.body && !upstream.body.locked) {
            await upstream.body.cancel();
          }
        } catch {
          // ignore
        }
      }

      const backoffMs = Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), 30000);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  };

  void run();
};

const stopGlobalEventWatcher = () => {
  if (!globalEventWatcherAbortController) {
    return;
  }
  try {
    globalEventWatcherAbortController.abort();
  } catch {
    // ignore
  }
  globalEventWatcherAbortController = null;
};


function setOpenCodePort(port) {
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }

  const numericPort = Math.trunc(port);
  const portChanged = openCodePort !== numericPort;

  if (portChanged || openCodePort === null) {
    openCodePort = numericPort;
    syncToHmrState();
    console.log(`Detected OpenCode port: ${openCodePort}`);

    if (portChanged) {
      isOpenCodeReady = false;
    }
    openCodeNotReadySince = Date.now();
  }

  lastOpenCodeError = null;
}

async function waitForOpenCodePort(timeoutMs = 15000) {
  if (openCodePort !== null) {
    return openCodePort;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (openCodePort !== null) {
      return openCodePort;
    }
  }

  throw new Error('Timed out waiting for OpenCode port');
}

function getLoginShellPath() {
  const snapshot = getLoginShellEnvSnapshot();
  if (!snapshot || typeof snapshot.PATH !== 'string' || snapshot.PATH.length === 0) {
    return null;
  }
  return snapshot.PATH;
}

function buildAugmentedPath() {
  const augmented = new Set();

  const loginShellPath = getLoginShellPath();
  if (loginShellPath) {
    for (const segment of loginShellPath.split(path.delimiter)) {
      if (segment) {
        augmented.add(segment);
      }
    }
  }

  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const segment of current) {
    augmented.add(segment);
  }

  return Array.from(augmented).join(path.delimiter);
}

const API_PREFIX_CANDIDATES = [''];

async function waitForReady(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${url.replace(/\/+$/, '')}/global/health`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.healthy === true) {
          return true;
        }
      }
    } catch {
      // ignore
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function normalizeApiPrefix(prefix) {
  if (!prefix) {
    return '';
  }

  if (prefix.includes('://')) {
    try {
      const parsed = new URL(prefix);
      return normalizeApiPrefix(parsed.pathname);
    } catch (error) {
      return '';
    }
  }

  const trimmed = prefix.trim();
  if (!trimmed || trimmed === '/') {
    return '';
  }
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
}

function setDetectedOpenCodeApiPrefix() {
  openCodeApiPrefix = '';
  openCodeApiPrefixDetected = true;
  if (openCodeApiDetectionTimer) {
    clearTimeout(openCodeApiDetectionTimer);
    openCodeApiDetectionTimer = null;
  }
}

function getCandidateApiPrefixes() {
  return API_PREFIX_CANDIDATES;
}

function buildOpenCodeUrl(path, prefixOverride) {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const prefix = normalizeApiPrefix(prefixOverride !== undefined ? prefixOverride : '');
  const fullPath = `${prefix}${normalizedPath}`;
  return `http://localhost:${openCodePort}${fullPath}`;
}

function parseSseDataPayload(block) {
  if (!block || typeof block !== 'string') {
    return null;
  }
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^\s/, ''));

  if (dataLines.length === 0) {
    return null;
  }

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.payload === 'object' &&
      parsed.payload !== null
    ) {
      return parsed.payload;
    }
    return parsed;
  } catch {
    return null;
  }
}

function extractSessionStatusUpdate(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'session.status') {
    return null;
  }

  const props = payload.properties ?? {};
  const status =
    props.status ??
    props.session?.status ??
    props.sessionInfo?.status;
  const metadata =
    props.metadata ??
    (typeof status === 'object' && status !== null ? status.metadata : null);

  const sessionId = props.sessionID ?? props.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return null;
  }

  const statusType =
    typeof status === 'string'
      ? status
      : typeof status?.type === 'string'
        ? status.type
        : typeof status?.status === 'string'
          ? status.status
          : typeof props.type === 'string'
            ? props.type
            : typeof props.phase === 'string'
              ? props.phase
              : typeof props.state === 'string'
                ? props.state
                : null;

  const normalizedType =
    statusType === 'idle' || statusType === 'busy' || statusType === 'retry'
      ? statusType
      : null;

  if (!normalizedType) {
    return null;
  }

  const attempt =
    typeof status?.attempt === 'number'
      ? status.attempt
      : typeof props.attempt === 'number'
        ? props.attempt
        : typeof metadata?.attempt === 'number'
          ? metadata.attempt
          : undefined;
  const message =
    typeof status?.message === 'string'
      ? status.message
      : typeof props.message === 'string'
        ? props.message
        : typeof metadata?.message === 'string'
          ? metadata.message
          : undefined;
  const next =
    typeof status?.next === 'number'
      ? status.next
      : typeof props.next === 'number'
        ? props.next
        : typeof metadata?.next === 'number'
          ? metadata.next
          : undefined;

  return {
    sessionId,
    type: normalizedType,
    attempt,
    message,
    next,
    eventId: typeof props.eventId === 'string' ? props.eventId : null,
  };
}

function emitDesktopNotification(payload) {
  if (!ENV_DESKTOP_NOTIFY) {
    return;
  }

  if (!payload || typeof payload !== 'object') {
    return;
  }

  try {
    // One-line protocol consumed by the Tauri shell.
    process.stdout.write(`${DESKTOP_NOTIFY_PREFIX}${JSON.stringify(payload)}\n`);
  } catch {
    // ignore
  }
}

function broadcastUiNotification(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  if (uiNotificationClients.size === 0) {
    return;
  }

  for (const res of uiNotificationClients) {
    try {
      writeSseEvent(res, {
        type: 'openchamber:notification',
        properties: {
          ...payload,
          // Tell the UI whether the sidecar stdout notification channel is active.
          // When true, the desktop UI should skip this SSE notification to avoid duplicates.
          // When false (e.g. tauri dev), the UI must handle this SSE notification itself.
          desktopStdoutActive: ENV_DESKTOP_NOTIFY,
        },
      });
    } catch {
      // ignore
    }
  }
}

function isStreamingAssistantPart(properties) {
  if (!properties || typeof properties !== 'object') {
    return false;
  }

  const info = properties?.info;
  const role = info?.role;
  if (role !== 'assistant') {
    return false;
  }

  const part = properties?.part;
  const partType = part?.type;
  return (
    partType === 'step-start' ||
    partType === 'text' ||
    partType === 'tool' ||
    partType === 'reasoning' ||
    partType === 'file' ||
    partType === 'patch'
  );
}

function deriveSessionActivityTransitions(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  if (payload.type === 'session.status') {
    const update = extractSessionStatusUpdate(payload);
    if (update) {
      const phase = update.type === 'busy' || update.type === 'retry' ? 'busy' : 'idle';
      return [{ sessionId: update.sessionId, phase }];
    }
  }

  if (payload.type === 'message.updated') {
    const info = payload.properties?.info;
    const sessionId = info?.sessionID ?? info?.sessionId ?? payload.properties?.sessionID ?? payload.properties?.sessionId;
    const role = info?.role;
    const finish = info?.finish;
    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant' && finish === 'stop') {
      return [{ sessionId, phase: 'cooldown' }];
    }
  }

  if (payload.type === 'message.part.updated' || payload.type === 'message.part.delta') {
    const info = payload.properties?.info;
    const sessionId = info?.sessionID ?? info?.sessionId ?? payload.properties?.sessionID ?? payload.properties?.sessionId;
    const role = info?.role;
    const finish = info?.finish;

    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant') {
      const transitions = [];

      // Desktop parity: mark busy when we see assistant parts streaming.
      if (isStreamingAssistantPart(payload.properties)) {
        transitions.push({ sessionId, phase: 'busy' });
      }

      // Desktop parity: enter cooldown when finish==stop.
      if (finish === 'stop') {
        transitions.push({ sessionId, phase: 'cooldown' });
      }

      return transitions;
    }
  }

  if (payload.type === 'session.idle') {
    const sessionId = payload.properties?.sessionID ?? payload.properties?.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return [{ sessionId, phase: 'idle' }];
    }
  }

  return [];
}

const PUSH_READY_COOLDOWN_MS = 5000;
const PUSH_QUESTION_DEBOUNCE_MS = 500;
const PUSH_PERMISSION_DEBOUNCE_MS = 500;
const pushQuestionDebounceTimers = new Map();
const pushPermissionDebounceTimers = new Map();
const notifiedPermissionRequests = new Set();
const lastReadyNotificationAt = new Map();

// Cache: sessionId -> parentID (string) or null (no parent). Undefined = unknown.
const sessionParentIdCache = new Map();
const SESSION_PARENT_CACHE_TTL_MS = 60 * 1000;

const getCachedSessionParentId = (sessionId) => {
  const entry = sessionParentIdCache.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > SESSION_PARENT_CACHE_TTL_MS) {
    sessionParentIdCache.delete(sessionId);
    return undefined;
  }
  return entry.parentID;
};

const setCachedSessionParentId = (sessionId, parentID) => {
  sessionParentIdCache.set(sessionId, { parentID: parentID ?? null, at: Date.now() });
};

const fetchSessionParentId = async (sessionId) => {
  if (!sessionId) return undefined;

  const cached = getCachedSessionParentId(sessionId);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(buildOpenCodeUrl('/session', ''), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
       },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      return undefined;
    }
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data)) {
      return undefined;
    }

    const match = data.find((s) => s && typeof s === 'object' && s.id === sessionId);
    const parentID = match && typeof match.parentID === 'string' && match.parentID.length > 0 ? match.parentID : null;
    setCachedSessionParentId(sessionId, parentID);
    return parentID;
  } catch {
    return undefined;
  }
};

const extractSessionIdFromPayload = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const props = payload.properties;
  const info = props?.info;
  const sessionId =
    info?.sessionID ??
    info?.sessionId ??
    props?.sessionID ??
    props?.sessionId ??
    props?.session ??
    null;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
};

const maybeSendPushForTrigger = async (payload) => {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const sessionId = extractSessionIdFromPayload(payload);

  const formatMode = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    const normalized = value.length > 0 ? value : 'agent';
    return normalized
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  };

  const formatModelId = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      return 'Assistant';
    }

    const tokens = value.split(/[-_]+/).filter(Boolean);
    const result = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const current = tokens[i];
      const next = tokens[i + 1];
      if (/^\d+$/.test(current) && next && /^\d+$/.test(next)) {
        result.push(`${current}.${next}`);
        i += 1;
        continue;
      }
      result.push(current);
    }

    return result
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };

  if (payload.type === 'message.updated') {
    const info = payload.properties?.info;
    if (info?.role === 'assistant' && info?.finish === 'stop' && sessionId) {
      // Check if this is a subtask and if we should notify for subtasks
      const settings = await readSettingsFromDisk();

      if (settings.notifyOnSubtasks === false) {
        // Prefer parentID on payload (if present), else fetch from sessions list.
        const sessionInfo = payload.properties?.session;
        const parentIDFromPayload = sessionInfo?.parentID ?? payload.properties?.parentID;
        const parentID = parentIDFromPayload
          ? parentIDFromPayload
          : await fetchSessionParentId(sessionId);

        // Fail open: if parentID cannot be resolved, send notification.
        if (parentID) {
          return;
        }
      }

      // Check if completion notifications are enabled
      if (settings.notifyOnCompletion === false) {
        return;
      }

      const now = Date.now();
      const lastAt = lastReadyNotificationAt.get(sessionId) ?? 0;
      if (now - lastAt < PUSH_READY_COOLDOWN_MS) {
        return;
      }
      lastReadyNotificationAt.set(sessionId, now);

      // Resolve templates with fallback to legacy hardcoded values
      let title = `${formatMode(info?.mode)} agent is ready`;
      let body = `${formatModelId(info?.modelID)} completed the task`;

      try {
        const templates = settings.notificationTemplates || {};
        const isSubtask = await fetchSessionParentId(sessionId);
        const completionTemplate = isSubtask && settings.notifyOnSubtasks !== false
          ? (templates.subtask || templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' })
          : (templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' });

        const variables = await buildTemplateVariables(payload, sessionId);

        // Try fast-path (inline parts) first, then fetch from API
        const messageId = info?.id;
        let lastMessage = extractLastMessageText(payload);
        if (!lastMessage) {
          lastMessage = await fetchLastAssistantMessageText(sessionId, messageId);
        }

        const notifZenModel = await resolveZenModel(settings?.zenModel);
        variables.last_message = await prepareNotificationLastMessage({
          message: lastMessage,
          settings,
          summarize: (text, len) => summarizeText(text, len, notifZenModel),
        });

        const resolvedTitle = resolveNotificationTemplate(completionTemplate.title, variables);
        const resolvedBody = resolveNotificationTemplate(completionTemplate.message, variables);
        if (resolvedTitle) title = resolvedTitle;
        if (shouldApplyResolvedTemplateMessage(completionTemplate.message, resolvedBody, variables)) body = resolvedBody;
      } catch (err) {
        console.warn('[Notification] Template resolution failed, using defaults:', err?.message || err);
      }

      if (settings.nativeNotificationsEnabled) {
        const notificationPayload = {
          title,
          body,
          tag: `ready-${sessionId}`,
          kind: 'ready',
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        };
        emitDesktopNotification(notificationPayload);
        broadcastUiNotification(notificationPayload);
      }

      await sendPushToAllUiSessions(
        {
          title,
          body,
          tag: `ready-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'ready',
          }
        },
        { requireNoSse: true }
      );
    }

    // Check for error finish
    if (info?.role === 'assistant' && info?.finish === 'error' && sessionId) {
      const settings = await readSettingsFromDisk();
      if (settings.notifyOnError === false) return;

      let title = 'Tool error';
      let body = 'An error occurred';

      try {
        const variables = await buildTemplateVariables(payload, sessionId);

        // Try fast-path (inline parts) first, then fetch from API
        const errorMessageId = info?.id;
        let lastMessage = extractLastMessageText(payload);
        if (!lastMessage) {
          lastMessage = await fetchLastAssistantMessageText(sessionId, errorMessageId);
        }

        const errZenModel = await resolveZenModel(settings?.zenModel);
        variables.last_message = await prepareNotificationLastMessage({
          message: lastMessage,
          settings,
          summarize: (text, len) => summarizeText(text, len, errZenModel),
        });

        const errorTemplate = (settings.notificationTemplates || {}).error || { title: 'Tool error', message: '{last_message}' };
        const resolvedTitle = resolveNotificationTemplate(errorTemplate.title, variables);
        const resolvedBody = resolveNotificationTemplate(errorTemplate.message, variables);
        if (resolvedTitle) title = resolvedTitle;
        if (shouldApplyResolvedTemplateMessage(errorTemplate.message, resolvedBody, variables)) body = resolvedBody;
      } catch (err) {
        console.warn('[Notification] Error template resolution failed, using defaults:', err?.message || err);
      }

      if (settings.nativeNotificationsEnabled) {
        const notificationPayload = {
          title,
          body,
          tag: `error-${sessionId}`,
          kind: 'error',
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        };
        emitDesktopNotification(notificationPayload);
        broadcastUiNotification(notificationPayload);
      }

      await sendPushToAllUiSessions(
        {
          title,
          body,
          tag: `error-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'error',
          }
        },
        { requireNoSse: true }
      );
    }

    return;
  }


  if (payload.type === 'question.asked' && sessionId) {
    const existingTimer = pushQuestionDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      pushQuestionDebounceTimers.delete(sessionId);

      const settings = await readSettingsFromDisk();

      // Check if question notifications are enabled
      if (settings.notifyOnQuestion === false) {
        return;
      }

      if (!settings.nativeNotificationsEnabled) {
        // Still send push even if native notifications are disabled
      }

      const firstQuestion = payload.properties?.questions?.[0];
      const header = typeof firstQuestion?.header === 'string' ? firstQuestion.header.trim() : '';
      const questionText = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : '';

      // Legacy fallback title
      let title = /plan\s*mode/i.test(header)
        ? 'Switch to plan mode'
        : /build\s*agent/i.test(header)
          ? 'Switch to build mode'
          : header || 'Input needed';
      let body = questionText || 'Agent is waiting for your response';

      try {
        // Build template variables
        const variables = await buildTemplateVariables(payload, sessionId);
        variables.last_message = questionText || header || '';

        // Get question template
        const templates = settings.notificationTemplates || {};
        const questionTemplate = templates.question || { title: 'Input needed', message: '{last_message}' };

        // Resolve templates with fallback to legacy behavior
        const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
        const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
        if (resolvedTitle) title = resolvedTitle;
        if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
      } catch (err) {
        console.warn('[Notification] Question template resolution failed, using defaults:', err?.message || err);
      }

      if (settings.nativeNotificationsEnabled) {
        emitDesktopNotification({
          kind: 'question',
          title,
          body,
          tag: `question-${sessionId}`,
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        });

        broadcastUiNotification({
          kind: 'question',
          title,
          body,
          tag: `question-${sessionId}`,
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        });
      }

      void sendPushToAllUiSessions(
        {
          title,
          body,
          tag: `question-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'question',
          }
        },
        { requireNoSse: true }
      );
    }, PUSH_QUESTION_DEBOUNCE_MS);

    pushQuestionDebounceTimers.set(sessionId, timer);
    return;
  }

  if (payload.type === 'permission.asked' && sessionId) {
    const requestId = payload.properties?.id;
    const permission = payload.properties?.permission;
    const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
    if (requestKey && notifiedPermissionRequests.has(requestKey)) {
      return;
    }

    const existingTimer = pushPermissionDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      pushPermissionDebounceTimers.delete(sessionId);
      const settings = await readSettingsFromDisk();

      // Permission requests use the question event toggle (since permission requests are a type of "agent needs input")
      if (settings.notifyOnQuestion === false) {
        return;
      }

      if (!settings.nativeNotificationsEnabled) {
        // Still send push even if native notifications are disabled
      }

      const sessionTitle = payload.properties?.sessionTitle;
      const permissionText = typeof permission === 'string' && permission.length > 0 ? permission : '';
      const fallbackMessage = typeof sessionTitle === 'string' && sessionTitle.trim().length > 0
        ? sessionTitle.trim()
        : permissionText || 'Agent is waiting for your approval';

      let title = 'Permission required';
      let body = fallbackMessage;

      try {
        // Build template variables
        const variables = await buildTemplateVariables(payload, sessionId);
        variables.last_message = fallbackMessage;

        // Get question template (permission uses question template since it's an input request)
        const templates = settings.notificationTemplates || {};
        const questionTemplate = templates.question || { title: 'Permission required', message: '{last_message}' };

        // Resolve templates with fallback to legacy behavior
        const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
        const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
        if (resolvedTitle) title = resolvedTitle;
        if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
      } catch (err) {
        console.warn('[Notification] Permission template resolution failed, using defaults:', err?.message || err);
      }

      if (settings.nativeNotificationsEnabled) {
        emitDesktopNotification({
          kind: 'permission',
          title,
          body,
          tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        });

        broadcastUiNotification({
          kind: 'permission',
          title,
          body,
          tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
          sessionId,
          requireHidden: settings.notificationMode !== 'always',
        });
      }

      if (requestKey) {
        notifiedPermissionRequests.add(requestKey);
      }

      void sendPushToAllUiSessions(
        {
          title,
          body,
          tag: `permission-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'permission',
          }
        },
        { requireNoSse: true }
      );
    }, PUSH_PERMISSION_DEBOUNCE_MS);

    pushPermissionDebounceTimers.set(sessionId, timer);
  }
};

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function extractApiPrefixFromUrl() {
  return '';
}

function detectOpenCodeApiPrefix() {
  openCodeApiPrefixDetected = true;
  openCodeApiPrefix = '';
  return true;
}

function ensureOpenCodeApiPrefix() {
  return detectOpenCodeApiPrefix();
}

function scheduleOpenCodeApiDetection() {
  return;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const envPassword =
    process.env.OPENCHAMBER_UI_PASSWORD ||
    process.env.OPENCODE_UI_PASSWORD ||
    null;
  const envCfTunnel = process.env.OPENCHAMBER_TRY_CF_TUNNEL === 'true';
  const options = { port: DEFAULT_PORT, uiPassword: envPassword, tryCfTunnel: envCfTunnel };

  const consumeValue = (currentIndex, inlineValue) => {
    if (typeof inlineValue === 'string') {
      return { value: inlineValue, nextIndex: currentIndex };
    }
    const nextArg = args[currentIndex + 1];
    if (typeof nextArg === 'string' && !nextArg.startsWith('--')) {
      return { value: nextArg, nextIndex: currentIndex + 1 };
    }
    return { value: undefined, nextIndex: currentIndex };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const optionName = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    const inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined;

    if (optionName === 'port' || optionName === 'p') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      const parsedPort = parseInt(value ?? '', 10);
      options.port = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
      continue;
    }

    if (optionName === 'ui-password') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.uiPassword = typeof value === 'string' ? value : '';
      continue;
    }

    if (optionName === 'try-cf-tunnel') {
      options.tryCfTunnel = true;
      continue;
    }
  }

  return options;
}

function killProcessOnPort(port) {
  if (!port) return;
  try {
    // Kill any process listening on our port to clean up orphaned children.
    const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8', timeout: 5000 });
    const output = result.stdout || '';
    const myPid = process.pid;
    for (const pidStr of output.split(/\s+/)) {
      const pid = parseInt(pidStr.trim(), 10);
      if (pid && pid !== myPid) {
        try {
          spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore', timeout: 2000 });
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore - process may already be dead
  }
}

async function createManagedOpenCodeServerProcess({
  hostname,
  port,
  timeout,
  cwd,
  env,
}) {
  const binary = (process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
  const args = ['serve', '--hostname', hostname, '--port', String(port)];
  const child = spawn(binary, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise((resolve, reject) => {
    let output = '';
    let done = false;
    const finish = (handler, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
      handler(value);
    };

    const onStdout = (chunk) => {
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (!line.startsWith('opencode server listening')) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          finish(reject, new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        finish(resolve, match[1]);
        return;
      }
    };

    const onStderr = (chunk) => {
      output += chunk.toString();
    };

    const onExit = (code) => {
      finish(reject, new Error(`OpenCode exited with code ${code}. Output: ${output}`));
    };

    const onError = (error) => {
      finish(reject, error);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`Timeout waiting for OpenCode to start after ${timeout}ms`));
    }, timeout);

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('exit', onExit);
    child.on('error', onError);
  });

  return {
    url,
    close() {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    },
  };
}

async function resolveManagedOpenCodePort(requestedPort) {
  if (typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort > 0) {
    return requestedPort;
  }

  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    const cleanup = () => {
      server.removeAllListeners('error');
      server.removeAllListeners('listening');
    };

    server.once('error', (error) => {
      cleanup();
      reject(error);
    });

    server.once('listening', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        cleanup();
        if (port > 0) {
          resolve(port);
          return;
        }
        reject(new Error('Failed to allocate OpenCode port'));
      });
    });

    server.listen(0, '127.0.0.1');
  });
}

async function startOpenCode() {
  const desiredPort = ENV_CONFIGURED_OPENCODE_PORT ?? 0;
  const spawnPort = await resolveManagedOpenCodePort(desiredPort);
  console.log(
    desiredPort > 0
      ? `Starting OpenCode on requested port ${desiredPort}...`
      : `Starting OpenCode on allocated port ${spawnPort}...`
  );

  await applyOpencodeBinaryFromSettings();
  ensureOpencodeCliEnv();
  const openCodePassword = await ensureLocalOpenCodeServerPassword({
    rotateManaged: true,
  });

  try {
    const serverInstance = await createManagedOpenCodeServerProcess({
      hostname: '127.0.0.1',
      port: spawnPort,
      timeout: 30000,
      cwd: openCodeWorkingDirectory,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: openCodePassword,
      },
    });

    if (!serverInstance || !serverInstance.url) {
      throw new Error('OpenCode server started but URL is missing');
    }

    const url = new URL(serverInstance.url);
    const port = parseInt(url.port, 10);
    const prefix = normalizeApiPrefix(url.pathname);

    if (await waitForReady(serverInstance.url, 10000)) {
      setOpenCodePort(port);
      setDetectedOpenCodeApiPrefix(prefix); // SDK URL typically includes the prefix if any

      isOpenCodeReady = true;
      lastOpenCodeError = null;
      openCodeNotReadySince = 0;

      return serverInstance;
    } else {
      try {
        serverInstance.close();
      } catch {
        // ignore
      }
      throw new Error('Server started but health check failed (timeout)');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastOpenCodeError = message;
    openCodePort = null;
    syncToHmrState();
    console.error(`Failed to start OpenCode: ${message}`);
    throw error;
  }
}

async function restartOpenCode() {
  if (isShuttingDown) return;
  if (currentRestartPromise) {
    await currentRestartPromise;
    return;
  }

  currentRestartPromise = (async () => {
    isRestartingOpenCode = true;
    isOpenCodeReady = false;
    openCodeNotReadySince = Date.now();
    console.log('Restarting OpenCode process...');

    // For external OpenCode servers, re-probe instead of kill + respawn
    if (isExternalOpenCode) {
      console.log('Re-probing external OpenCode server...');
      const probePort = openCodePort || ENV_CONFIGURED_OPENCODE_PORT || 4096;
      const healthy = await probeExternalOpenCode(probePort);
      if (healthy) {
        console.log(`External OpenCode server on port ${probePort} is healthy`);
        setOpenCodePort(probePort);
        isOpenCodeReady = true;
        lastOpenCodeError = null;
        openCodeNotReadySince = 0;
        syncToHmrState();
      } else {
        lastOpenCodeError = `External OpenCode server on port ${probePort} is not responding`;
        console.error(lastOpenCodeError);
        throw new Error(lastOpenCodeError);
      }

      if (expressApp) {
        setupProxy(expressApp);
        ensureOpenCodeApiPrefix();
      }
      return;
    }

    const portToKill = openCodePort;

    if (openCodeProcess) {
      console.log('Stopping existing OpenCode process...');
      try {
        openCodeProcess.close();
      } catch (error) {
        console.warn('Error closing OpenCode process:', error);
      }
      openCodeProcess = null;
      syncToHmrState();
    }

    killProcessOnPort(portToKill);

    // Brief delay to allow port release
    await new Promise((resolve) => setTimeout(resolve, 250));

    if (ENV_CONFIGURED_OPENCODE_PORT) {
      console.log(`Using OpenCode port from environment: ${ENV_CONFIGURED_OPENCODE_PORT}`);
      setOpenCodePort(ENV_CONFIGURED_OPENCODE_PORT);
    } else {
      openCodePort = null;
      syncToHmrState();
    }

    openCodeApiPrefixDetected = true;
    openCodeApiPrefix = '';
    if (openCodeApiDetectionTimer) {
      clearTimeout(openCodeApiDetectionTimer);
      openCodeApiDetectionTimer = null;
    }

    lastOpenCodeError = null;
    openCodeProcess = await startOpenCode();
    syncToHmrState();

    if (expressApp) {
      setupProxy(expressApp);
      // Ensure prefix is set correctly (SDK usually handles this, but just in case)
      ensureOpenCodeApiPrefix();
    }
  })();

  try {
    await currentRestartPromise;
  } catch (error) {
    console.error(`Failed to restart OpenCode: ${error.message}`);
    lastOpenCodeError = error.message;
    if (!ENV_CONFIGURED_OPENCODE_PORT) {
      openCodePort = null;
      syncToHmrState();
    }
    openCodeApiPrefixDetected = true;
    openCodeApiPrefix = '';
    throw error;
  } finally {
    currentRestartPromise = null;
    isRestartingOpenCode = false;
  }
}

async function waitForOpenCodeReady(timeoutMs = 20000, intervalMs = 400) {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const [configResult, agentResult] = await Promise.all([
        fetch(buildOpenCodeUrl('/config', ''), {
          method: 'GET',
          headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
        }).catch((error) => error),
        fetch(buildOpenCodeUrl('/agent', ''), {
          method: 'GET',
          headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
        }).catch((error) => error)
      ]);

      if (configResult instanceof Error) {
        lastError = configResult;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      if (!configResult.ok) {
        lastError = new Error(`OpenCode config endpoint responded with status ${configResult.status}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      await configResult.json().catch(() => null);

      if (agentResult instanceof Error) {
        lastError = agentResult;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      if (!agentResult.ok) {
        lastError = new Error(`Agent endpoint responded with status ${agentResult.status}`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      await agentResult.json().catch(() => []);

      isOpenCodeReady = true;
      lastOpenCodeError = null;
      return;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (lastError) {
    lastOpenCodeError = lastError.message || String(lastError);
    throw lastError;
  }

  const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
  lastOpenCodeError = timeoutError.message;
  throw timeoutError;
}

async function waitForAgentPresence(agentName, timeoutMs = 15000, intervalMs = 300) {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(buildOpenCodeUrl('/agent'), {
        method: 'GET',
        headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
      });

      if (response.ok) {
        const agents = await response.json();
        if (Array.isArray(agents) && agents.some((agent) => agent?.name === agentName)) {
          return;
        }
      }
    } catch (error) {

    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
}

async function fetchAgentsSnapshot() {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const response = await fetch(buildOpenCodeUrl('/agent'), {
    method: 'GET',
    headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch agents snapshot (status ${response.status})`);
  }

  const agents = await response.json().catch(() => null);
  if (!Array.isArray(agents)) {
    throw new Error('Invalid agents payload from OpenCode');
  }
  return agents;
}

async function fetchProvidersSnapshot() {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const response = await fetch(buildOpenCodeUrl('/provider'), {
    method: 'GET',
    headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch providers snapshot (status ${response.status})`);
  }

  const providers = await response.json().catch(() => null);
  if (!Array.isArray(providers)) {
    throw new Error('Invalid providers payload from OpenCode');
  }
  return providers;
}

async function fetchModelsSnapshot() {
  if (!openCodePort) {
    throw new Error('OpenCode port is not available');
  }

  const response = await fetch(buildOpenCodeUrl('/model'), {
    method: 'GET',
    headers: { Accept: 'application/json',  ...getOpenCodeAuthHeaders()  }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models snapshot (status ${response.status})`);
  }

  const models = await response.json().catch(() => null);
  if (!Array.isArray(models)) {
    throw new Error('Invalid models payload from OpenCode');
  }
  return models;
}

async function refreshOpenCodeAfterConfigChange(reason, options = {}) {
  const { agentName } = options;

  console.log(`Refreshing OpenCode after ${reason}`);

  // Settings might include a new opencodeBinary; drop cache before restart.
  resolvedOpencodeBinary = null;
  await applyOpencodeBinaryFromSettings();

  await restartOpenCode();

  try {
    await waitForOpenCodeReady();
    isOpenCodeReady = true;
    openCodeNotReadySince = 0;

    if (agentName) {
      await waitForAgentPresence(agentName);
    }

    isOpenCodeReady = true;
    openCodeNotReadySince = 0;
  } catch (error) {

    isOpenCodeReady = false;
    openCodeNotReadySince = Date.now();
    console.error(`Failed to refresh OpenCode after ${reason}:`, error.message);
    throw error;
  }
}

function setupProxy(app) {
  if (app.get('opencodeProxyConfigured')) {
    return;
  }

  if (openCodePort) {
    console.log(`Setting up proxy to OpenCode on port ${openCodePort}`);
  } else {
    console.log('Setting up OpenCode API gate (OpenCode not started yet)');
  }
  app.set('opencodeProxyConfigured', true);

  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/push') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/config/reload' ||
      req.path === '/health'
    ) {
      return next();
    }

    const waitElapsed = openCodeNotReadySince === 0 ? 0 : Date.now() - openCodeNotReadySince;
    const stillWaiting =
      (!isOpenCodeReady && (openCodeNotReadySince === 0 || waitElapsed < OPEN_CODE_READY_GRACE_MS)) ||
      isRestartingOpenCode ||
      !openCodePort;

    if (stillWaiting) {
      return res.status(503).json({
        error: 'OpenCode is restarting',
        restarting: true,
      });
    }

    next();
  });

  const isSseApiPath = (path) => path === '/event' || path === '/global/event';

  const forwardSseRequest = async (req, res) => {
    const startedAt = Date.now();
    const upstreamPath = req.originalUrl.replace(/^\/api/, '');
    const targetUrl = buildOpenCodeUrl(upstreamPath, '');
    const authHeaders = getOpenCodeAuthHeaders();

    const requestHeaders = {
      ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : { accept: 'text/event-stream' }),
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(authHeaders.Authorization ? { Authorization: authHeaders.Authorization } : {}),
    };

    const controller = new AbortController();
    let connectTimer = null;
    let idleTimer = null;
    let heartbeatTimer = null;
    let endedBy = 'upstream-end';

    const cleanup = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      req.off('close', onClientClose);
    };

    const resetIdleTimeout = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        endedBy = 'idle-timeout';
        controller.abort();
      }, 5 * 60 * 1000);
    };

    const onClientClose = () => {
      endedBy = 'client-disconnect';
      controller.abort();
    };

    req.on('close', onClientClose);

    try {
      connectTimer = setTimeout(() => {
        endedBy = 'connect-timeout';
        controller.abort();
      }, 10 * 1000);

      const upstreamResponse = await fetch(targetUrl, {
        method: 'GET',
        headers: requestHeaders,
        signal: controller.signal,
      });

      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }

      if (!upstreamResponse.ok || !upstreamResponse.body) {
        const body = await upstreamResponse.text().catch(() => '');
        cleanup();
        if (!res.headersSent) {
          if (upstreamResponse.headers.has('content-type')) {
            res.setHeader('content-type', upstreamResponse.headers.get('content-type'));
          }
          res.status(upstreamResponse.status).send(body);
        }
        return;
      }

      const upstreamContentType = upstreamResponse.headers.get('content-type') || 'text/event-stream';
      res.status(upstreamResponse.status);
      res.setHeader('content-type', upstreamContentType);
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.setHeader('x-content-type-options', 'nosniff');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      resetIdleTimeout();
      heartbeatTimer = setInterval(() => {
        if (res.writableEnded || controller.signal.aborted) {
          return;
        }
        try {
          res.write(': ping\n\n');
          resetIdleTimeout();
        } catch {
        }
      }, 30 * 1000);

      const reader = upstreamResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            endedBy = endedBy === 'upstream-end' ? 'upstream-finished' : endedBy;
            break;
          }
          if (controller.signal.aborted) {
            break;
          }
          if (value && value.length > 0) {
            res.write(Buffer.from(value));
            resetIdleTimeout();
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
        }
      }

      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
      console.log(`SSE forward ${upstreamPath} closed (${endedBy}) in ${Date.now() - startedAt}ms`);
    } catch (error) {
      cleanup();
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (!res.headersSent) {
        res.status(isTimeout ? 504 : 503).json({
          error: isTimeout ? 'OpenCode SSE forward timed out' : 'OpenCode SSE forward failed',
        });
      } else if (!res.writableEnded) {
        res.end();
      }
      console.warn(`SSE forward ${upstreamPath} failed (${endedBy}):`, error?.message || error);
    }
  };

  app.get('/api/event', forwardSseRequest);
  app.get('/api/global/event', forwardSseRequest);

  app.use('/api', (_req, _res, next) => {
    ensureOpenCodeApiPrefix();
    next();
  });

  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/health'
    ) {
      return next();
    }
    console.log(`API → OpenCode: ${req.method} ${req.path}`);
    next();
  });


  const hopByHopRequestHeaders = new Set([
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'te',
    'trailer',
    'upgrade',
  ]);

  const hopByHopResponseHeaders = new Set([
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'te',
    'trailer',
    'upgrade',
    'www-authenticate',
  ]);

  const collectForwardHeaders = (req) => {
    const authHeaders = getOpenCodeAuthHeaders();
    const headers = {};

    for (const [key, value] of Object.entries(req.headers || {})) {
      if (!value) continue;
      const lowerKey = key.toLowerCase();
      if (hopByHopRequestHeaders.has(lowerKey)) continue;
      headers[lowerKey] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    if (authHeaders.Authorization) {
      headers.Authorization = authHeaders.Authorization;
    }

    return headers;
  };

  const collectRequestBodyBuffer = async (req) => {
    if (Buffer.isBuffer(req.body)) {
      return req.body;
    }

    if (typeof req.body === 'string') {
      return Buffer.from(req.body);
    }

    if (req.body && typeof req.body === 'object') {
      return Buffer.from(JSON.stringify(req.body));
    }

    if (req.readableEnded) {
      return Buffer.alloc(0);
    }

    return await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  };

  const forwardGenericApiRequest = async (req, res) => {
    try {
      const upstreamPath = req.originalUrl.replace(/^\/api/, '');
      const targetUrl = buildOpenCodeUrl(upstreamPath, '');
      const headers = collectForwardHeaders(req);
      const method = String(req.method || 'GET').toUpperCase();
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const bodyBuffer = hasBody ? await collectRequestBodyBuffer(req) : null;

      const upstreamResponse = await fetch(targetUrl, {
        method,
        headers,
        body: hasBody ? bodyBuffer : undefined,
        signal: AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS),
      });

      for (const [key, value] of upstreamResponse.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (hopByHopResponseHeaders.has(lowerKey)) {
          continue;
        }
        res.setHeader(key, value);
      }

      const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());
      res.status(upstreamResponse.status).send(upstreamBody);
    } catch (error) {
      if (!res.headersSent) {
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        res.status(isTimeout ? 504 : 503).json({
          error: isTimeout ? 'OpenCode request timed out' : 'OpenCode service unavailable',
        });
      }
    }
  };

  // Dedicated forwarder for large session message payloads.
  // This avoids edge-cases in generic proxy streaming for multi-file attachments.
  app.post('/api/session/:sessionId/message', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    try {
      const upstreamPath = req.originalUrl.replace(/^\/api/, '');
      const targetUrl = buildOpenCodeUrl(upstreamPath, '');
      const authHeaders = getOpenCodeAuthHeaders();

      const headers = {
        ...(typeof req.headers['content-type'] === 'string' ? { 'content-type': req.headers['content-type'] } : { 'content-type': 'application/json' }),
        ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : {}),
        ...(authHeaders.Authorization ? { Authorization: authHeaders.Authorization } : {}),
      };

      const bodyBuffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === 'string' ? req.body : '');

      const upstreamResponse = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: bodyBuffer,
        signal: AbortSignal.timeout(LONG_REQUEST_TIMEOUT_MS),
      });

      const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());

      if (upstreamResponse.headers.has('content-type')) {
        res.setHeader('content-type', upstreamResponse.headers.get('content-type'));
      }

      res.status(upstreamResponse.status).send(upstreamBody);
    } catch (error) {
      if (!res.headersSent) {
        const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        res.status(isTimeout ? 504 : 503).json({
          error: isTimeout ? 'OpenCode message forward timed out' : 'OpenCode message forward failed',
        });
      }
    }
  });

  app.use('/api', (req, res, next) => {
    if (isSseApiPath(req.path)) {
      return next();
    }

    if (req.method === 'POST' && /\/session\/[^/]+\/message$/.test(req.path || '')) {
      return next();
    }

    return forwardGenericApiRequest(req, res);
  });
}

function startHealthMonitoring() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  healthCheckInterval = setInterval(async () => {
    if (!openCodeProcess || isShuttingDown || isRestartingOpenCode) return;

    try {
      const healthy = await isOpenCodeProcessHealthy();
      if (!healthy) {
        console.log('OpenCode process not running, restarting...');
        await restartOpenCode();
      }
    } catch (error) {
      console.error(`Health check error: ${error.message}`);
    }
  }, HEALTH_CHECK_INTERVAL);
}

async function gracefulShutdown(options = {}) {
  if (isShuttingDown) return;

  isShuttingDown = true;
  syncToHmrState();
  console.log('Starting graceful shutdown...');
  const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : exitOnShutdown;

  stopGlobalEventWatcher();

  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  if (terminalInputWsServer) {
    try {
      for (const client of terminalInputWsServer.clients) {
        try {
          client.terminate();
        } catch {
        }
      }

      await new Promise((resolve) => {
        terminalInputWsServer.close(() => resolve());
      });
    } catch {
    } finally {
      terminalInputWsServer = null;
    }
  }

  // Only stop OpenCode if we started it ourselves (not when using external server)
  if (!ENV_SKIP_OPENCODE_START && !isExternalOpenCode) {
    const portToKill = openCodePort;

    if (openCodeProcess) {
      console.log('Stopping OpenCode process...');
      try {
        openCodeProcess.close();
      } catch (error) {
        console.warn('Error closing OpenCode process:', error);
      }
      openCodeProcess = null;
    }

    killProcessOnPort(portToKill);
  } else {
    console.log('Skipping OpenCode shutdown (external server)');
  }

  if (server) {
    await Promise.race([
      new Promise((resolve) => {
        server.close(() => {
          console.log('HTTP server closed');
          resolve();
        });
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          console.warn('Server close timeout reached, forcing shutdown');
          resolve();
        }, SHUTDOWN_TIMEOUT);
      })
    ]);
  }

  if (uiAuthController) {
    uiAuthController.dispose();
    uiAuthController = null;
  }

  if (cloudflareTunnelController) {
    console.log('Stopping Cloudflare tunnel...');
    cloudflareTunnelController.stop();
    cloudflareTunnelController = null;
  }

  console.log('Graceful shutdown complete');
  if (exitProcess) {
    process.exit(0);
  }
}

async function main(options = {}) {
  const port = Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const tryCfTunnel = options.tryCfTunnel === true;
  const attachSignals = options.attachSignals !== false;
  const onTunnelReady = typeof options.onTunnelReady === 'function' ? options.onTunnelReady : null;
  if (typeof options.exitOnShutdown === 'boolean') {
    exitOnShutdown = options.exitOnShutdown;
  }

  console.log(`Starting OpenChamber on port ${port === 0 ? 'auto' : port}`);

  // Check macOS Say TTS availability once at startup
  let sayTTSCapability = { available: false, voices: [], reason: 'Not checked' };
  if (process.platform === 'darwin') {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const { stdout } = await execAsync('say -v "?"');
      const voices = stdout.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const match = line.match(/^(.+?)\s+([a-zA-Z]{2}_[a-zA-Z]{2,3})\s+#/);
          if (match) {
            return { name: match[1].trim(), locale: match[2] };
          }
          return null;
        })
        .filter(Boolean);
      sayTTSCapability = { available: true, voices };
      console.log(`macOS Say TTS available with ${voices.length} voices`);
    } catch (error) {
      sayTTSCapability = { available: false, voices: [], reason: 'say command not available' };
      console.log('macOS Say TTS not available:', error.message);
    }
  } else {
    sayTTSCapability = { available: false, voices: [], reason: 'Not macOS' };
  }

  // Validate stored zen model at startup – best-effort, never blocks startup
  try {
    const freeModels = await fetchFreeZenModels();
    const freeModelIds = freeModels.map((m) => m.id);

    if (freeModelIds.length > 0) {
      // Set the validated fallback to the first available free model
      validatedZenFallback = freeModelIds[0];

      const settings = await readSettingsFromDisk();
      const storedModel = typeof settings?.zenModel === 'string' ? settings.zenModel.trim() : '';

      if (!storedModel || !freeModelIds.includes(storedModel)) {
        const fallback = freeModelIds[0];
        console.log(
          storedModel
            ? `[zen] Stored model "${storedModel}" not found in free models, falling back to "${fallback}"`
            : `[zen] No model configured, setting default to "${fallback}"`
        );
        await persistSettings({ zenModel: fallback });
      } else {
        console.log(`[zen] Stored model "${storedModel}" verified as available`);
      }
    } else {
      console.warn('[zen] No free models returned from API, skipping validation');
    }
  } catch (error) {
    console.warn('[zen] Startup model validation failed (non-blocking):', error?.message || error);
  }

  const app = express();
  app.set('trust proxy', true);
  expressApp = app;
  server = http.createServer(app);

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      openCodePort: openCodePort,
      openCodeRunning: Boolean(openCodePort && isOpenCodeReady && !isRestartingOpenCode),
      openCodeSecureConnection: isOpenCodeConnectionSecure(),
      openCodeAuthSource: openCodeAuthSource || null,
      openCodeApiPrefix: '',
      openCodeApiPrefixDetected: true,
      isOpenCodeReady,
      lastOpenCodeError,
      opencodeBinaryResolved: resolvedOpencodeBinary || null,
      opencodeBinarySource: resolvedOpencodeBinarySource || null,
      opencodeShimInterpreter: resolvedOpencodeBinary ? opencodeShimInterpreter(resolvedOpencodeBinary) : null,
      nodeBinaryResolved: resolvedNodeBinary || null,
      bunBinaryResolved: resolvedBunBinary || null,
    });
  });

  app.post('/api/system/shutdown', (req, res) => {
    res.json({ ok: true });
    gracefulShutdown({ exitProcess: false }).catch((error) => {
      console.error('Shutdown request failed:', error?.message || error);
    });
  });

  app.use((req, res, next) => {
    if (
      req.path.startsWith('/api/config/agents') ||
      req.path.startsWith('/api/config/commands') ||
      req.path.startsWith('/api/config/mcp') ||
      req.path.startsWith('/api/config/settings') ||
      req.path.startsWith('/api/config/skills') ||
      req.path.startsWith('/api/fs') ||
      req.path.startsWith('/api/git') ||
      req.path.startsWith('/api/prompts') ||
      req.path.startsWith('/api/terminal') ||
      req.path.startsWith('/api/opencode') ||
      req.path.startsWith('/api/push') ||
      req.path.startsWith('/api/voice') ||
      req.path.startsWith('/api/tts')
    ) {

      express.json({ limit: '50mb' })(req, res, next);
    } else if (req.path.startsWith('/api')) {

      next();
    } else {

      express.json({ limit: '50mb' })(req, res, next);
    }
  });
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });

  const uiPassword = typeof options.uiPassword === 'string' ? options.uiPassword : null;
  uiAuthController = createUiAuth({ password: uiPassword });
  if (uiAuthController.enabled) {
    console.log('UI password protection enabled for browser sessions');
  }

  app.get('/auth/session', (req, res) => uiAuthController.handleSessionStatus(req, res));
  app.post('/auth/session', (req, res) => uiAuthController.handleSessionCreate(req, res));

  app.use('/api', (req, res, next) => uiAuthController.requireAuth(req, res, next));

  const parsePushSubscribeBody = (body) => {
    if (!body || typeof body !== 'object') return null;
    const endpoint = body.endpoint;
    const keys = body.keys;
    const p256dh = keys?.p256dh;
    const auth = keys?.auth;

    if (typeof endpoint !== 'string' || endpoint.trim().length === 0) return null;
    if (typeof p256dh !== 'string' || p256dh.trim().length === 0) return null;
    if (typeof auth !== 'string' || auth.trim().length === 0) return null;

    return {
      endpoint: endpoint.trim(),
      keys: { p256dh: p256dh.trim(), auth: auth.trim() },
    };
  };

  const parsePushUnsubscribeBody = (body) => {
    if (!body || typeof body !== 'object') return null;
    const endpoint = body.endpoint;
    if (typeof endpoint !== 'string' || endpoint.trim().length === 0) return null;
    return { endpoint: endpoint.trim() };
  };

  app.get('/api/push/vapid-public-key', async (req, res) => {
    try {
      await ensurePushInitialized();
      const keys = await getOrCreateVapidKeys();
      res.json({ publicKey: keys.publicKey });
    } catch (error) {
      console.warn('[Push] Failed to load VAPID key:', error);
      res.status(500).json({ error: 'Failed to load push key' });
    }
  });

  app.post('/api/push/subscribe', async (req, res) => {
    await ensurePushInitialized();

    const uiToken = uiAuthController?.ensureSessionToken
      ? uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const parsed = parsePushSubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    const { endpoint, keys } = parsed;

    const origin = typeof req.body?.origin === 'string' ? req.body.origin.trim() : '';
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      try {
        const settings = await readSettingsFromDiskMigrated();
        if (typeof settings?.publicOrigin !== 'string' || settings.publicOrigin.trim().length === 0) {
          await writeSettingsToDisk({
            ...settings,
            publicOrigin: origin,
          });
          // allow next sends to pick it up
          pushInitialized = false;
        }
      } catch {
        // ignore
      }
    }

    await addOrUpdatePushSubscription(
      uiToken,
      {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      req.headers['user-agent']
    );

    res.json({ ok: true });
  });


  app.delete('/api/push/subscribe', async (req, res) => {
    await ensurePushInitialized();

    const uiToken = uiAuthController?.ensureSessionToken
      ? uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const parsed = parsePushUnsubscribeBody(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid body' });
    }

    await removePushSubscription(uiToken, parsed.endpoint);
    res.json({ ok: true });
  });

  app.post('/api/push/visibility', (req, res) => {
    const uiToken = uiAuthController?.ensureSessionToken
      ? uiAuthController.ensureSessionToken(req, res)
      : getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    const visible = req.body && typeof req.body === 'object' ? req.body.visible : null;
    updateUiVisibility(uiToken, visible === true);
    res.json({ ok: true });
  });

  app.get('/api/push/visibility', (req, res) => {
    const uiToken = getUiSessionTokenFromRequest(req);
    if (!uiToken) {
      return res.status(401).json({ error: 'UI session missing' });
    }

    res.json({
      ok: true,
      visible: isUiVisible(uiToken),
    });
  });

  // Session activity status endpoint - returns tracked activity phases for all sessions
  // Used by UI on visibility restore to get accurate status without waiting for SSE
  app.get('/api/session-activity', (_req, res) => {
    res.json(getSessionActivitySnapshot());
  });

  // Voice token endpoint - returns OpenAI TTS availability status
  app.post('/api/voice/token', async (req, res) => {
    console.log('[Voice] Token request received:', { body: req.body, headers: req.headers['content-type'] });
    try {
      const openaiApiKey = process.env.OPENAI_API_KEY;
      console.log('[Voice] OpenAI API Key present:', !!openaiApiKey);

      if (!openaiApiKey) {
        return res.status(503).json({
          allowed: false,
          error: 'OpenAI voice service not configured. Set OPENAI_API_KEY environment variable.'
        });
      }

      // Return success - OpenAI TTS is available
      res.json({
        allowed: true,
        provider: 'openai',
        message: 'OpenAI TTS is available'
      });
    } catch (error) {
      console.error('[Voice] Token generation error:', error);
      res.status(500).json({
        allowed: false,
        error: 'Voice service error'
      });
    }
  });

  // Server-side TTS endpoint - streams audio from OpenAI TTS API
  app.post('/api/tts/speak', async (req, res) => {
    try {
      const { text, voice = 'nova', model = 'gpt-4o-mini-tts', speed = 0.9, instructions, summarize = false, providerId, modelId, threshold = 200, maxLength = 500, apiKey } = req.body || {};

      console.log('[TTS] Request received:', { voice, model, speed, textLength: text?.length, hasApiKey: !!apiKey });

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      // Dynamically import the TTS service (ESM)
      const { ttsService } = await import('./lib/tts-service.js');

      // Check availability - either server-configured or client-provided API key
      const hasServerKey = ttsService.isAvailable();
      const hasClientKey = apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0;
      
      if (!hasServerKey && !hasClientKey) {
        return res.status(503).json({ 
          error: 'TTS service not available. Please configure OpenAI in OpenCode or provide an API key in settings.' 
        });
      }

      let textToSpeak = text.trim();

      // Optionally summarize long text before speaking using zen API
      if (summarize && textToSpeak.length > threshold) {
        try {
          const { summarizeText } = await import('./lib/summarization-service.js');
          const speakZenModel = await resolveZenModel(typeof req.body?.zenModel === 'string' ? req.body.zenModel : undefined);
          const result = await summarizeText({ text: textToSpeak, threshold, maxLength, zenModel: speakZenModel });
          
          if (result.summarized && result.summary) {
            textToSpeak = result.summary;
          }
        } catch (summarizeError) {
          console.error('[TTS/speak] Summarization failed:', summarizeError);
          // Continue with original text if summarization fails
        }
      }

      const result = await ttsService.generateSpeechStream({
        text: textToSpeak,
        voice,
        model,
        speed,
        instructions,
        apiKey: hasClientKey ? apiKey.trim() : undefined
      });

      // Set headers for audio streaming
      // Note: Don't set Transfer-Encoding manually - Express handles it automatically
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-cache');

      // Collect the full audio buffer and send it
      // This avoids chunked encoding issues with proxies
      const reader = result.stream.getReader();
      const chunks = [];
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
        const audioBuffer = Buffer.concat(chunks);
        res.setHeader('Content-Length', audioBuffer.length);
        res.send(audioBuffer);
      } catch (streamError) {
        console.error('[TTS] Stream error:', streamError);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        } else {
          res.end();
        }
      }
    } catch (error) {
      console.error('[TTS] Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: error instanceof Error ? error.message : 'TTS generation failed' 
        });
      }
    }
  });

  // Import summarization service
  const { summarizeText, sanitizeForTTS } = await import('./lib/summarization-service.js');

  app.post('/api/tts/summarize', async (req, res) => {
    try {
      const { text, threshold = 200, maxLength = 500 } = req.body || {};

      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const sumZenModel = await resolveZenModel(typeof req.body?.zenModel === 'string' ? req.body.zenModel : undefined);
      const result = await summarizeText({ text, threshold, maxLength, zenModel: sumZenModel });

      return res.json(result);
    } catch (error) {
      console.error('[Summarize] Error:', error);
      const sanitized = sanitizeForTTS(req.body?.text || '');
      return res.json({ summary: sanitized, summarized: false, reason: error.message });
    }
  });

       
  // TTS status endpoint
  app.get('/api/tts/status', async (_req, res) => {
    try {
      const { ttsService } = await import('./lib/tts-service.js');
      res.json({
        available: ttsService.isAvailable(),
        voices: [
          'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
          'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
        ]
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to check TTS status' });
    }
  });

  // macOS 'say' command TTS status endpoint - returns cached capability from startup
  app.get('/api/tts/say/status', (_req, res) => {
    res.json(sayTTSCapability);
  });

  // macOS 'say' command TTS speak endpoint
  app.post('/api/tts/say/speak', async (req, res) => {
    try {
      const { text, voice = 'Samantha', rate = 200 } = req.body || {};
      
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }
      
      // Check if we're on macOS
      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'macOS say command not available on this platform' });
      }
      
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const execAsync = promisify(exec);
      
      // Create temp file for audio output (use m4a for browser compatibility)
      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, `say-${Date.now()}.m4a`);
      
      // Escape text for shell - escape both single quotes and double quotes
      const escapedText = text.trim().replace(/'/g, "'\\''").replace(/"/g, '\\"');
      
      // Generate audio file using 'say' command
      // -o outputs to file, -r sets rate (words per minute)
      // --data-format=aac outputs as m4a which browsers can decode
      const cmd = `say -v "${voice}" -r ${rate} -o "${tempFile}" --data-format=aac '${escapedText}'`;
      console.log('[TTS-Say] Generating speech:', { textLength: text.length, voice, rate });
      
      await execAsync(cmd);
      
      // Read the generated audio file
      const audioBuffer = await fs.promises.readFile(tempFile);
      
      // Clean up temp file
      fs.promises.unlink(tempFile).catch(() => {});
      
      // Send audio response
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Content-Length', audioBuffer.length);
      res.send(audioBuffer);
      
    } catch (error) {
      console.error('[TTS-Say] Error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Say command failed'
      });
    }
  });

  // New authoritative session status endpoints
  // Server maintains the source of truth, clients only query

  // GET /api/sessions/snapshot - Combined status + attention snapshot
  app.get('/api/sessions/snapshot', (_req, res) => {
    res.json({
      statusSessions: getSessionStateSnapshot(),
      attentionSessions: getSessionAttentionSnapshot(),
      serverTime: Date.now()
    });
  });

  // GET /api/sessions/status - Get status for all sessions
  app.get('/api/sessions/status', (_req, res) => {
    const snapshot = getSessionStateSnapshot();
    res.json({
      sessions: snapshot,
      serverTime: Date.now()
    });
  });

  // GET /api/sessions/:id/status - Get status for a specific session
  app.get('/api/sessions/:id/status', (req, res) => {
    const sessionId = req.params.id;
    const state = getSessionState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'Session not found or no state available',
        sessionId
      });
    }

    res.json({
      sessionId,
      ...state
    });
  });

  // Session attention tracking endpoints
  // GET /api/sessions/attention - Get attention state for all sessions
  app.get('/api/sessions/attention', (_req, res) => {
    const snapshot = getSessionAttentionSnapshot();
    res.json({
      sessions: snapshot,
      serverTime: Date.now()
    });
  });

  // GET /api/sessions/:id/attention - Get attention state for a specific session
  app.get('/api/sessions/:id/attention', (req, res) => {
    const sessionId = req.params.id;
    const state = getSessionAttentionState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'Session not found or no attention state available',
        sessionId
      });
    }

    res.json({
      sessionId,
      ...state
    });
  });

  // POST /api/sessions/:id/view - Client reports viewing this session
  app.post('/api/sessions/:id/view', (req, res) => {
    const sessionId = req.params.id;
    const clientId = req.headers['x-client-id'] || req.ip || 'anonymous';

    markSessionViewed(sessionId, clientId);

    res.json({
      success: true,
      sessionId,
      viewed: true
    });
  });

  // POST /api/sessions/:id/unview - Client reports leaving this session
  app.post('/api/sessions/:id/unview', (req, res) => {
    const sessionId = req.params.id;
    const clientId = req.headers['x-client-id'] || req.ip || 'anonymous';

    markSessionUnviewed(sessionId, clientId);

    res.json({
      success: true,
      sessionId,
      viewed: false
    });
  });

  // POST /api/sessions/:id/message-sent - User sent a message in this session
  app.post('/api/sessions/:id/message-sent', (req, res) => {
    const sessionId = req.params.id;

    markUserMessageSent(sessionId);

    res.json({
      success: true,
      sessionId,
      messageSent: true
    });
  });

  app.get('/api/openchamber/update-check', async (_req, res) => {
    try {
      const { checkForUpdates } = await import('./lib/package-manager.js');
      const updateInfo = await checkForUpdates();
      res.json(updateInfo);
    } catch (error) {
      console.error('Failed to check for updates:', error);
      res.status(500).json({
        available: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    }
  });

  app.post('/api/openchamber/update-install', async (_req, res) => {
    try {
      const { spawn: spawnChild } = await import('child_process');
      const {
        checkForUpdates,
        getUpdateCommand,
        detectPackageManager,
      } = await import('./lib/package-manager.js');

      // Verify update is available
      const updateInfo = await checkForUpdates();
      if (!updateInfo.available) {
        return res.status(400).json({ error: 'No update available' });
      }

      const pm = detectPackageManager();
      const updateCmd = getUpdateCommand(pm);

      // Get current server port for restart
      const currentPort = server.address()?.port || 3000;

      // Try to read stored instance options for restart
      const tmpDir = os.tmpdir();
      const instanceFilePath = path.join(tmpDir, `openchamber-${currentPort}.json`);
      let storedOptions = { port: currentPort, daemon: true };
      try {
        const content = await fs.promises.readFile(instanceFilePath, 'utf8');
        storedOptions = JSON.parse(content);
      } catch {
        // Use defaults
      }

      const isWindows = process.platform === 'win32';

      // Build restart command with stored options
      let restartCmd = `openchamber serve --port ${storedOptions.port} --daemon`;
      if (storedOptions.uiPassword) {
        if (isWindows) {
          // Escape for cmd.exe quoted argument
          const escapedPw = storedOptions.uiPassword.replace(/"/g, '""');
          restartCmd += ` --ui-password "${escapedPw}"`;
        } else {
          // Escape for POSIX single-quoted argument
          const escapedPw = storedOptions.uiPassword.replace(/'/g, "'\\''");
          restartCmd += ` --ui-password '${escapedPw}'`;
        }
      }

      // Respond immediately - update will happen after response
      res.json({
        success: true,
        message: 'Update starting, server will restart shortly',
        version: updateInfo.version,
        packageManager: pm,
      });

      // Give time for response to be sent
      setTimeout(() => {
        console.log(`\nInstalling update using ${pm}...`);
        console.log(`Running: ${updateCmd}`);

        // Create a script that will:
        // 1. Wait for current process to exit
        // 2. Run the update
        // 3. Restart the server with original options
        const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'sh';
        const shellFlag = isWindows ? '/c' : '-c';
        const script = isWindows
          ? `
            timeout /t 2 /nobreak >nul
            ${updateCmd}
            if %ERRORLEVEL% EQU 0 (
              echo Update successful, restarting OpenChamber...
              ${restartCmd}
            ) else (
              echo Update failed
              exit /b 1
            )
          `
          : `
            sleep 2
            ${updateCmd}
            if [ $? -eq 0 ]; then
              echo "Update successful, restarting OpenChamber..."
              ${restartCmd}
            else
              echo "Update failed"
              exit 1
            fi
          `;

        // Spawn detached shell to run update after we exit
        const child = spawnChild(shell, [shellFlag, script], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        child.unref();

        console.log('Update process spawned, shutting down server...');

        // Give child process time to start, then exit
        setTimeout(() => {
          process.exit(0);
        }, 500);
      }, 500);
    } catch (error) {
      console.error('Failed to install update:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to install update',
      });
    }
  });

  app.get('/api/openchamber/models-metadata', async (req, res) => {
    const now = Date.now();

    if (cachedModelsMetadata && now - cachedModelsMetadataTimestamp < MODELS_METADATA_CACHE_TTL) {
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json(cachedModelsMetadata);
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), 8000) : null;

    try {
      const response = await fetch(MODELS_DEV_API_URL, {
        signal: controller?.signal,
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`models.dev responded with status ${response.status}`);
      }

      const metadata = await response.json();
      cachedModelsMetadata = metadata;
      cachedModelsMetadataTimestamp = Date.now();

      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(metadata);
    } catch (error) {
      console.warn('Failed to fetch models.dev metadata via server:', error);

      if (cachedModelsMetadata) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedModelsMetadata);
      } else {
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve model metadata' });
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  });

  // Zen models endpoint - returns available free models from the zen API
  app.get('/api/zen/models', async (_req, res) => {
    try {
      const models = await fetchFreeZenModels();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ models });
    } catch (error) {
      console.warn('Failed to fetch zen models:', error);
      // Serve stale cache if available
      if (cachedZenModels) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedZenModels);
      } else {
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });

  app.get('/api/global/event', async (req, res) => {
    let targetUrl;
    try {
      targetUrl = new URL(buildOpenCodeUrl('/global/event', ''));
    } catch {
      return res.status(503).json({ error: 'OpenCode service unavailable' });
    }

    const headers = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...getOpenCodeAuthHeaders(),
    };

    const lastEventId = req.header('Last-Event-ID');
    if (typeof lastEventId === 'string' && lastEventId.length > 0) {
      headers['Last-Event-ID'] = lastEventId;
    }

    const controller = new AbortController();
    const cleanup = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      return res.status(502).json({ error: 'Failed to connect to OpenCode event stream' });
    }

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `OpenCode event stream unavailable (${upstream.status})` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    uiNotificationClients.add(res);
    const cleanupClient = () => {
      uiNotificationClients.delete(res);
    };
    req.on('close', cleanupClient);
    req.on('error', cleanupClient);

    const heartbeatInterval = setInterval(() => {
      writeSseEvent(res, { type: 'openchamber:heartbeat', timestamp: Date.now() });
    }, 15000);

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = '';

    const forwardBlock = (block) => {
      if (!block) return;
      res.write(`${block}

`);
      const payload = parseSseDataPayload(block);
      // Cache session titles from session.updated/session.created events (global stream)
      maybeCacheSessionInfoFromEvent(payload);

      // Keep server-authoritative session state fresh even if the
      // background watcher is disconnected.
      if (payload && payload.type === 'session.status') {
        const update = extractSessionStatusUpdate(payload);
        if (update) {
          updateSessionState(update.sessionId, update.type, update.eventId || `proxy-${Date.now()}`, {
            attempt: update.attempt,
            message: update.message,
            next: update.next,
          });
        }
      }

      const transitions = deriveSessionActivityTransitions(payload);
      if (transitions && transitions.length > 0) {
        for (const activity of transitions) {
          if (setSessionActivityPhase(activity.sessionId, activity.phase)) {
            writeSseEvent(res, {
              type: 'openchamber:session-activity',
              properties: {
                sessionId: activity.sessionId,
                phase: activity.phase,
              }
            });
          }
        }
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex !== -1) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          forwardBlock(block);
          separatorIndex = buffer.indexOf('\n\n');
        }
      }

      if (buffer.trim().length > 0) {
        forwardBlock(buffer.trim());
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('SSE proxy stream error:', error);
      }
    } finally {
      clearInterval(heartbeatInterval);
      cleanupClient();
      cleanup();
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  });

  app.get('/api/event', async (req, res) => {
    let targetUrl;
    try {
      targetUrl = new URL(buildOpenCodeUrl('/event', ''));
    } catch {
      return res.status(503).json({ error: 'OpenCode service unavailable' });
    }

    const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const directoryParam = Array.isArray(req.query.directory)
      ? req.query.directory[0]
      : req.query.directory;
    const resolvedDirectory = headerDirectory || directoryParam || null;
    if (typeof resolvedDirectory === 'string' && resolvedDirectory.trim().length > 0) {
      targetUrl.searchParams.set('directory', resolvedDirectory.trim());
    }

    const headers = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...getOpenCodeAuthHeaders(),
    };

    const lastEventId = req.header('Last-Event-ID');
    if (typeof lastEventId === 'string' && lastEventId.length > 0) {
      headers['Last-Event-ID'] = lastEventId;
    }

    const controller = new AbortController();
    const cleanup = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      return res.status(502).json({ error: 'Failed to connect to OpenCode event stream' });
    }

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `OpenCode event stream unavailable (${upstream.status})` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const heartbeatInterval = setInterval(() => {
      writeSseEvent(res, { type: 'openchamber:heartbeat', timestamp: Date.now() });
    }, 15000);

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = '';

    const forwardBlock = (block) => {
      if (!block) return;
      res.write(`${block}

`);
      const payload = parseSseDataPayload(block);
      // Cache session titles from session.updated/session.created events (per-session stream)
      maybeCacheSessionInfoFromEvent(payload);

      if (payload && payload.type === 'session.status') {
        const update = extractSessionStatusUpdate(payload);
        if (update) {
          updateSessionState(update.sessionId, update.type, update.eventId || `proxy-${Date.now()}`, {
            attempt: update.attempt,
            message: update.message,
            next: update.next,
          });
        }
      }

      const transitions = deriveSessionActivityTransitions(payload);
      if (transitions && transitions.length > 0) {
        for (const activity of transitions) {
          if (setSessionActivityPhase(activity.sessionId, activity.phase)) {
            writeSseEvent(res, {
              type: 'openchamber:session-activity',
              properties: {
                sessionId: activity.sessionId,
                phase: activity.phase,
              }
            });
          }
        }
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex !== -1) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          forwardBlock(block);
          separatorIndex = buffer.indexOf('\n\n');
        }
      }

      if (buffer.trim().length > 0) {
        forwardBlock(buffer.trim());
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn('SSE proxy stream error:', error);
      }
    } finally {
      clearInterval(heartbeatInterval);
      cleanup();
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  });

  app.get('/api/config/settings', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      res.json(formatSettingsResponse(settings));
    } catch (error) {
      console.error('Failed to load settings:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load settings' });
    }
  });

  app.get('/api/config/opencode-resolution', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const configured = typeof settings?.opencodeBinary === 'string' ? settings.opencodeBinary : null;

      const previousSource = resolvedOpencodeBinarySource;
      const detectedNow = resolveOpencodeCliPath();
      const rawDetectedSourceNow = resolvedOpencodeBinarySource;
      resolvedOpencodeBinarySource = previousSource;

      // Best-effort: apply configured override (if any) and resolve.
      await applyOpencodeBinaryFromSettings();
      ensureOpencodeCliEnv();

      const resolved = resolvedOpencodeBinary || null;
      const source = resolvedOpencodeBinarySource || null;
      const detectedSourceNow =
        detectedNow &&
        resolved &&
        detectedNow === resolved &&
        rawDetectedSourceNow === 'env' &&
        source &&
        source !== 'env'
          ? source
          : rawDetectedSourceNow;
      const shim = resolved ? opencodeShimInterpreter(resolved) : null;

      res.json({
        configured,
        resolved,
        resolvedDir: resolved ? path.dirname(resolved) : null,
        source,
        detectedNow,
        detectedSourceNow,
        shim,
        node: resolvedNodeBinary || null,
        bun: resolvedBunBinary || null,
      });
    } catch (error) {
      console.error('Failed to build opencode resolution snapshot:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to build snapshot' });
    }
  });

  app.get('/api/config/themes', async (_req, res) => {
    try {
      const customThemes = await readCustomThemesFromDisk();
      res.json({ themes: customThemes });
    } catch (error) {
      console.error('Failed to load custom themes:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load custom themes' });
    }
  });

  app.put('/api/config/settings', async (req, res) => {
    console.log(`[API:PUT /api/config/settings] Received request`);
    console.log(`[API:PUT /api/config/settings] Request body:`, JSON.stringify(req.body, null, 2));
    try {
      const updated = await persistSettings(req.body ?? {});
      console.log(`[API:PUT /api/config/settings] Success, returning ${updated.projects?.length || 0} projects`);
      res.json(updated);
    } catch (error) {
      console.error(`[API:PUT /api/config/settings] Failed to save settings:`, error);
      console.error(`[API:PUT /api/config/settings] Error stack:`, error.stack);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to save settings' });
    }
  });

  const {
    getAgentSources,
    getAgentScope,
    getAgentConfig,
    createAgent,
    updateAgent,
    deleteAgent,
    getCommandSources,
    getCommandScope,
    createCommand,
    updateCommand,
    deleteCommand,
    getProviderSources,
    removeProviderConfig,
    AGENT_SCOPE,
    COMMAND_SCOPE,
    listMcpConfigs,
    getMcpConfig,
    createMcpConfig,
    updateMcpConfig,
    deleteMcpConfig,
  } = await import('./lib/opencode/index.js');

  app.get('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getAgentSources(agentName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: agentName,
        sources: sources,
        scope,
        isBuiltIn: !sources.md.exists && !sources.json.exists
      });
    } catch (error) {
      console.error('Failed to get agent sources:', error);
      res.status(500).json({ error: 'Failed to get agent configuration metadata' });
    }
  });

  app.get('/api/config/agents/:name/config', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const configInfo = getAgentConfig(agentName, directory);
      res.json(configInfo);
    } catch (error) {
      console.error('Failed to get agent config:', error);
      res.status(500).json({ error: 'Failed to get agent configuration' });
    }
  });

  app.post('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { scope, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating agent:', agentName);
      console.log('[Server] Config received:', JSON.stringify(config, null, 2));
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      createAgent(agentName, config, directory, scope);
      await refreshOpenCodeAfterConfigChange('agent creation', {
        agentName
      });

      res.json({
        success: true,
        requiresReload: true,
        message: `Agent ${agentName} created successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to create agent:', error);
      res.status(500).json({ error: error.message || 'Failed to create agent' });
    }
  });

  app.patch('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log(`[Server] Updating agent: ${agentName}`);
      console.log('[Server] Updates:', JSON.stringify(updates, null, 2));
      console.log('[Server] Working directory:', directory);

      updateAgent(agentName, updates, directory);
      await refreshOpenCodeAfterConfigChange('agent update');

      console.log(`[Server] Agent ${agentName} updated successfully`);

      res.json({
        success: true,
        requiresReload: true,
        message: `Agent ${agentName} updated successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[Server] Failed to update agent:', error);
      console.error('[Server] Error stack:', error.stack);
      res.status(500).json({ error: error.message || 'Failed to update agent' });
    }
  });

  app.delete('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      deleteAgent(agentName, directory);
      await refreshOpenCodeAfterConfigChange('agent deletion');

      res.json({
        success: true,
        requiresReload: true,
        message: `Agent ${agentName} deleted successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to delete agent:', error);
      res.status(500).json({ error: error.message || 'Failed to delete agent' });
    }
  });

  // ============================================================
  // MCP Config Routes
  // ============================================================

  app.get('/api/config/mcp', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const configs = listMcpConfigs(directory);
      res.json(configs);
    } catch (error) {
      console.error('[API:GET /api/config/mcp] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to list MCP configs' });
    }
  });

  app.get('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const config = getMcpConfig(name, directory);
      if (!config) {
        return res.status(404).json({ error: `MCP server "${name}" not found` });
      }
      res.json(config);
    } catch (error) {
      console.error('[API:GET /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to get MCP config' });
    }
  });

  app.post('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { scope, ...config } = req.body || {};
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:POST /api/config/mcp] Creating MCP server: ${name}`);

      createMcpConfig(name, config, directory, scope);
      await refreshOpenCodeAfterConfigChange('mcp creation', { mcpName: name });

      res.json({
        success: true,
        requiresReload: true,
        message: `MCP server "${name}" created. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[API:POST /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to create MCP server' });
    }
  });

  app.patch('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:PATCH /api/config/mcp] Updating MCP server: ${name}`);

      updateMcpConfig(name, updates, directory);
      await refreshOpenCodeAfterConfigChange('mcp update');

      res.json({
        success: true,
        requiresReload: true,
        message: `MCP server "${name}" updated. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[API:PATCH /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to update MCP server' });
    }
  });

  app.delete('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:DELETE /api/config/mcp] Deleting MCP server: ${name}`);

      deleteMcpConfig(name, directory);
      await refreshOpenCodeAfterConfigChange('mcp deletion');

      res.json({
        success: true,
        requiresReload: true,
        message: `MCP server "${name}" deleted. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[API:DELETE /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: error.message || 'Failed to delete MCP server' });
    }
  });

  app.get('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getCommandSources(commandName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: commandName,
        sources: sources,
        scope,
        isBuiltIn: !sources.md.exists && !sources.json.exists
      });
    } catch (error) {
      console.error('Failed to get command sources:', error);
      res.status(500).json({ error: 'Failed to get command configuration metadata' });
    }
  });

  app.post('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { scope, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating command:', commandName);
      console.log('[Server] Config received:', JSON.stringify(config, null, 2));
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      createCommand(commandName, config, directory, scope);
      await refreshOpenCodeAfterConfigChange('command creation', {
        commandName
      });

      res.json({
        success: true,
        requiresReload: true,
        message: `Command ${commandName} created successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to create command:', error);
      res.status(500).json({ error: error.message || 'Failed to create command' });
    }
  });

  app.patch('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log(`[Server] Updating command: ${commandName}`);
      console.log('[Server] Updates:', JSON.stringify(updates, null, 2));
      console.log('[Server] Working directory:', directory);

      updateCommand(commandName, updates, directory);
      await refreshOpenCodeAfterConfigChange('command update');

      console.log(`[Server] Command ${commandName} updated successfully`);

      res.json({
        success: true,
        requiresReload: true,
        message: `Command ${commandName} updated successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[Server] Failed to update command:', error);
      console.error('[Server] Error stack:', error.stack);
      res.status(500).json({ error: error.message || 'Failed to update command' });
    }
  });

  app.delete('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      deleteCommand(commandName, directory);
      await refreshOpenCodeAfterConfigChange('command deletion');

      res.json({
        success: true,
        requiresReload: true,
        message: `Command ${commandName} deleted successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to delete command:', error);
      res.status(500).json({ error: error.message || 'Failed to delete command' });
    }
  });

  // ============== SKILL ENDPOINTS ==============

  const {
    getSkillSources,
    discoverSkills,
    createSkill,
    updateSkill,
    deleteSkill,
    readSkillSupportingFile,
    writeSkillSupportingFile,
    deleteSkillSupportingFile,
    SKILL_SCOPE,
    SKILL_DIR,
  } = await import('./lib/opencode/index.js');

  const findWorktreeRootForSkills = (workingDirectory) => {
    if (!workingDirectory) return null;
    let current = path.resolve(workingDirectory);
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  };

  const getSkillProjectAncestors = (workingDirectory) => {
    if (!workingDirectory) return [];
    const result = [];
    let current = path.resolve(workingDirectory);
    const stop = findWorktreeRootForSkills(workingDirectory) || current;
    while (true) {
      result.push(current);
      if (current === stop) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return result;
  };

  const isPathInside = (candidatePath, parentPath) => {
    if (!candidatePath || !parentPath) return false;
    const normalizedCandidate = path.resolve(candidatePath);
    const normalizedParent = path.resolve(parentPath);
    return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
  };

  const inferSkillScopeAndSourceFromPath = (skillPath, workingDirectory) => {
    const resolvedPath = typeof skillPath === 'string' ? path.resolve(skillPath) : '';
    const home = os.homedir();
    const source = resolvedPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
      ? 'agents'
      : resolvedPath.includes(`${path.sep}.claude${path.sep}skills${path.sep}`)
        ? 'claude'
        : 'opencode';

    const projectAncestors = getSkillProjectAncestors(workingDirectory);
    const isProjectScoped = projectAncestors.some((ancestor) => {
      const candidates = [
        path.join(ancestor, '.opencode'),
        path.join(ancestor, '.claude', 'skills'),
        path.join(ancestor, '.agents', 'skills'),
      ];
      return candidates.some((candidate) => isPathInside(resolvedPath, candidate));
    });

    if (isProjectScoped) {
      return { scope: SKILL_SCOPE.PROJECT, source };
    }

    const userRoots = [
      path.join(home, '.config', 'opencode'),
      path.join(home, '.opencode'),
      path.join(home, '.claude', 'skills'),
      path.join(home, '.agents', 'skills'),
      process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null,
    ].filter(Boolean);

    if (userRoots.some((root) => isPathInside(resolvedPath, root))) {
      return { scope: SKILL_SCOPE.USER, source };
    }

    return { scope: SKILL_SCOPE.USER, source };
  };

  const fetchOpenCodeDiscoveredSkills = async (workingDirectory) => {
    if (!openCodePort) {
      return null;
    }

    try {
      const url = new URL(buildOpenCodeUrl('/skill', ''));
      if (workingDirectory) {
        url.searchParams.set('directory', workingDirectory);
      }

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        return null;
      }

      return payload
        .map((item) => {
          const name = typeof item?.name === 'string' ? item.name.trim() : '';
          const location = typeof item?.location === 'string' ? item.location : '';
          const description = typeof item?.description === 'string' ? item.description : '';
          if (!name || !location) {
            return null;
          }
          const inferred = inferSkillScopeAndSourceFromPath(location, workingDirectory);
          return {
            name,
            path: location,
            scope: inferred.scope,
            source: inferred.source,
            description,
          };
        })
        .filter(Boolean);
    } catch {
      return null;
    }
  };

  // List all discovered skills
  app.get('/api/config/skills', async (req, res) => {
    try {
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const skills = (await fetchOpenCodeDiscoveredSkills(directory)) || discoverSkills(directory);

      // Enrich with full sources info
      const enrichedSkills = skills.map(skill => {
        const sources = getSkillSources(skill.name, directory, skill);
        return {
          ...skill,
          sources
        };
      });

      res.json({ skills: enrichedSkills });
    } catch (error) {
      console.error('Failed to list skills:', error);
      res.status(500).json({ error: 'Failed to list skills' });
    }
  });

  // ============== SKILLS CATALOG + INSTALL ENDPOINTS ==============

  const { getCuratedSkillsSources } = await import('./lib/skills-catalog/curated-sources.js');
  const { getCacheKey, getCachedScan, setCachedScan } = await import('./lib/skills-catalog/cache.js');
  const { parseSkillRepoSource } = await import('./lib/skills-catalog/source.js');
  const { scanSkillsRepository } = await import('./lib/skills-catalog/scan.js');
  const { installSkillsFromRepository } = await import('./lib/skills-catalog/install.js');
  const { scanClawdHubPage, installSkillsFromClawdHub, isClawdHubSource } = await import('./lib/skills-catalog/clawdhub/index.js');
  const { getProfiles, getProfile } = await import('./lib/git/index.js');

  const listGitIdentitiesForResponse = () => {
    try {
      const profiles = getProfiles();
      return profiles.map((p) => ({ id: p.id, name: p.name }));
    } catch {
      return [];
    }
  };

  const resolveGitIdentity = (profileId) => {
    if (!profileId) {
      return null;
    }
    try {
      const profile = getProfile(profileId);
      const sshKey = profile?.sshKey;
      if (typeof sshKey === 'string' && sshKey.trim()) {
        return { sshKey: sshKey.trim() };
      }
    } catch {
      // ignore
    }
    return null;
  };

  app.get('/api/config/skills/catalog', async (req, res) => {
    try {
      const { error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];
      const sourcesForUi = sources.map(({ gitIdentityId, ...rest }) => rest);

      res.json({ ok: true, sources: sourcesForUi, itemsBySource: {}, pageInfoBySource: {} });
    } catch (error) {
      console.error('Failed to load skills catalog:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to load catalog' } });
    }
  });

  app.get('/api/config/skills/catalog/source', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: error } });
      }

      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : null;
      if (!sourceId) {
        return res.status(400).json({ ok: false, error: { kind: 'invalidSource', message: 'Missing sourceId' } });
      }

      const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

      const curatedSources = getCuratedSkillsSources();
      const settings = await readSettingsFromDisk();
      const customSourcesRaw = sanitizeSkillCatalogs(settings.skillCatalogs) || [];

      const customSources = customSourcesRaw.map((entry) => ({
        id: entry.id,
        label: entry.label,
        description: entry.source,
        source: entry.source,
        defaultSubpath: entry.subpath,
        gitIdentityId: entry.gitIdentityId,
      }));

      const sources = [...curatedSources, ...customSources];
      const src = sources.find((entry) => entry.id === sourceId);

      if (!src) {
        return res.status(404).json({ ok: false, error: { kind: 'invalidSource', message: 'Unknown source' } });
      }

      const discovered = directory
        ? ((await fetchOpenCodeDiscoveredSkills(directory)) || discoverSkills(directory))
        : [];
      const installedByName = new Map(discovered.map((s) => [s.name, s]));

      if (src.sourceType === 'clawdhub' || isClawdHubSource(src.source)) {
        const scanned = await scanClawdHubPage({ cursor: cursor || null });
        if (!scanned.ok) {
          return res.status(500).json({ ok: false, error: scanned.error });
        }

        const items = (scanned.items || []).map((item) => {
          const installed = installedByName.get(item.skillName);
          return {
            ...item,
            sourceId: src.id,
            installed: installed
              ? { isInstalled: true, scope: installed.scope, source: installed.source }
              : { isInstalled: false },
          };
        });

        return res.json({ ok: true, items, nextCursor: scanned.nextCursor || null });
      }

      const parsed = parseSkillRepoSource(src.source);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, error: parsed.error });
      }

      const effectiveSubpath = src.defaultSubpath || parsed.effectiveSubpath || null;
      const cacheKey = getCacheKey({
        normalizedRepo: parsed.normalizedRepo,
        subpath: effectiveSubpath || '',
        identityId: src.gitIdentityId || '',
      });

      let scanResult = !refresh ? getCachedScan(cacheKey) : null;
      if (!scanResult) {
        const scanned = await scanSkillsRepository({
          source: src.source,
          subpath: src.defaultSubpath,
          defaultSubpath: src.defaultSubpath,
          identity: resolveGitIdentity(src.gitIdentityId),
        });

        if (!scanned.ok) {
          return res.status(500).json({ ok: false, error: scanned.error });
        }

        scanResult = scanned;
        setCachedScan(cacheKey, scanResult);
      }

      const items = (scanResult.items || []).map((item) => {
        const installed = installedByName.get(item.skillName);
        return {
          sourceId: src.id,
          ...item,
          gitIdentityId: src.gitIdentityId,
          installed: installed
            ? { isInstalled: true, scope: installed.scope, source: installed.source }
            : { isInstalled: false },
        };
      });

      return res.json({ ok: true, items });
    } catch (error) {
      console.error('Failed to load catalog source:', error);
      return res.status(500).json({
        ok: false,
        error: { kind: 'unknown', message: error.message || 'Failed to load catalog source' },
      });
    }
  });

  app.post('/api/config/skills/scan', async (req, res) => {
    try {
      const { source, subpath, gitIdentityId } = req.body || {};
      const identity = resolveGitIdentity(gitIdentityId);

      const result = await scanSkillsRepository({
        source,
        subpath,
        identity,
      });

      if (!result.ok) {
        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      res.json({ ok: true, items: result.items });
    } catch (error) {
      console.error('Failed to scan skills repository:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to scan repository' } });
    }
  });

  app.post('/api/config/skills/install', async (req, res) => {
    try {
      const {
        source,
        subpath,
        gitIdentityId,
        scope,
        targetSource,
        selections,
        conflictPolicy,
        conflictDecisions,
      } = req.body || {};

      let workingDirectory = null;
      if (scope === 'project') {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({
            ok: false,
            error: { kind: 'invalidSource', message: resolved.error || 'Project installs require a directory parameter' },
          });
        }
        workingDirectory = resolved.directory;
      }

      // Handle ClawdHub sources (ZIP download based)
      if (isClawdHubSource(source)) {
        const result = await installSkillsFromClawdHub({
          scope,
          targetSource,
          workingDirectory,
          userSkillDir: SKILL_DIR,
          selections,
          conflictPolicy,
          conflictDecisions,
        });

        if (!result.ok) {
          if (result.error?.kind === 'conflicts') {
            return res.status(409).json({ ok: false, error: result.error });
          }
          return res.status(400).json({ ok: false, error: result.error });
        }

        const installed = result.installed || [];
        const skipped = result.skipped || [];
        const requiresReload = installed.length > 0;

        if (requiresReload) {
          await refreshOpenCodeAfterConfigChange('skills install');
        }

        return res.json({
          ok: true,
          installed,
          skipped,
          requiresReload,
          message: requiresReload ? 'Skills installed successfully. Reloading interface…' : 'No skills were installed',
          reloadDelayMs: requiresReload ? CLIENT_RELOAD_DELAY_MS : undefined,
        });
      }

      // Handle GitHub sources (git clone based)
      const identity = resolveGitIdentity(gitIdentityId);

      const result = await installSkillsFromRepository({
        source,
        subpath,
        identity,
        scope,
        targetSource,
        workingDirectory,
        userSkillDir: SKILL_DIR,
        selections,
        conflictPolicy,
        conflictDecisions,
      });

      if (!result.ok) {
        if (result.error?.kind === 'conflicts') {
          return res.status(409).json({ ok: false, error: result.error });
        }

        if (result.error?.kind === 'authRequired') {
          return res.status(401).json({
            ok: false,
            error: {
              ...result.error,
              identities: listGitIdentitiesForResponse(),
            },
          });
        }

        return res.status(400).json({ ok: false, error: result.error });
      }

      const installed = result.installed || [];
      const skipped = result.skipped || [];
      const requiresReload = installed.length > 0;

      if (requiresReload) {
        await refreshOpenCodeAfterConfigChange('skills install');
      }

      res.json({
        ok: true,
        installed,
        skipped,
        requiresReload,
        message: requiresReload ? 'Skills installed successfully. Reloading interface…' : 'No skills were installed',
        reloadDelayMs: requiresReload ? CLIENT_RELOAD_DELAY_MS : undefined,
      });
    } catch (error) {
      console.error('Failed to install skills:', error);
      res.status(500).json({ ok: false, error: { kind: 'unknown', message: error.message || 'Failed to install skills' } });
    }
  });

  // Get single skill sources
  app.get('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) || [])
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);

      res.json({
        name: skillName,
        sources: sources,
        scope: sources.md.scope,
        source: sources.md.source,
        exists: sources.md.exists
      });
    } catch (error) {
      console.error('Failed to get skill sources:', error);
      res.status(500).json({ error: 'Failed to get skill configuration metadata' });
    }
  });

  // Get skill supporting file content
  app.get('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath); // Decode URL-encoded path
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

        const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) || [])
          .find((skill) => skill.name === skillName) || null;
        const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      const content = readSkillSupportingFile(sources.md.dir, filePath);
      if (content === null) {
        return res.status(404).json({ error: 'File not found' });
      }

      res.json({ path: filePath, content });
    } catch (error) {
      console.error('Failed to read skill file:', error);
      res.status(500).json({ error: 'Failed to read skill file' });
    }
  });

  // Create new skill
  app.post('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { scope, source: skillSource, ...config } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating skill:', skillName);
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      createSkill(skillName, { ...config, source: skillSource }, directory, scope);
      await refreshOpenCodeAfterConfigChange('skill creation');

      res.json({
        success: true,
        requiresReload: true,
        message: `Skill ${skillName} created successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to create skill:', error);
      res.status(500).json({ error: error.message || 'Failed to create skill' });
    }
  });

  // Update existing skill
  app.patch('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log(`[Server] Updating skill: ${skillName}`);
      console.log('[Server] Working directory:', directory);

      updateSkill(skillName, updates, directory);
      await refreshOpenCodeAfterConfigChange('skill update');

      res.json({
        success: true,
        requiresReload: true,
        message: `Skill ${skillName} updated successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[Server] Failed to update skill:', error);
      res.status(500).json({ error: error.message || 'Failed to update skill' });
    }
  });

  // Update/create supporting file
  app.put('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath); // Decode URL-encoded path
      const { content } = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) || [])
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      writeSkillSupportingFile(sources.md.dir, filePath, content || '');

      res.json({
        success: true,
        message: `File ${filePath} saved successfully`,
      });
    } catch (error) {
      console.error('Failed to write skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to write skill file' });
    }
  });

  // Delete supporting file
  app.delete('/api/config/skills/:name/files/*filePath', async (req, res) => {
    try {
      const skillName = req.params.name;
      const filePath = decodeURIComponent(req.params.filePath); // Decode URL-encoded path
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const discoveredSkill = ((await fetchOpenCodeDiscoveredSkills(directory)) || [])
        .find((skill) => skill.name === skillName) || null;
      const sources = getSkillSources(skillName, directory, discoveredSkill);
      if (!sources.md.exists || !sources.md.dir) {
        return res.status(404).json({ error: 'Skill not found' });
      }

      deleteSkillSupportingFile(sources.md.dir, filePath);

      res.json({
        success: true,
        message: `File ${filePath} deleted successfully`,
      });
    } catch (error) {
      console.error('Failed to delete skill file:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill file' });
    }
  });

  // Delete skill
  app.delete('/api/config/skills/:name', async (req, res) => {
    try {
      const skillName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      deleteSkill(skillName, directory);
      await refreshOpenCodeAfterConfigChange('skill deletion');

      res.json({
        success: true,
        requiresReload: true,
        message: `Skill ${skillName} deleted successfully. Reloading interface…`,
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('Failed to delete skill:', error);
      res.status(500).json({ error: error.message || 'Failed to delete skill' });
    }
  });

  app.post('/api/config/reload', async (req, res) => {
    try {
      console.log('[Server] Manual configuration reload requested');

      await refreshOpenCodeAfterConfigChange('manual configuration reload');

      res.json({
        success: true,
        requiresReload: true,
        message: 'Configuration reloaded successfully. Refreshing interface…',
        reloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      });
    } catch (error) {
      console.error('[Server] Failed to reload configuration:', error);
      res.status(500).json({
        error: error.message || 'Failed to reload configuration',
        success: false
      });
    }
  });

  let authLibrary = null;
  const getAuthLibrary = async () => {
    if (!authLibrary) {
      authLibrary = await import('./lib/opencode/auth.js');
    }
    return authLibrary;
  };

  let quotaProviders = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('./lib/quota/index.js');
    }
    return quotaProviders;
  };

  // ================= GitHub OAuth (Device Flow) =================

  // Note: scopes may be overridden via OPENCHAMBER_GITHUB_SCOPES or settings.json (see lib/github/auth.js).

  let githubLibraries = null;
  const getGitHubLibraries = async () => {
    if (!githubLibraries) {
      githubLibraries = await import('./lib/github/index.js');
    }
    return githubLibraries;
  };

  const getGitHubUserSummary = async (octokit) => {
    const me = await octokit.rest.users.getAuthenticated();

    let email = typeof me.data.email === 'string' ? me.data.email : null;
    if (!email) {
      try {
        const emails = await octokit.rest.users.listEmailsForAuthenticatedUser({ per_page: 100 });
        const list = Array.isArray(emails?.data) ? emails.data : [];
        const primaryVerified = list.find((e) => e && e.primary && e.verified && typeof e.email === 'string');
        const anyVerified = list.find((e) => e && e.verified && typeof e.email === 'string');
        email = primaryVerified?.email || anyVerified?.email || null;
      } catch {
        // ignore (scope might be missing)
      }
    }

    return {
      login: me.data.login,
      id: me.data.id,
      avatarUrl: me.data.avatar_url,
      name: typeof me.data.name === 'string' ? me.data.name : null,
      email,
    };
  };

  app.get('/api/github/auth/status', async (_req, res) => {
    try {
      const { getGitHubAuth, getOctokitOrNull, clearGitHubAuth, getGitHubAuthAccounts } = await getGitHubLibraries();
      const auth = getGitHubAuth();
      const accounts = getGitHubAuthAccounts();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts });
      }

      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false, accounts });
      }

      let user = null;
      try {
        user = await getGitHubUserSummary(octokit);
      } catch (error) {
        if (error?.status === 401) {
          clearGitHubAuth();
          return res.json({ connected: false, accounts: getGitHubAuthAccounts() });
        }
      }

      const fallback = auth.user;
      const mergedUser = user || fallback;

      return res.json({
        connected: true,
        user: mergedUser,
        scope: auth.scope,
        accounts,
      });
    } catch (error) {
      console.error('Failed to get GitHub auth status:', error);
      return res.status(500).json({ error: error.message || 'Failed to get GitHub auth status' });
    }
  });

  app.post('/api/github/auth/start', async (_req, res) => {
    try {
      const { getGitHubClientId, getGitHubScopes, startDeviceFlow } = await getGitHubLibraries();
      const clientId = getGitHubClientId();
      if (!clientId) {
        return res.status(400).json({
          error: 'GitHub OAuth client not configured. Set OPENCHAMBER_GITHUB_CLIENT_ID.',
        });
      }

      const scope = getGitHubScopes();

      const payload = await startDeviceFlow({
        clientId,
        scope,
      });

      return res.json({
        deviceCode: payload.device_code,
        userCode: payload.user_code,
        verificationUri: payload.verification_uri,
        verificationUriComplete: payload.verification_uri_complete,
        expiresIn: payload.expires_in,
        interval: payload.interval,
        scope,
      });
    } catch (error) {
      console.error('Failed to start GitHub device flow:', error);
      return res.status(500).json({ error: error.message || 'Failed to start GitHub device flow' });
    }
  });

  app.post('/api/github/auth/complete', async (req, res) => {
    try {
      const { getGitHubClientId, exchangeDeviceCode, setGitHubAuth, getGitHubAuthAccounts } = await getGitHubLibraries();
      const clientId = getGitHubClientId();
      if (!clientId) {
        return res.status(400).json({
          error: 'GitHub OAuth client not configured. Set OPENCHAMBER_GITHUB_CLIENT_ID.',
        });
      }

      const deviceCode = typeof req.body?.deviceCode === 'string'
        ? req.body.deviceCode
        : (typeof req.body?.device_code === 'string' ? req.body.device_code : '');

      if (!deviceCode) {
        return res.status(400).json({ error: 'deviceCode is required' });
      }

      const payload = await exchangeDeviceCode({ clientId, deviceCode });

      if (payload?.error) {
        return res.json({
          connected: false,
          status: payload.error,
          error: payload.error_description || payload.error,
        });
      }

      const accessToken = payload?.access_token;
      if (!accessToken) {
        return res.status(500).json({ error: 'Missing access_token from GitHub' });
      }

      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: accessToken });
      const user = await getGitHubUserSummary(octokit);

      setGitHubAuth({
        accessToken,
        scope: typeof payload.scope === 'string' ? payload.scope : '',
        tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'bearer',
        user,
      });

      return res.json({
        connected: true,
        user,
        scope: typeof payload.scope === 'string' ? payload.scope : '',
        accounts: getGitHubAuthAccounts(),
      });
    } catch (error) {
      console.error('Failed to complete GitHub device flow:', error);
      return res.status(500).json({ error: error.message || 'Failed to complete GitHub device flow' });
    }
  });

  app.post('/api/github/auth/activate', async (req, res) => {
    try {
      const { activateGitHubAuth, getGitHubAuth, getOctokitOrNull, clearGitHubAuth, getGitHubAuthAccounts } = await getGitHubLibraries();
      const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : '';
      if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
      }
      const activated = activateGitHubAuth(accountId);
      if (!activated) {
        return res.status(404).json({ error: 'GitHub account not found' });
      }

      const auth = getGitHubAuth();
      const accounts = getGitHubAuthAccounts();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts });
      }

      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false, accounts });
      }

      let user = auth.user || null;
      try {
        user = await getGitHubUserSummary(octokit);
      } catch (error) {
        if (error?.status === 401) {
          clearGitHubAuth();
          return res.json({ connected: false, accounts: getGitHubAuthAccounts() });
        }
      }

      return res.json({
        connected: true,
        user,
        scope: auth.scope,
        accounts,
      });
    } catch (error) {
      console.error('Failed to activate GitHub account:', error);
      return res.status(500).json({ error: error.message || 'Failed to activate GitHub account' });
    }
  });

  app.delete('/api/github/auth', async (_req, res) => {
    try {
      const { clearGitHubAuth } = await getGitHubLibraries();
      const removed = clearGitHubAuth();
      return res.json({ success: true, removed });
    } catch (error) {
      console.error('Failed to disconnect GitHub:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect GitHub' });
    }
  });

  app.get('/api/github/me', async (_req, res) => {
    try {
      const { getOctokitOrNull, clearGitHubAuth } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }
      let user;
      try {
        user = await getGitHubUserSummary(octokit);
      } catch (error) {
        if (error?.status === 401) {
          clearGitHubAuth();
          return res.status(401).json({ error: 'GitHub token expired or revoked' });
        }
        throw error;
      }
      return res.json(user);
    } catch (error) {
      console.error('Failed to fetch GitHub user:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitHub user' });
    }
  });

  // ================= GitHub PR APIs =================

  app.get('/api/github/pr/status', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const branch = typeof req.query?.branch === 'string' ? req.query.branch.trim() : '';
      const remote = typeof req.query?.remote === 'string' ? req.query.remote.trim() : 'origin';
      if (!directory || !branch) {
        return res.status(400).json({ error: 'directory and branch are required' });
      }

      const { getOctokitOrNull, getGitHubAuth } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory, remote);
      if (!repo) {
        return res.json({ connected: true, repo: null, branch, pr: null, checks: null, canMerge: false });
      }

       // Determine the head owner for PR search
       // Priority: 1) tracking branch remote, 2) origin (if different from target), 3) target repo owner
       let headOwnerForSearch = null;
       
       // First, check the branch's tracking info to see which remote it's on
       const { getStatus } = await import('./lib/git/index.js');
       const status = await getStatus(directory).catch(() => null);
       if (status?.tracking) {
         const trackingRemote = status.tracking.split('/')[0];
         if (trackingRemote && trackingRemote !== remote) {
           // Branch is tracked on a different remote - get that remote's owner
           const { repo: trackingRepo } = await resolveGitHubRepoFromDirectory(directory, trackingRemote);
           if (trackingRepo && trackingRepo.owner !== repo.owner) {
             headOwnerForSearch = trackingRepo.owner;
           }
         }
       }
       
       // Fallback: if targeting non-origin, check if origin has a different owner (fork scenario)
       if (!headOwnerForSearch && remote !== 'origin') {
         const { repo: originRepo } = await resolveGitHubRepoFromDirectory(directory, 'origin');
         if (originRepo && originRepo.owner !== repo.owner) {
           headOwnerForSearch = originRepo.owner;
         }
       }

       const listByHead = async (state, headOwner = repo.owner) => {
         const resp = await octokit.rest.pulls.list({
           owner: repo.owner,
           repo: repo.repo,
           state,
           head: `${headOwner}:${branch}`,
           per_page: 10,
         });
         return Array.isArray(resp?.data) ? resp.data[0] : null;
       };

       const listByHeadRef = async (state) => {
         const resp = await octokit.rest.pulls.list({
           owner: repo.owner,
           repo: repo.repo,
           state,
           per_page: 100,
         });
         const matches = Array.isArray(resp?.data)
           ? resp.data.filter((pr) => pr?.head?.ref === branch)
           : [];
         return matches[0] ?? null;
       };

       // PR status by branch:
       // - Prefer open PRs.
       // - If none, also surface closed/merged PRs.
       // - For cross-repo PRs: first try with head owner, then fall back to target owner, then ref match.
       let first = null;
       
       // For cross-repo workflows, try head owner first
       if (headOwnerForSearch) {
         first = await listByHead('open', headOwnerForSearch);
         if (!first) first = await listByHead('closed', headOwnerForSearch);
       }
       
       // Try with target repo owner (same-repo PRs)
       if (!first) first = await listByHead('open');
       if (!first) first = await listByHead('closed');
       
       // Fall back to matching head.ref directly (handles edge cases)
       if (!first) first = await listByHeadRef('open');
       if (!first) first = await listByHeadRef('closed');
      if (!first) {
        return res.json({ connected: true, repo, branch, pr: null, checks: null, canMerge: false });
      }

      // Enrich with mergeability fields
      const prFull = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: first.number });
      const prData = prFull?.data;
      if (!prData) {
        return res.json({ connected: true, repo, branch, pr: null, checks: null, canMerge: false });
      }

      // Checks summary: prefer check-runs (Actions), fallback to classic statuses.
      let checks = null;
      const sha = prData.head?.sha;
      if (sha) {
        try {
          const runs = await octokit.rest.checks.listForRef({
            owner: repo.owner,
            repo: repo.repo,
            ref: sha,
            per_page: 100,
          });
          const checkRuns = Array.isArray(runs?.data?.check_runs) ? runs.data.check_runs : [];
          if (checkRuns.length > 0) {
            const counts = { success: 0, failure: 0, pending: 0 };
            for (const run of checkRuns) {
              const status = run?.status;
              const conclusion = run?.conclusion;
              if (status === 'queued' || status === 'in_progress') {
                counts.pending += 1;
                continue;
              }
              if (!conclusion) {
                counts.pending += 1;
                continue;
              }
              if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
                counts.success += 1;
              } else {
                counts.failure += 1;
              }
            }
            const total = counts.success + counts.failure + counts.pending;
            const state = counts.failure > 0
              ? 'failure'
              : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
            checks = { state, total, ...counts };
          }
        } catch {
          // ignore and fall back
        }

        if (!checks) {
          try {
            const combined = await octokit.rest.repos.getCombinedStatusForRef({
              owner: repo.owner,
              repo: repo.repo,
              ref: sha,
            });
            const statuses = Array.isArray(combined?.data?.statuses) ? combined.data.statuses : [];
            const counts = { success: 0, failure: 0, pending: 0 };
            statuses.forEach((s) => {
              if (s.state === 'success') counts.success += 1;
              else if (s.state === 'failure' || s.state === 'error') counts.failure += 1;
              else if (s.state === 'pending') counts.pending += 1;
            });
            const total = counts.success + counts.failure + counts.pending;
            const state = counts.failure > 0
              ? 'failure'
              : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
            checks = { state, total, ...counts };
          } catch {
            checks = null;
          }
        }
      }

      // Permission check (best-effort)
      let canMerge = false;
      try {
        const auth = getGitHubAuth();
        const username = auth?.user?.login;
        if (username) {
          const perm = await octokit.rest.repos.getCollaboratorPermissionLevel({
            owner: repo.owner,
            repo: repo.repo,
            username,
          });
          const level = perm?.data?.permission;
          canMerge = level === 'admin' || level === 'maintain' || level === 'write';
        }
      } catch {
        canMerge = false;
      }

       const isMerged = Boolean(prData.merged || prData.merged_at);
       const mergedState = isMerged ? 'merged' : (prData.state === 'closed' ? 'closed' : 'open');

      return res.json({
        connected: true,
        repo,
        branch,
        pr: {
          number: prData.number,
          title: prData.title,
          body: prData.body || '',
          url: prData.html_url,
          state: mergedState,
          draft: Boolean(prData.draft),
          base: prData.base?.ref,
          head: prData.head?.ref,
          headSha: prData.head?.sha,
          mergeable: prData.mergeable,
          mergeableState: prData.mergeable_state,
        },
        checks,
        canMerge,
      });
    } catch (error) {
      if (error?.status === 401) {
        const { clearGitHubAuth } = await getGitHubLibraries();
        clearGitHubAuth();
        return res.json({ connected: false });
      }
      console.error('Failed to load GitHub PR status:', error);
      return res.status(500).json({ error: error.message || 'Failed to load GitHub PR status' });
    }
  });

  app.post('/api/github/pr/create', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const head = typeof req.body?.head === 'string' ? req.body.head.trim() : '';
      const requestedBase = typeof req.body?.base === 'string' ? req.body.base.trim() : '';
      const body = typeof req.body?.body === 'string' ? req.body.body : undefined;
      const draft = typeof req.body?.draft === 'boolean' ? req.body.draft : undefined;
      // remote = target repo (where PR is created, e.g., 'upstream' for forks)
      const remote = typeof req.body?.remote === 'string' ? req.body.remote.trim() : 'origin';
      // headRemote = source repo (where head branch lives, e.g., 'origin' for forks)
      const headRemote = typeof req.body?.headRemote === 'string' ? req.body.headRemote.trim() : '';
      if (!directory || !title || !head || !requestedBase) {
        return res.status(400).json({ error: 'directory, title, head, base are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory, remote);
      if (!repo) {
        return res.status(400).json({ error: 'Unable to resolve GitHub repo from git remote' });
      }

      const normalizeBranchRef = (value, remoteNames = new Set()) => {
        if (!value) {
          return value;
        }
        let normalized = value.trim();
        if (normalized.startsWith('refs/heads/')) {
          normalized = normalized.substring('refs/heads/'.length);
        }
        if (normalized.startsWith('heads/')) {
          normalized = normalized.substring('heads/'.length);
        }
        if (normalized.startsWith('remotes/')) {
          normalized = normalized.substring('remotes/'.length);
        }

        const slashIndex = normalized.indexOf('/');
        if (slashIndex > 0) {
          const maybeRemote = normalized.slice(0, slashIndex);
          if (remoteNames.has(maybeRemote)) {
            const withoutRemotePrefix = normalized.slice(slashIndex + 1).trim();
            if (withoutRemotePrefix) {
              normalized = withoutRemotePrefix;
            }
          }
        }

        return normalized;
      };

      // Determine the source remote for the head branch
      // Priority: 1) explicit headRemote, 2) tracking branch remote, 3) 'origin' if targeting non-origin
      let sourceRemote = headRemote;
      const { getStatus, getRemotes } = await import('./lib/git/index.js');
      
      // If no explicit headRemote, check the branch's tracking info
      if (!sourceRemote) {
        const status = await getStatus(directory).catch(() => null);
        if (status?.tracking) {
          // tracking is like "gsxdsm/fix/multi-remote-branch-creation" or "origin/main"
          const trackingRemote = status.tracking.split('/')[0];
          if (trackingRemote) {
            sourceRemote = trackingRemote;
          }
        }
      }
      
      // Fallback: if targeting non-origin and no tracking info, try 'origin'
      if (!sourceRemote && remote !== 'origin') {
        sourceRemote = 'origin';
      }

      const remoteNames = new Set([remote]);
      const remotes = await getRemotes(directory).catch(() => []);
      for (const item of remotes) {
        if (item?.name) {
          remoteNames.add(item.name);
        }
      }
      if (sourceRemote) {
        remoteNames.add(sourceRemote);
      }

      const base = normalizeBranchRef(requestedBase, remoteNames);
      if (!base) {
        return res.status(400).json({ error: 'Invalid base branch name' });
      }

      // For fork workflows: we need to determine the correct head reference
      let headRef = head;
      
      if (sourceRemote && sourceRemote !== remote) {
        // The branch is on a different remote than the target - this is a cross-repo PR
        const { repo: headRepo } = await resolveGitHubRepoFromDirectory(directory, sourceRemote);
        if (headRepo) {
          // Always use owner:branch format for cross-repo PRs
          // GitHub API requires this when head is from a different repo/fork
          if (headRepo.owner !== repo.owner || headRepo.repo !== repo.repo) {
            headRef = `${headRepo.owner}:${head}`;
          }
        }
      }

      // For cross-repo PRs, verify the branch exists on the head repo first
      if (headRef.includes(':')) {
        const [headOwner] = headRef.split(':');
        const headRepoName = sourceRemote 
          ? (await resolveGitHubRepoFromDirectory(directory, sourceRemote)).repo?.repo 
          : repo.repo;
        
        if (headRepoName) {
          try {
            await octokit.rest.repos.getBranch({
              owner: headOwner,
              repo: headRepoName,
              branch: head,
            });
          } catch (branchError) {
            if (branchError?.status === 404) {
              return res.status(400).json({
                error: `Branch "${head}" not found on ${headOwner}/${headRepoName}. Please push your branch first: git push ${sourceRemote || 'origin'} ${head}`,
              });
            }
            // For other errors, continue - let the PR create attempt handle it
          }
        }
      }

      const created = await octokit.rest.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        title,
        head: headRef,
        base,
        ...(typeof body === 'string' ? { body } : {}),
        ...(typeof draft === 'boolean' ? { draft } : {}),
      });

      const pr = created?.data;
      if (!pr) {
        return res.status(500).json({ error: 'Failed to create PR' });
      }

      return res.json({
        number: pr.number,
        title: pr.title,
        body: pr.body || '',
        url: pr.html_url,
        state: pr.state === 'closed' ? 'closed' : 'open',
        draft: Boolean(pr.draft),
        base: pr.base?.ref,
        head: pr.head?.ref,
        headSha: pr.head?.sha,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
      });
    } catch (error) {
      console.error('Failed to create GitHub PR:', error);
      
      // Check for head validation error (common with fork PRs)
      const errorMessage = error.message || '';
      const isHeadValidationError = 
        errorMessage.includes('Validation Failed') && 
        errorMessage.includes('"field":"head"') &&
        errorMessage.includes('"code":"invalid"');
      
      if (isHeadValidationError) {
        return res.status(400).json({ 
          error: 'Unable to create PR: You must have write access to the source repository. Make sure you have pushed your branch to a repository you own (your fork), and that the branch exists on the remote.' 
        });
      }
      
      return res.status(500).json({ error: error.message || 'Failed to create GitHub PR' });
    }
  });

  app.post('/api/github/pr/update', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const body = typeof req.body?.body === 'string' ? req.body.body : undefined;
      if (!directory || !number || !title) {
        return res.status(400).json({ error: 'directory, number, title are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.status(400).json({ error: 'Unable to resolve GitHub repo from git remote' });
      }

      let updated;
      try {
        updated = await octokit.rest.pulls.update({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          title,
          ...(typeof body === 'string' ? { body } : {}),
        });
      } catch (error) {
        if (error?.status === 401) {
          return res.status(401).json({ error: 'GitHub not connected' });
        }
        if (error?.status === 403) {
          return res.status(403).json({ error: 'Not authorized to edit this PR' });
        }
        if (error?.status === 404) {
          return res.status(404).json({ error: 'PR not found in this repository' });
        }
        if (error?.status === 422) {
          const apiMessage = error?.response?.data?.message;
          const firstError = Array.isArray(error?.response?.data?.errors) && error.response.data.errors.length > 0
            ? (error.response.data.errors[0]?.message || error.response.data.errors[0]?.code)
            : null;
          const message = [apiMessage, firstError].filter(Boolean).join(' · ') || 'Invalid PR update payload';
          return res.status(422).json({ error: message });
        }
        throw error;
      }

      const pr = updated?.data;
      if (!pr) {
        return res.status(500).json({ error: 'Failed to update PR' });
      }

      return res.json({
        number: pr.number,
        title: pr.title,
        body: pr.body || '',
        url: pr.html_url,
        state: pr.merged_at ? 'merged' : (pr.state === 'closed' ? 'closed' : 'open'),
        draft: Boolean(pr.draft),
        base: pr.base?.ref,
        head: pr.head?.ref,
        headSha: pr.head?.sha,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
      });
    } catch (error) {
      console.error('Failed to update GitHub PR:', error);
      return res.status(500).json({ error: error.message || 'Failed to update GitHub PR' });
    }
  });

  app.post('/api/github/pr/merge', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      const method = typeof req.body?.method === 'string' ? req.body.method : 'merge';
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.status(400).json({ error: 'Unable to resolve GitHub repo from git remote' });
      }

      try {
        const result = await octokit.rest.pulls.merge({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          merge_method: method,
        });
        return res.json({ merged: Boolean(result?.data?.merged), message: result?.data?.message });
      } catch (error) {
        if (error?.status === 403) {
          return res.status(403).json({ error: 'Not authorized to merge this PR' });
        }
        if (error?.status === 405 || error?.status === 409) {
          return res.json({ merged: false, message: error?.message || 'PR not mergeable' });
        }
        throw error;
      }
    } catch (error) {
      console.error('Failed to merge GitHub PR:', error);
      return res.status(500).json({ error: error.message || 'Failed to merge GitHub PR' });
    }
  });

  app.post('/api/github/pr/ready', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
      const number = typeof req.body?.number === 'number' ? req.body.number : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.status(401).json({ error: 'GitHub not connected' });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.status(400).json({ error: 'Unable to resolve GitHub repo from git remote' });
      }

      const pr = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number });
      const nodeId = pr?.data?.node_id;
      if (!nodeId) {
        return res.status(500).json({ error: 'Failed to resolve PR node id' });
      }

      if (pr?.data?.draft === false) {
        return res.json({ ready: true });
      }

      try {
        await octokit.graphql(
          `mutation($pullRequestId: ID!) {\n  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {\n    pullRequest {\n      id\n      isDraft\n    }\n  }\n}`,
          { pullRequestId: nodeId }
        );
      } catch (error) {
        if (error?.status === 403) {
          return res.status(403).json({ error: 'Not authorized to mark PR ready' });
        }
        throw error;
      }

      return res.json({ ready: true });
    } catch (error) {
      console.error('Failed to mark PR ready:', error);
      return res.status(500).json({ error: error.message || 'Failed to mark PR ready' });
    }
  });

  // ================= GitHub Issue APIs =================

  app.get('/api/github/issues/list', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const page = typeof req.query?.page === 'string' ? Number(req.query.page) : 1;
      if (!directory) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, issues: [] });
      }

      const list = await octokit.rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.repo,
        state: 'open',
        per_page: 50,
        page: Number.isFinite(page) && page > 0 ? page : 1,
      });
      const link = typeof list?.headers?.link === 'string' ? list.headers.link : '';
      const hasMore = /rel="next"/.test(link);
      const issues = (Array.isArray(list?.data) ? list.data : [])
        .filter((item) => !item?.pull_request)
        .map((item) => ({
          number: item.number,
          title: item.title,
          url: item.html_url,
          state: item.state === 'closed' ? 'closed' : 'open',
          author: item.user ? { login: item.user.login, id: item.user.id, avatarUrl: item.user.avatar_url } : null,
          labels: Array.isArray(item.labels)
            ? item.labels
                .map((label) => {
                  if (typeof label === 'string') return null;
                  const name = typeof label?.name === 'string' ? label.name : '';
                  if (!name) return null;
                  return { name, color: typeof label?.color === 'string' ? label.color : undefined };
                })
                .filter(Boolean)
            : [],
        }));

      return res.json({ connected: true, repo, issues, page: Number.isFinite(page) && page > 0 ? page : 1, hasMore });
    } catch (error) {
      console.error('Failed to list GitHub issues:', error);
      return res.status(500).json({ error: error.message || 'Failed to list GitHub issues' });
    }
  });

  app.get('/api/github/issues/get', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const number = typeof req.query?.number === 'string' ? Number(req.query.number) : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, issue: null });
      }

      const result = await octokit.rest.issues.get({ owner: repo.owner, repo: repo.repo, issue_number: number });
      const issue = result?.data;
      if (!issue || issue.pull_request) {
        return res.status(400).json({ error: 'Not a GitHub issue' });
      }

      return res.json({
        connected: true,
        repo,
        issue: {
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          state: issue.state === 'closed' ? 'closed' : 'open',
          body: issue.body || '',
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          author: issue.user ? { login: issue.user.login, id: issue.user.id, avatarUrl: issue.user.avatar_url } : null,
          assignees: Array.isArray(issue.assignees)
            ? issue.assignees
                .map((u) => (u ? { login: u.login, id: u.id, avatarUrl: u.avatar_url } : null))
                .filter(Boolean)
            : [],
          labels: Array.isArray(issue.labels)
            ? issue.labels
                .map((label) => {
                  if (typeof label === 'string') return null;
                  const name = typeof label?.name === 'string' ? label.name : '';
                  if (!name) return null;
                  return { name, color: typeof label?.color === 'string' ? label.color : undefined };
                })
                .filter(Boolean)
            : [],
        },
      });
    } catch (error) {
      console.error('Failed to fetch GitHub issue:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitHub issue' });
    }
  });

  app.get('/api/github/issues/comments', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const number = typeof req.query?.number === 'string' ? Number(req.query.number) : null;
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, comments: [] });
      }

      const result = await octokit.rest.issues.listComments({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        per_page: 100,
      });
      const comments = (Array.isArray(result?.data) ? result.data : [])
        .map((comment) => ({
          id: comment.id,
          url: comment.html_url,
          body: comment.body || '',
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
          author: comment.user ? { login: comment.user.login, id: comment.user.id, avatarUrl: comment.user.avatar_url } : null,
        }));

      return res.json({ connected: true, repo, comments });
    } catch (error) {
      console.error('Failed to fetch GitHub issue comments:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitHub issue comments' });
    }
  });

  // ================= GitHub Pull Request Context APIs =================

  app.get('/api/github/pulls/list', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const page = typeof req.query?.page === 'string' ? Number(req.query.page) : 1;
      if (!directory) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, prs: [] });
      }

      const list = await octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        state: 'open',
        per_page: 50,
        page: Number.isFinite(page) && page > 0 ? page : 1,
      });

      const link = typeof list?.headers?.link === 'string' ? list.headers.link : '';
      const hasMore = /rel="next"/.test(link);

      const prs = (Array.isArray(list?.data) ? list.data : []).map((pr) => {
        const mergedState = pr.merged_at ? 'merged' : (pr.state === 'closed' ? 'closed' : 'open');
        const headRepo = pr.head?.repo
          ? {
              owner: pr.head.repo.owner?.login,
              repo: pr.head.repo.name,
              url: pr.head.repo.html_url,
              cloneUrl: pr.head.repo.clone_url,
              sshUrl: pr.head.repo.ssh_url,
            }
          : null;
        return {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          state: mergedState,
          draft: Boolean(pr.draft),
          base: pr.base?.ref,
          head: pr.head?.ref,
          headSha: pr.head?.sha,
          mergeable: pr.mergeable,
          mergeableState: pr.mergeable_state,
          author: pr.user ? { login: pr.user.login, id: pr.user.id, avatarUrl: pr.user.avatar_url } : null,
          headLabel: pr.head?.label,
          headRepo: headRepo && headRepo.owner && headRepo.repo && headRepo.url
            ? headRepo
            : null,
        };
      });

      return res.json({ connected: true, repo, prs, page: Number.isFinite(page) && page > 0 ? page : 1, hasMore });
    } catch (error) {
      if (error?.status === 401) {
        const { clearGitHubAuth } = await getGitHubLibraries();
        clearGitHubAuth();
        return res.json({ connected: false });
      }
      console.error('Failed to list GitHub PRs:', error);
      return res.status(500).json({ error: error.message || 'Failed to list GitHub PRs' });
    }
  });

  app.get('/api/github/pulls/context', async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const number = typeof req.query?.number === 'string' ? Number(req.query.number) : null;
      const includeDiff = req.query?.diff === '1' || req.query?.diff === 'true';
      const includeCheckDetails = req.query?.checkDetails === '1' || req.query?.checkDetails === 'true';
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const { getOctokitOrNull } = await getGitHubLibraries();
      const octokit = getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false });
      }

      const { resolveGitHubRepoFromDirectory } = await import('./lib/github/index.js');
      const { repo } = await resolveGitHubRepoFromDirectory(directory);
      if (!repo) {
        return res.json({ connected: true, repo: null, pr: null });
      }

      const prResp = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number });
      const prData = prResp?.data;
      if (!prData) {
        return res.status(404).json({ error: 'PR not found' });
      }

      const headRepo = prData.head?.repo
        ? {
            owner: prData.head.repo.owner?.login,
            repo: prData.head.repo.name,
            url: prData.head.repo.html_url,
            cloneUrl: prData.head.repo.clone_url,
            sshUrl: prData.head.repo.ssh_url,
          }
        : null;

      const mergedState = prData.merged ? 'merged' : (prData.state === 'closed' ? 'closed' : 'open');
      const pr = {
        number: prData.number,
        title: prData.title,
        url: prData.html_url,
        state: mergedState,
        draft: Boolean(prData.draft),
        base: prData.base?.ref,
        head: prData.head?.ref,
        headSha: prData.head?.sha,
        mergeable: prData.mergeable,
        mergeableState: prData.mergeable_state,
        author: prData.user ? { login: prData.user.login, id: prData.user.id, avatarUrl: prData.user.avatar_url } : null,
        headLabel: prData.head?.label,
        headRepo: headRepo && headRepo.owner && headRepo.repo && headRepo.url ? headRepo : null,
        body: prData.body || '',
        createdAt: prData.created_at,
        updatedAt: prData.updated_at,
      };

      const issueCommentsResp = await octokit.rest.issues.listComments({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        per_page: 100,
      });
      const issueComments = (Array.isArray(issueCommentsResp?.data) ? issueCommentsResp.data : []).map((comment) => ({
        id: comment.id,
        url: comment.html_url,
        body: comment.body || '',
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        author: comment.user ? { login: comment.user.login, id: comment.user.id, avatarUrl: comment.user.avatar_url } : null,
      }));

      const reviewCommentsResp = await octokit.rest.pulls.listReviewComments({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      });
      const reviewComments = (Array.isArray(reviewCommentsResp?.data) ? reviewCommentsResp.data : []).map((comment) => ({
        id: comment.id,
        url: comment.html_url,
        body: comment.body || '',
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        path: comment.path,
        line: typeof comment.line === 'number' ? comment.line : null,
        position: typeof comment.position === 'number' ? comment.position : null,
        author: comment.user ? { login: comment.user.login, id: comment.user.id, avatarUrl: comment.user.avatar_url } : null,
      }));

      const filesResp = await octokit.rest.pulls.listFiles({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      });
      const files = (Array.isArray(filesResp?.data) ? filesResp.data : []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch,
      }));

      // checks summary (same logic as status endpoint)
      let checks = null;
      let checkRunsOut = undefined;
      const sha = prData.head?.sha;
      if (sha) {
        try {
          const runs = await octokit.rest.checks.listForRef({ owner: repo.owner, repo: repo.repo, ref: sha, per_page: 100 });
          const checkRuns = Array.isArray(runs?.data?.check_runs) ? runs.data.check_runs : [];
          if (checkRuns.length > 0) {
            const parsedJobs = new Map();
            const parsedAnnotations = new Map();
            if (includeCheckDetails) {
              // Prefetch actions jobs per runId.
              const runIds = new Set();
              const jobIds = new Map();
              for (const run of checkRuns) {
                const details = typeof run.details_url === 'string' ? run.details_url : '';
                const match = details.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
                if (match) {
                  const runId = Number(match[1]);
                  const jobId = match[2] ? Number(match[2]) : null;
                  if (Number.isFinite(runId) && runId > 0) {
                    runIds.add(runId);
                    if (jobId && Number.isFinite(jobId) && jobId > 0) {
                      jobIds.set(details, { runId, jobId });
                    } else {
                      jobIds.set(details, { runId, jobId: null });
                    }
                  }
                }
              }

              for (const runId of runIds) {
                try {
                  const jobsResp = await octokit.rest.actions.listJobsForWorkflowRun({
                    owner: repo.owner,
                    repo: repo.repo,
                    run_id: runId,
                    per_page: 100,
                  });
                  const jobs = Array.isArray(jobsResp?.data?.jobs) ? jobsResp.data.jobs : [];
                  parsedJobs.set(runId, jobs);
                } catch {
                  parsedJobs.set(runId, []);
                }
              }

              for (const run of checkRuns) {
                const runConclusion = typeof run?.conclusion === 'string' ? run.conclusion.toLowerCase() : '';
                const shouldLoadAnnotations = Boolean(
                  run?.id
                  && runConclusion
                  && !['success', 'neutral', 'skipped'].includes(runConclusion)
                );
                if (!shouldLoadAnnotations) {
                  continue;
                }

                const checkRunId = Number(run.id);
                if (!Number.isFinite(checkRunId) || checkRunId <= 0) {
                  continue;
                }

                const annotations = [];
                for (let page = 1; page <= 3; page += 1) {
                  try {
                    const annotationsResp = await octokit.rest.checks.listAnnotations({
                      owner: repo.owner,
                      repo: repo.repo,
                      check_run_id: checkRunId,
                      per_page: 50,
                      page,
                    });
                    const chunk = Array.isArray(annotationsResp?.data) ? annotationsResp.data : [];
                    annotations.push(...chunk);
                    if (chunk.length < 50) {
                      break;
                    }
                  } catch {
                    break;
                  }
                }

                if (annotations.length > 0) {
                  parsedAnnotations.set(checkRunId, annotations);
                }
              }
            }

            checkRunsOut = checkRuns.map((run) => {
              const detailsUrl = typeof run.details_url === 'string' ? run.details_url : undefined;
              let job = undefined;
              if (includeCheckDetails && detailsUrl) {
                const match = detailsUrl.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
                const runId = match ? Number(match[1]) : null;
                const jobId = match && match[2] ? Number(match[2]) : null;
                if (runId && Number.isFinite(runId)) {
                  const jobs = parsedJobs.get(runId) || [];
                  const matched = jobId
                    ? jobs.find((j) => j.id === jobId)
                    : null;
                  const picked = matched || jobs.find((j) => j.name === run.name) || null;
                  if (picked) {
                    job = {
                      runId,
                      jobId: picked.id,
                      url: picked.html_url,
                      name: picked.name,
                      conclusion: picked.conclusion,
                          steps: Array.isArray(picked.steps)
                            ? picked.steps.map((s) => ({
                                name: s.name,
                                status: s.status,
                                conclusion: s.conclusion,
                                number: s.number,
                                startedAt: s.started_at || undefined,
                                completedAt: s.completed_at || undefined,
                              }))
                            : undefined,
                    };
                  } else {
                    job = { runId, ...(jobId ? { jobId } : {}), url: detailsUrl };
                  }
                }
              }

              return {
                id: run.id,
                name: run.name,
                app: run.app
                  ? {
                      name: run.app.name || undefined,
                      slug: run.app.slug || undefined,
                    }
                  : undefined,
                status: run.status,
                conclusion: run.conclusion,
                detailsUrl,
                output: run.output
                  ? {
                      title: run.output.title || undefined,
                      summary: run.output.summary || undefined,
                      text: run.output.text || undefined,
                    }
                  : undefined,
                ...(job ? { job } : {}),
                ...(run.id && parsedAnnotations.has(run.id)
                  ? {
                      annotations: parsedAnnotations.get(run.id).map((a) => ({
                        path: a.path || undefined,
                        startLine: typeof a.start_line === 'number' ? a.start_line : undefined,
                        endLine: typeof a.end_line === 'number' ? a.end_line : undefined,
                        level: a.annotation_level || undefined,
                        message: a.message || '',
                        title: a.title || undefined,
                        rawDetails: a.raw_details || undefined,
                      })).filter((a) => a.message),
                    }
                  : {}),
              };
            });
            const counts = { success: 0, failure: 0, pending: 0 };
            for (const run of checkRuns) {
              const status = run?.status;
              const conclusion = run?.conclusion;
              if (status === 'queued' || status === 'in_progress') {
                counts.pending += 1;
                continue;
              }
              if (!conclusion) {
                counts.pending += 1;
                continue;
              }
              if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
                counts.success += 1;
              } else {
                counts.failure += 1;
              }
            }
            const total = counts.success + counts.failure + counts.pending;
            const state = counts.failure > 0 ? 'failure' : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
            checks = { state, total, ...counts };
          }
        } catch {
          // ignore and fall back
        }
        if (!checks) {
          try {
            const combined = await octokit.rest.repos.getCombinedStatusForRef({ owner: repo.owner, repo: repo.repo, ref: sha });
            const statuses = Array.isArray(combined?.data?.statuses) ? combined.data.statuses : [];
            const counts = { success: 0, failure: 0, pending: 0 };
            statuses.forEach((s) => {
              if (s.state === 'success') counts.success += 1;
              else if (s.state === 'failure' || s.state === 'error') counts.failure += 1;
              else if (s.state === 'pending') counts.pending += 1;
            });
            const total = counts.success + counts.failure + counts.pending;
            const state = counts.failure > 0 ? 'failure' : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
            checks = { state, total, ...counts };
          } catch {
            checks = null;
          }
        }
      }

      let diff = undefined;
      if (includeDiff) {
        const diffResp = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          headers: { accept: 'application/vnd.github.v3.diff' },
        });
        diff = typeof diffResp?.data === 'string' ? diffResp.data : undefined;
      }

      return res.json({
        connected: true,
        repo,
        pr,
        issueComments,
        reviewComments,
        files,
        ...(diff ? { diff } : {}),
        checks,
        ...(Array.isArray(checkRunsOut) ? { checkRuns: checkRunsOut } : {}),
      });
    } catch (error) {
      if (error?.status === 401) {
        const { clearGitHubAuth } = await getGitHubLibraries();
        clearGitHubAuth();
        return res.json({ connected: false });
      }
      console.error('Failed to load GitHub PR context:', error);
      return res.status(500).json({ error: error.message || 'Failed to load GitHub PR context' });
    }
  });

  app.get('/api/provider/:providerId/source', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;

      let directory = null;
      const resolved = await resolveProjectDirectory(req);
      if (resolved.directory) {
        directory = resolved.directory;
      } else if (requestedDirectory) {
        return res.status(400).json({ error: resolved.error });
      }

      const sources = getProviderSources(providerId, directory);
      const { getProviderAuth } = await getAuthLibrary();
      const auth = getProviderAuth(providerId);
      sources.sources.auth.exists = Boolean(auth);

      res.json({
        providerId,
        sources: sources.sources,
      });
    } catch (error) {
      console.error('Failed to get provider sources:', error);
      res.status(500).json({ error: error.message || 'Failed to get provider sources' });
    }
  });

  app.get('/api/quota/providers', async (_req, res) => {
    try {
      const { listConfiguredQuotaProviders } = await getQuotaProviders();
      const providers = listConfiguredQuotaProviders();
      res.json({ providers });
    } catch (error) {
      console.error('Failed to list quota providers:', error);
      res.status(500).json({ error: error.message || 'Failed to list quota providers' });
    }
  });

  app.get('/api/quota/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }
      const { fetchQuotaForProvider } = await getQuotaProviders();
      const result = await fetchQuotaForProvider(providerId);
      res.json(result);
    } catch (error) {
      console.error('Failed to fetch quota:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch quota' });
    }
  });

  app.delete('/api/provider/:providerId/auth', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) {
        return res.status(400).json({ error: 'Provider ID is required' });
      }

      const scope = typeof req.query?.scope === 'string' ? req.query.scope : 'auth';
      const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
      const queryDirectory = Array.isArray(req.query?.directory)
        ? req.query.directory[0]
        : req.query?.directory;
      const requestedDirectory = headerDirectory || queryDirectory || null;
      let directory = null;

      if (scope === 'project' || requestedDirectory) {
        const resolved = await resolveProjectDirectory(req);
        if (!resolved.directory) {
          return res.status(400).json({ error: resolved.error });
        }
        directory = resolved.directory;
      } else {
        const resolved = await resolveProjectDirectory(req);
        if (resolved.directory) {
          directory = resolved.directory;
        }
      }

      let removed = false;
      if (scope === 'auth') {
        const { removeProviderAuth } = await getAuthLibrary();
        removed = removeProviderAuth(providerId);
      } else if (scope === 'user' || scope === 'project' || scope === 'custom') {
        removed = removeProviderConfig(providerId, directory, scope);
      } else if (scope === 'all') {
        const { removeProviderAuth } = await getAuthLibrary();
        const authRemoved = removeProviderAuth(providerId);
        const userRemoved = removeProviderConfig(providerId, directory, 'user');
        const projectRemoved = directory ? removeProviderConfig(providerId, directory, 'project') : false;
        const customRemoved = removeProviderConfig(providerId, directory, 'custom');
        removed = authRemoved || userRemoved || projectRemoved || customRemoved;
      } else {
        return res.status(400).json({ error: 'Invalid scope' });
      }

      if (removed) {
        await refreshOpenCodeAfterConfigChange(`provider ${providerId} disconnected (${scope})`);
      }

      res.json({
        success: true,
        removed,
        requiresReload: removed,
        message: removed ? 'Provider disconnected successfully' : 'Provider was not connected',
        reloadDelayMs: removed ? CLIENT_RELOAD_DELAY_MS : undefined,
      });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      res.status(500).json({ error: error.message || 'Failed to disconnect provider' });
    }
  });

  let gitLibraries = null;
  const getGitLibraries = async () => {
    if (!gitLibraries) {
      gitLibraries = await import('./lib/git/index.js');
    }
    return gitLibraries;
  };

  app.get('/api/git/identities', async (req, res) => {
    const { getProfiles } = await getGitLibraries();
    try {
      const profiles = getProfiles();
      res.json(profiles);
    } catch (error) {
      console.error('Failed to list git identity profiles:', error);
      res.status(500).json({ error: 'Failed to list git identity profiles' });
    }
  });

  app.post('/api/git/identities', async (req, res) => {
    const { createProfile } = await getGitLibraries();
    try {
      const profile = createProfile(req.body);
      console.log(`Created git identity profile: ${profile.name} (${profile.id})`);
      res.json(profile);
    } catch (error) {
      console.error('Failed to create git identity profile:', error);
      res.status(400).json({ error: error.message || 'Failed to create git identity profile' });
    }
  });

  app.put('/api/git/identities/:id', async (req, res) => {
    const { updateProfile } = await getGitLibraries();
    try {
      const profile = updateProfile(req.params.id, req.body);
      console.log(`Updated git identity profile: ${profile.name} (${profile.id})`);
      res.json(profile);
    } catch (error) {
      console.error('Failed to update git identity profile:', error);
      res.status(400).json({ error: error.message || 'Failed to update git identity profile' });
    }
  });

  app.delete('/api/git/identities/:id', async (req, res) => {
    const { deleteProfile } = await getGitLibraries();
    try {
      deleteProfile(req.params.id);
      console.log(`Deleted git identity profile: ${req.params.id}`);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to delete git identity profile:', error);
      res.status(400).json({ error: error.message || 'Failed to delete git identity profile' });
    }
  });

  app.get('/api/git/global-identity', async (req, res) => {
    const { getGlobalIdentity } = await getGitLibraries();
    try {
      const identity = await getGlobalIdentity();
      res.json(identity);
    } catch (error) {
      console.error('Failed to get global git identity:', error);
      res.status(500).json({ error: 'Failed to get global git identity' });
    }
  });

  app.get('/api/git/discover-credentials', async (req, res) => {
    try {
      const { discoverGitCredentials } = await import('./lib/git/index.js');
      const credentials = discoverGitCredentials();
      res.json(credentials);
    } catch (error) {
      console.error('Failed to discover git credentials:', error);
      res.status(500).json({ error: 'Failed to discover git credentials' });
    }
  });

  app.get('/api/git/check', async (req, res) => {
    const { isGitRepository } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const isRepo = await isGitRepository(directory);
      res.json({ isGitRepository: isRepo });
    } catch (error) {
      console.error('Failed to check git repository:', error);
      res.status(500).json({ error: 'Failed to check git repository' });
    }
  });

  app.get('/api/git/remote-url', async (req, res) => {
    const { getRemoteUrl } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const remote = req.query.remote || 'origin';

      const url = await getRemoteUrl(directory, remote);
      res.json({ url });
    } catch (error) {
      console.error('Failed to get remote url:', error);
      res.status(500).json({ error: 'Failed to get remote url' });
    }
  });

  app.get('/api/git/current-identity', async (req, res) => {
    const { getCurrentIdentity } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const identity = await getCurrentIdentity(directory);
      res.json(identity);
    } catch (error) {
      console.error('Failed to get current git identity:', error);
      res.status(500).json({ error: 'Failed to get current git identity' });
    }
  });

  app.get('/api/git/has-local-identity', async (req, res) => {
    const { hasLocalIdentity } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const hasLocal = await hasLocalIdentity(directory);
      res.json({ hasLocalIdentity: hasLocal });
    } catch (error) {
      console.error('Failed to check local git identity:', error);
      res.status(500).json({ error: 'Failed to check local git identity' });
    }
  });

  app.post('/api/git/set-identity', async (req, res) => {
    const { getProfile, setLocalIdentity, getGlobalIdentity } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { profileId } = req.body;
      if (!profileId) {
        return res.status(400).json({ error: 'profileId is required' });
      }

      let profile = null;

      if (profileId === 'global') {
        const globalIdentity = await getGlobalIdentity();
        if (!globalIdentity?.userName || !globalIdentity?.userEmail) {
          return res.status(404).json({ error: 'Global identity is not configured' });
        }
        profile = {
          id: 'global',
          name: 'Global Identity',
          userName: globalIdentity.userName,
          userEmail: globalIdentity.userEmail,
          sshKey: globalIdentity.sshCommand
            ? globalIdentity.sshCommand.replace('ssh -i ', '')
            : null,
        };
      } else {
        profile = getProfile(profileId);
        if (!profile) {
          return res.status(404).json({ error: 'Profile not found' });
        }
      }

      await setLocalIdentity(directory, profile);
      res.json({ success: true, profile });
    } catch (error) {
      console.error('Failed to set git identity:', error);
      res.status(500).json({ error: error.message || 'Failed to set git identity' });
    }
  });

  app.get('/api/git/status', async (req, res) => {
    const { getStatus } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const status = await getStatus(directory);
      res.json(status);
    } catch (error) {
      console.error('Failed to get git status:', error);
      res.status(500).json({ error: error.message || 'Failed to get git status' });
    }
  });

  app.get('/api/git/diff', async (req, res) => {
    const { getDiff } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const path = req.query.path;
      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const staged = req.query.staged === 'true';
      const context = req.query.context ? parseInt(String(req.query.context), 10) : undefined;

      const diff = await getDiff(directory, {
        path,
        staged,
        contextLines: Number.isFinite(context) ? context : 3,
      });

      res.json({ diff });
    } catch (error) {
      console.error('Failed to get git diff:', error);
      res.status(500).json({ error: error.message || 'Failed to get git diff' });
    }
  });

  app.get('/api/git/file-diff', async (req, res) => {
    const { getFileDiff } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const pathParam = req.query.path;
      if (!pathParam || typeof pathParam !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const staged = req.query.staged === 'true';

      const result = await getFileDiff(directory, {
        path: pathParam,
        staged,
      });

      res.json({
        original: result.original,
        modified: result.modified,
        path: result.path,
        isBinary: Boolean(result.isBinary),
      });
    } catch (error) {
      console.error('Failed to get git file diff:', error);
      res.status(500).json({ error: error.message || 'Failed to get git file diff' });
    }
  });

  app.post('/api/git/revert', async (req, res) => {
    const { revertFile } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path } = req.body || {};
      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await revertFile(directory, path);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to revert git file:', error);
      res.status(500).json({ error: error.message || 'Failed to revert git file' });
    }
  });

  app.post('/api/git/commit-message', async (req, res) => {
    const { collectDiffs } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const files = Array.isArray(req.body?.files) ? req.body.files : [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'At least one file is required' });
      }

      const diffs = await collectDiffs(directory, files);
      if (diffs.length === 0) {
        return res.status(400).json({ error: 'No diffs available for selected files' });
      }

      const MAX_DIFF_LENGTH = 4000;
      const diffSummaries = diffs
        .map(({ path, diff }) => {
          const trimmed = diff.length > MAX_DIFF_LENGTH ? `${diff.slice(0, MAX_DIFF_LENGTH)}\n...` : diff;
          return `FILE: ${path}\n${trimmed}`;
        })
        .join('\n\n');

      const prompt = `You are generating a Conventional Commits subject line from the provided diff.

Return EXACTLY one JSON object (no code fences, no extra keys, no extra text):
{"subject": string, "highlights": string[]}

Non-negotiable:
- Output must be valid JSON (double quotes).
- Only claim what is supported by the diff. If unsure, be more general; do not guess.

subject:
- Format: <type>: <summary> (NO scope; never write type(scope))
- Allowed types: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert
- Choose type (prefer fix when ambiguous):
  - fix: any bug/regression/wrong behavior (state, selection, navigation, persistence, crash)
  - feat: new user-facing capability or new workflow (not just guardrails/defaults)
  - refactor/perf/docs/test/build/ci/style/chore/revert: only when clearly the primary change
- Summary style:
  - imperative, present tense, outcome-first
  - <= 72 characters, no trailing period
  - avoid filenames, internal function names, and implementation details

highlights:
- 0-3 items; it is OK to return [].
- Each item: one plain sentence, <= 90 chars, starts with an Uppercase verb.
- Must add information not already in the subject.
- Prefer user-observable behaviors (UI flow, navigation, selection, default view, persistence).
- No markdown bullets, no file paths, no helper names.

Diff summary (may be truncated):
${diffSummaries}`;

      const model = await resolveZenModel(typeof req.body?.zenModel === 'string' ? req.body.zenModel : undefined);

      const completionTimeout = createTimeoutSignal(LONG_REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch('https://opencode.ai/zen/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input: [{ role: 'user', content: prompt }],
            max_output_tokens: 1000,
            stream: false,
            reasoning: {
              effort: 'low'
            }
          }),
          signal: completionTimeout.signal,
        });
      } finally {
        completionTimeout.cleanup();
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        console.error('Commit message generation failed:', errorBody);
        return res.status(502).json({ error: 'Failed to generate commit message' });
      }

      const data = await response.json();
      const raw = data?.output?.find((item) => item?.type === 'message')?.content?.find((item) => item?.type === 'output_text')?.text?.trim();

      if (!raw) {
        return res.status(502).json({ error: 'No commit message returned by generator' });
      }

      const cleanedJson = stripJsonMarkdownWrapper(raw);
      const extractedJson = extractJsonObject(cleanedJson) || extractJsonObject(raw);
      const candidates = [cleanedJson, extractedJson, raw].filter((candidate, index, array) => {
        return candidate && array.indexOf(candidate) === index;
      });

      for (const candidate of candidates) {
        if (!(candidate.startsWith('{') || candidate.startsWith('['))) {
          continue;
        }
        try {
          const parsed = JSON.parse(candidate);
          return res.json({ message: parsed });
        } catch (parseError) {
          console.warn('Commit message generation returned non-JSON body:', parseError);
        }
      }

      res.json({ message: { subject: raw, highlights: [] } });
    } catch (error) {
      console.error('Failed to generate commit message:', error);
      res.status(500).json({ error: error.message || 'Failed to generate commit message' });
    }
  });

  app.post('/api/git/pr-description', async (req, res) => {
    const { getRangeDiff, getRangeFiles } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const base = typeof req.body?.base === 'string' ? req.body.base.trim() : '';
      const head = typeof req.body?.head === 'string' ? req.body.head.trim() : '';
      if (!base || !head) {
        return res.status(400).json({ error: 'base and head are required' });
      }

      const filesToDiff = await getRangeFiles(directory, { base, head });

      const diffs = [];
      for (const filePath of filesToDiff) {
        const diff = await getRangeDiff(directory, { base, head, path: filePath, contextLines: 3 }).catch(() => '');
        if (diff && diff.trim().length > 0) {
          diffs.push({ path: filePath, diff });
        }
      }
      if (diffs.length === 0) {
        return res.status(400).json({ error: 'No diffs available for base...head' });
      }

      const diffSummaries = diffs.map(({ path, diff }) => `FILE: ${path}\n${diff}`).join('\n\n');
      const context = typeof req.body?.context === 'string' ? req.body.context.trim() : '';

      let prompt = `You are drafting a GitHub Pull Request title + description for a squash-merge workflow.
Respond in JSON of the shape {"title": string, "body": string} (ONLY JSON in response, no markdown fences) with these rules:
- Title format: conventional, outcome-first, <= 90 chars, no trailing punctuation.
- Use: <type>(<scope>): <summary>. Types: feat, fix, refactor, perf, docs, test, chore.
- Pick the most important user-facing outcome first; include a second major outcome only when needed.
- Body: GitHub-flavored markdown with sections in this exact order: ## Summary, ## Why, ## Testing.
- Summary: 3-6 bullets, concrete product/workflow impact, no vague filler, no internal helper names.
- Why: 1-3 bullets explaining motivation/tradeoff (what problem this solves for users/devs).
- Testing: checkbox list using "- [ ]"; include realistic manual/automated checks inferred from the diff.
- If tests were not run, include "- [ ] Not run locally" as first testing item.
- Keep language crisp and specific; avoid generic boilerplate.

Context:
- base branch: ${base}
- head branch: ${head}`;

      if (context) {
        prompt += `\n\nAdditional context provided by user:\n${context}`;
      }

      prompt += `\n\nDiff summary:\n${diffSummaries}`;

      const model = await resolveZenModel(typeof req.body?.zenModel === 'string' ? req.body.zenModel : undefined);

      const completionTimeout = createTimeoutSignal(LONG_REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch('https://opencode.ai/zen/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            input: [{ role: 'user', content: prompt }],
            max_output_tokens: 1200,
            stream: false,
            reasoning: { effort: 'low' },
          }),
          signal: completionTimeout.signal,
        });
      } finally {
        completionTimeout.cleanup();
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        console.error('PR description generation failed:', errorBody);
        return res.status(502).json({ error: 'Failed to generate PR description' });
      }

      const data = await response.json();
      const raw = data?.output?.find((item) => item?.type === 'message')?.content?.find((item) => item?.type === 'output_text')?.text?.trim();
      if (!raw) {
        return res.status(502).json({ error: 'No PR description returned by generator' });
      }

      const cleanedJson = stripJsonMarkdownWrapper(raw);
      const extractedJson = extractJsonObject(cleanedJson) || extractJsonObject(raw);
      const candidates = [cleanedJson, extractedJson, raw].filter((candidate, index, array) => {
        return candidate && array.indexOf(candidate) === index;
      });

      for (const candidate of candidates) {
        if (!(candidate.startsWith('{') || candidate.startsWith('['))) {
          continue;
        }
        try {
          const parsed = JSON.parse(candidate);
          const title = typeof parsed?.title === 'string' ? parsed.title : '';
          const body = typeof parsed?.body === 'string' ? parsed.body : '';
          return res.json({ title, body });
        } catch (parseError) {
          console.warn('PR description generation returned non-JSON body:', parseError);
        }
      }

      return res.json({ title: '', body: raw });
    } catch (error) {
      console.error('Failed to generate PR description:', error);
      return res.status(500).json({ error: error.message || 'Failed to generate PR description' });
    }
  });

  app.post('/api/git/pull', async (req, res) => {
    const { pull } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await pull(directory, req.body);
      res.json(result);
    } catch (error) {
      console.error('Failed to pull:', error);
      res.status(500).json({ error: error.message || 'Failed to pull from remote' });
    }
  });

  app.post('/api/git/push', async (req, res) => {
    const { push } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await push(directory, req.body);
      res.json(result);
    } catch (error) {
      console.error('Failed to push:', error);
      res.status(500).json({ error: error.message || 'Failed to push to remote' });
    }
  });

  app.post('/api/git/fetch', async (req, res) => {
    const { fetch: gitFetch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await gitFetch(directory, req.body);
      res.json(result);
    } catch (error) {
      console.error('Failed to fetch:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch from remote' });
    }
  });

  app.get('/api/git/remotes', async (req, res) => {
    const { getRemotes } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const remotes = await getRemotes(directory);
      res.json(remotes);
    } catch (error) {
      console.error('Failed to get remotes:', error);
      res.status(500).json({ error: error.message || 'Failed to get remotes' });
    }
  });

  app.post('/api/git/rebase', async (req, res) => {
    const { rebase } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await rebase(directory, req.body);
      res.json(result);
    } catch (error) {
      console.error('Failed to rebase:', error);
      res.status(500).json({ error: error.message || 'Failed to rebase' });
    }
  });

  app.post('/api/git/rebase/abort', async (req, res) => {
    const { abortRebase } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await abortRebase(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to abort rebase:', error);
      res.status(500).json({ error: error.message || 'Failed to abort rebase' });
    }
  });

  app.post('/api/git/merge', async (req, res) => {
    const { merge } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await merge(directory, req.body);
      res.json(result);
    } catch (error) {
      console.error('Failed to merge:', error);
      res.status(500).json({ error: error.message || 'Failed to merge' });
    }
  });

  app.post('/api/git/merge/abort', async (req, res) => {
    const { abortMerge } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await abortMerge(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to abort merge:', error);
      res.status(500).json({ error: error.message || 'Failed to abort merge' });
    }
  });

  app.post('/api/git/rebase/continue', async (req, res) => {
    const { continueRebase } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await continueRebase(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to continue rebase:', error);
      res.status(500).json({ error: error.message || 'Failed to continue rebase' });
    }
  });

  app.post('/api/git/merge/continue', async (req, res) => {
    const { continueMerge } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await continueMerge(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to continue merge:', error);
      res.status(500).json({ error: error.message || 'Failed to continue merge' });
    }
  });

  app.get('/api/git/conflict-details', async (req, res) => {
    const { getConflictDetails } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await getConflictDetails(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to get conflict details:', error);
      res.status(500).json({ error: error.message || 'Failed to get conflict details' });
    }
  });

  app.post('/api/git/stash', async (req, res) => {
    const { stash } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await stash(directory, req.body);
      res.json(result);
    } catch (error) {
      console.error('Failed to stash:', error);
      res.status(500).json({ error: error.message || 'Failed to stash' });
    }
  });

  app.post('/api/git/stash/pop', async (req, res) => {
    const { stashPop } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await stashPop(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to pop stash:', error);
      res.status(500).json({ error: error.message || 'Failed to pop stash' });
    }
  });

  app.post('/api/git/commit', async (req, res) => {
    const { commit } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { message, addAll, files } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'message is required' });
      }

      const result = await commit(directory, message, {
        addAll,
        files,
      });
      res.json(result);
    } catch (error) {
      console.error('Failed to commit:', error);
      res.status(500).json({ error: error.message || 'Failed to create commit' });
    }
  });

  app.get('/api/git/branches', async (req, res) => {
    const { getBranches } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const branches = await getBranches(directory);
      res.json(branches);
    } catch (error) {
      console.error('Failed to get branches:', error);
      res.status(500).json({ error: error.message || 'Failed to get branches' });
    }
  });

  app.post('/api/git/branches', async (req, res) => {
    const { createBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { name, startPoint } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      const result = await createBranch(directory, name, { startPoint });
      res.json(result);
    } catch (error) {
      console.error('Failed to create branch:', error);
      res.status(500).json({ error: error.message || 'Failed to create branch' });
    }
  });

  app.delete('/api/git/branches', async (req, res) => {
    const { deleteBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch, force } = req.body;
      if (!branch) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await deleteBranch(directory, branch, { force });
      res.json(result);
    } catch (error) {
      console.error('Failed to delete branch:', error);
      res.status(500).json({ error: error.message || 'Failed to delete branch' });
    }
  });


  app.put('/api/git/branches/rename', async (req, res) => {
    const { renameBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { oldName, newName } = req.body;
      if (!oldName) {
        return res.status(400).json({ error: 'oldName is required' });
      }
      if (!newName) {
        return res.status(400).json({ error: 'newName is required' });
      }

      const result = await renameBranch(directory, oldName, newName);
      res.json(result);
    } catch (error) {
      console.error('Failed to rename branch:', error);
      res.status(500).json({ error: error.message || 'Failed to rename branch' });
    }
  });
  app.delete('/api/git/remote-branches', async (req, res) => {
    const { deleteRemoteBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch, remote } = req.body;
      if (!branch) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await deleteRemoteBranch(directory, { branch, remote });
      res.json(result);
    } catch (error) {
      console.error('Failed to delete remote branch:', error);
      res.status(500).json({ error: error.message || 'Failed to delete remote branch' });
    }
  });

  app.post('/api/git/checkout', async (req, res) => {
    const { checkoutBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch } = req.body;
      if (!branch) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await checkoutBranch(directory, branch);
      res.json(result);
    } catch (error) {
      console.error('Failed to checkout branch:', error);
      res.status(500).json({ error: error.message || 'Failed to checkout branch' });
    }
  });

  app.get('/api/git/worktrees', async (req, res) => {
    const { getWorktrees } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const worktrees = await getWorktrees(directory);
      res.json(worktrees);
    } catch (error) {
      // Worktrees are an optional feature. Avoid repeated 500s (and repeated client retries)
      // when the directory isn't a git repo or uses shell shorthand like "~/".
      console.warn('Failed to get worktrees, returning empty list:', error?.message || error);
      res.setHeader('X-OpenChamber-Warning', 'git worktrees unavailable');
      res.json([]);
    }
  });

  app.post('/api/git/worktrees/validate', async (req, res) => {
    const { validateWorktreeCreate } = await getGitLibraries();
    if (typeof validateWorktreeCreate !== 'function') {
      return res.status(501).json({ error: 'Worktree validation is not available' });
    }

    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await validateWorktreeCreate(directory, req.body || {});
      res.json(result);
    } catch (error) {
      console.error('Failed to validate worktree creation:', error);
      res.status(500).json({ error: error.message || 'Failed to validate worktree creation' });
    }
  });

  app.post('/api/git/worktrees', async (req, res) => {
    const { createWorktree } = await getGitLibraries();
    if (typeof createWorktree !== 'function') {
      return res.status(501).json({ error: 'Worktree creation is not available' });
    }

    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const created = await createWorktree(directory, req.body || {});
      res.json(created);
    } catch (error) {
      console.error('Failed to create worktree:', error);
      res.status(500).json({ error: error.message || 'Failed to create worktree' });
    }
  });

  app.delete('/api/git/worktrees', async (req, res) => {
    const { removeWorktree } = await getGitLibraries();
    if (typeof removeWorktree !== 'function') {
      return res.status(501).json({ error: 'Worktree removal is not available' });
    }

    try {
      const directory = req.query.directory;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const worktreeDirectory = typeof req.body?.directory === 'string' ? req.body.directory : '';
      if (!worktreeDirectory) {
        return res.status(400).json({ error: 'worktree directory is required' });
      }

      const result = await removeWorktree(directory, {
        directory: worktreeDirectory,
        deleteLocalBranch: req.body?.deleteLocalBranch === true,
      });
      res.json({ success: Boolean(result) });
    } catch (error) {
      console.error('Failed to remove worktree:', error);
      res.status(500).json({ error: error.message || 'Failed to remove worktree' });
    }
  });

  app.get('/api/git/worktree-type', async (req, res) => {
    const { isLinkedWorktree } = await getGitLibraries();
    try {
      const { directory } = req.query;
      if (!directory || typeof directory !== 'string') {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const linked = await isLinkedWorktree(directory);
      res.json({ linked });
    } catch (error) {
      console.error('Failed to determine worktree type:', error);
      res.status(500).json({ error: error.message || 'Failed to determine worktree type' });
    }
  });

  app.get('/api/git/log', async (req, res) => {
    const { getLog } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { maxCount, from, to, file } = req.query;
      const log = await getLog(directory, {
        maxCount: maxCount ? parseInt(maxCount) : undefined,
        from,
        to,
        file
      });
      res.json(log);
    } catch (error) {
      console.error('Failed to get log:', error);
      res.status(500).json({ error: error.message || 'Failed to get commit log' });
    }
  });

  app.get('/api/git/commit-files', async (req, res) => {
    const { getCommitFiles } = await getGitLibraries();
    try {
      const { directory, hash } = req.query;
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!hash) {
        return res.status(400).json({ error: 'hash parameter is required' });
      }

      const result = await getCommitFiles(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to get commit files:', error);
      res.status(500).json({ error: error.message || 'Failed to get commit files' });
    }
  });

  app.get('/api/fs/home', (req, res) => {
    try {
      const home = os.homedir();
      if (!home || typeof home !== 'string' || home.length === 0) {
        return res.status(500).json({ error: 'Failed to resolve home directory' });
      }
      res.json({ home });
    } catch (error) {
      console.error('Failed to resolve home directory:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to resolve home directory' });
    }
  });

  app.post('/api/fs/mkdir', async (req, res) => {
    try {
      const { path: dirPath, allowOutsideWorkspace } = req.body ?? {};

      if (typeof dirPath !== 'string' || !dirPath.trim()) {
        return res.status(400).json({ error: 'Path is required' });
      }

      let resolvedPath = '';

      if (allowOutsideWorkspace) {
        resolvedPath = path.resolve(normalizeDirectoryPath(dirPath));
      } else {
        const resolved = await resolveWorkspacePathFromContext(req, dirPath);
        if (!resolved.ok) {
          return res.status(400).json({ error: resolved.error });
        }
        resolvedPath = resolved.resolved;
      }

      await fsPromises.mkdir(resolvedPath, { recursive: true });

      res.json({ success: true, path: resolvedPath });
    } catch (error) {
      console.error('Failed to create directory:', error);
      res.status(500).json({ error: error.message || 'Failed to create directory' });
    }
  });

  // Read file contents
  app.get('/api/fs/read', async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext(req, filePath);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      const content = await fsPromises.readFile(canonicalPath, 'utf8');
      res.type('text/plain').send(content);
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read file:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to read file' });
    }
  });

  // Read file as raw bytes (images, etc.)
  app.get('/api/fs/raw', async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext(req, filePath);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase)) {
        return res.status(403).json({ error: 'Access to file denied' });
      }

      const stats = await fsPromises.stat(canonicalPath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Specified path is not a file' });
      }

      const ext = path.extname(canonicalPath).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.bmp': 'image/bmp',
        '.avif': 'image/avif',
      };
      const mimeType = mimeMap[ext] || 'application/octet-stream';

      const content = await fsPromises.readFile(canonicalPath);
      res.setHeader('Cache-Control', 'no-store');
      res.type(mimeType).send(content);
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found' });
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access to file denied' });
      }
      console.error('Failed to read raw file:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to read file' });
    }
  });

  // Write file contents
  app.post('/api/fs/write', async (req, res) => {
    const { path: filePath, content } = req.body || {};
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Content is required' });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext(req, filePath);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      // Ensure parent directory exists
      await fsPromises.mkdir(path.dirname(resolved.resolved), { recursive: true });
      await fsPromises.writeFile(resolved.resolved, content, 'utf8');
      res.json({ success: true, path: resolved.resolved });
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access denied' });
      }
      console.error('Failed to write file:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to write file' });
    }
  });

  // Delete file or directory
  app.post('/api/fs/delete', async (req, res) => {
    const { path: targetPath } = req.body || {};
    if (!targetPath || typeof targetPath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = await resolveWorkspacePathFromContext(req, targetPath);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }

      await fsPromises.rm(resolved.resolved, { recursive: true, force: true });

      res.json({ success: true, path: resolved.resolved });
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'File or directory not found' });
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access denied' });
      }
      console.error('Failed to delete path:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to delete path' });
    }
  });

  // Rename/Move file or directory
  app.post('/api/fs/rename', async (req, res) => {
    const { oldPath, newPath } = req.body || {};
    if (!oldPath || typeof oldPath !== 'string') {
      return res.status(400).json({ error: 'oldPath is required' });
    }
    if (!newPath || typeof newPath !== 'string') {
      return res.status(400).json({ error: 'newPath is required' });
    }

    try {
      const resolvedOld = await resolveWorkspacePathFromContext(req, oldPath);
      if (!resolvedOld.ok) {
        return res.status(400).json({ error: resolvedOld.error });
      }
      const resolvedNew = await resolveWorkspacePathFromContext(req, newPath);
      if (!resolvedNew.ok) {
        return res.status(400).json({ error: resolvedNew.error });
      }

      if (resolvedOld.base !== resolvedNew.base) {
        return res.status(400).json({ error: 'Source and destination must share the same workspace root' });
      }

      await fsPromises.rename(resolvedOld.resolved, resolvedNew.resolved);

      res.json({ success: true, path: resolvedNew.resolved });
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Source path not found' });
      }
      if (err && typeof err === 'object' && err.code === 'EACCES') {
        return res.status(403).json({ error: 'Access denied' });
      }
      console.error('Failed to rename path:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to rename path' });
    }
  });

  // Reveal a file or folder in the system file manager (Finder on macOS, Explorer on Windows, etc.)
  app.post('/api/fs/reveal', async (req, res) => {
    const { path: targetPath } = req.body || {};
    if (!targetPath || typeof targetPath !== 'string') {
      return res.status(400).json({ error: 'Path is required' });
    }

    try {
      const resolved = path.resolve(targetPath.trim());

      // Verify path exists
      await fsPromises.access(resolved);

      const platform = process.platform;
      if (platform === 'darwin') {
        // macOS: open -R selects the file in Finder; open opens a folder
        const stat = await fsPromises.stat(resolved);
        if (stat.isDirectory()) {
          spawn('open', [resolved], { stdio: 'ignore', detached: true }).unref();
        } else {
          spawn('open', ['-R', resolved], { stdio: 'ignore', detached: true }).unref();
        }
      } else if (platform === 'win32') {
        // Windows: explorer /select, highlights the file
        spawn('explorer', ['/select,', resolved], { stdio: 'ignore', detached: true }).unref();
      } else {
        // Linux: xdg-open opens the parent directory
        const stat = await fsPromises.stat(resolved);
        const dir = stat.isDirectory() ? resolved : path.dirname(resolved);
        spawn('xdg-open', [dir], { stdio: 'ignore', detached: true }).unref();
      }

      res.json({ success: true, path: resolved });
    } catch (error) {
      const err = error;
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Path not found' });
      }
      console.error('Failed to reveal path:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to reveal path' });
    }
  });

  // Execute shell commands in a directory (for worktree setup)
  // NOTE: This route supports background execution to avoid tying up browser connections.
  const execJobs = new Map();
  const EXEC_JOB_TTL_MS = 30 * 60 * 1000;
  const COMMAND_TIMEOUT_MS = (() => {
    const raw = Number(process.env.OPENCHAMBER_FS_EXEC_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    // `bun install` (common worktree setup cmd) often takes >60s.
    return 5 * 60 * 1000;
  })();

  const pruneExecJobs = () => {
    const now = Date.now();
    for (const [jobId, job] of execJobs.entries()) {
      if (!job || typeof job !== 'object') {
        execJobs.delete(jobId);
        continue;
      }
      const updatedAt = typeof job.updatedAt === 'number' ? job.updatedAt : 0;
      if (updatedAt && now - updatedAt > EXEC_JOB_TTL_MS) {
        execJobs.delete(jobId);
      }
    }
  };

  const runCommandInDirectory = (shell, shellFlag, command, resolvedCwd) => {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const envPath = buildAugmentedPath();
      const execEnv = { ...process.env, PATH: envPath };

      const child = spawn(shell, [shellFlag, command], {
        cwd: resolvedCwd,
        env: execEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, COMMAND_TIMEOUT_MS);

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        resolve({
          command,
          success: false,
          exitCode: undefined,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: (error && error.message) || 'Command execution failed',
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        const exitCode = typeof code === 'number' ? code : undefined;
        const base = {
          command,
          success: exitCode === 0 && !timedOut,
          exitCode,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        };

        if (timedOut) {
          resolve({
            ...base,
            success: false,
            error: `Command timed out after ${COMMAND_TIMEOUT_MS}ms` + (signal ? ` (${signal})` : ''),
          });
          return;
        }

        resolve(base);
      });
    });
  };

  const runExecJob = async (job) => {
    job.status = 'running';
    job.updatedAt = Date.now();

    const results = [];

    for (const command of job.commands) {
      if (typeof command !== 'string' || !command.trim()) {
        results.push({ command, success: false, error: 'Invalid command' });
        continue;
      }

      try {
        const result = await runCommandInDirectory(job.shell, job.shellFlag, command, job.resolvedCwd);
        results.push(result);
      } catch (error) {
        results.push({
          command,
          success: false,
          error: (error && error.message) || 'Command execution failed',
        });
      }

      job.results = results;
      job.updatedAt = Date.now();
    }

    job.results = results;
    job.success = results.every((r) => r.success);
    job.status = 'done';
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  };

  app.post('/api/fs/exec', async (req, res) => {
    const { commands, cwd, background } = req.body || {};
    if (!Array.isArray(commands) || commands.length === 0) {
      return res.status(400).json({ error: 'Commands array is required' });
    }
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'Working directory (cwd) is required' });
    }

    pruneExecJobs();

    try {
      const resolvedCwd = path.resolve(normalizeDirectoryPath(cwd));
      const stats = await fsPromises.stat(resolvedCwd);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified cwd is not a directory' });
      }

      const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
      const shellFlag = process.platform === 'win32' ? '/c' : '-c';

      const jobId = crypto.randomUUID();
      const job = {
        jobId,
        status: 'queued',
        success: null,
        commands,
        resolvedCwd,
        shell,
        shellFlag,
        results: [],
        startedAt: Date.now(),
        finishedAt: null,
        updatedAt: Date.now(),
      };

      execJobs.set(jobId, job);

      const isBackground = background === true;
      if (isBackground) {
        void runExecJob(job).catch((error) => {
          job.status = 'done';
          job.success = false;
          job.results = Array.isArray(job.results) ? job.results : [];
          job.results.push({
            command: '',
            success: false,
            error: (error && error.message) || 'Command execution failed',
          });
          job.finishedAt = Date.now();
          job.updatedAt = Date.now();
        });

        return res.status(202).json({
          jobId,
          status: 'running',
        });
      }

      await runExecJob(job);
      res.json({
        jobId,
        status: job.status,
        success: job.success === true,
        results: job.results,
      });
    } catch (error) {
      console.error('Failed to execute commands:', error);
      res.status(500).json({ error: (error && error.message) || 'Failed to execute commands' });
    }
  });

  app.get('/api/fs/exec/:jobId', (req, res) => {
    const jobId = typeof req.params?.jobId === 'string' ? req.params.jobId : '';
    if (!jobId) {
      return res.status(400).json({ error: 'Job id is required' });
    }

    pruneExecJobs();

    const job = execJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    job.updatedAt = Date.now();

    return res.json({
      jobId: job.jobId,
      status: job.status,
      success: job.success === true,
      results: Array.isArray(job.results) ? job.results : [],
    });
  });

  app.post('/api/opencode/directory', async (req, res) => {
    try {
      const requestedPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
      if (!requestedPath) {
        return res.status(400).json({ error: 'Path is required' });
      }

      const validated = await validateDirectoryPath(requestedPath);
      if (!validated.ok) {
        return res.status(400).json({ error: validated.error });
      }

      const resolvedPath = validated.directory;
      const currentSettings = await readSettingsFromDisk();
      const existingProjects = sanitizeProjects(currentSettings.projects) || [];
      const existing = existingProjects.find((project) => project.path === resolvedPath) || null;

      const nextProjects = existing
        ? existingProjects
        : [
            ...existingProjects,
            {
              id: crypto.randomUUID(),
              path: resolvedPath,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
            },
          ];

      const activeProjectId = existing ? existing.id : nextProjects[nextProjects.length - 1].id;

      const updated = await persistSettings({
        projects: nextProjects,
        activeProjectId,
        lastDirectory: resolvedPath,
      });

      res.json({
        success: true,
        restarted: false,
        path: resolvedPath,
        settings: updated,
      });
    } catch (error) {
      console.error('Failed to update OpenCode working directory:', error);
      res.status(500).json({ error: error.message || 'Failed to update working directory' });
    }
  });

  app.get('/api/fs/list', async (req, res) => {
    const rawPath = typeof req.query.path === 'string' && req.query.path.trim().length > 0
      ? req.query.path.trim()
      : os.homedir();
    const respectGitignore = req.query.respectGitignore === 'true';
    let resolvedPath = '';

    const isPlansDirectory = (value) => {
      if (!value || typeof value !== 'string') return false;
      const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalized.endsWith('/.opencode/plans') || normalized.endsWith('.opencode/plans');
    };

    try {
      resolvedPath = path.resolve(normalizeDirectoryPath(rawPath));

      const stats = await fsPromises.stat(resolvedPath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified path is not a directory' });
      }

      const dirents = await fsPromises.readdir(resolvedPath, { withFileTypes: true });

      // Get gitignored paths if requested
      let ignoredPaths = new Set();
      if (respectGitignore) {
        try {
          // Get all entry paths to check (relative to resolvedPath for git check-ignore)
          const pathsToCheck = dirents.map((d) => d.name);

          if (pathsToCheck.length > 0) {
            try {
              // Use git check-ignore with paths as arguments
              // Pass paths directly as arguments (works for reasonable directory sizes)
              const result = await new Promise((resolve) => {
                const child = spawn('git', ['check-ignore', '--', ...pathsToCheck], {
                  cwd: resolvedPath,
                  stdio: ['ignore', 'pipe', 'pipe'],
                });

                let stdout = '';
                child.stdout.on('data', (data) => { stdout += data.toString(); });
                child.on('close', () => resolve(stdout));
                child.on('error', () => resolve(''));
              });

              result.split('\n').filter(Boolean).forEach((name) => {
                const fullPath = path.join(resolvedPath, name.trim());
                ignoredPaths.add(fullPath);
              });
            } catch {
              // git check-ignore fails if not a git repo, continue without filtering
            }
          }
        } catch {
          // If git is not available, continue without gitignore filtering
        }
      }

      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          const entryPath = path.join(resolvedPath, dirent.name);

          // Skip gitignored entries
          if (respectGitignore && ignoredPaths.has(entryPath)) {
            return null;
          }

          let isDirectory = dirent.isDirectory();
          const isSymbolicLink = dirent.isSymbolicLink();

          if (!isDirectory && isSymbolicLink) {
            try {
              const linkStats = await fsPromises.stat(entryPath);
              isDirectory = linkStats.isDirectory();
            } catch {
              isDirectory = false;
            }
          }

          return {
            name: dirent.name,
            path: entryPath,
            isDirectory,
            isFile: dirent.isFile(),
            isSymbolicLink
          };
        })
      );

      res.json({
        path: resolvedPath,
        entries: entries.filter(Boolean)
      });
    } catch (error) {
      const err = error;
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      const isPlansPath = code === 'ENOENT' && (isPlansDirectory(resolvedPath) || isPlansDirectory(rawPath));
      if (!isPlansPath) {
        console.error('Failed to list directory:', error);
      }
      if (code === 'ENOENT') {
        // Return empty result for plans directory (expected to not exist until first use)
        if (isPlansPath) {
          return res.json({ path: resolvedPath || rawPath, entries: [] });
        }
        return res.status(404).json({ error: 'Directory not found' });
      }
      if (code === 'EACCES') {
        return res.status(403).json({ error: 'Access to directory denied' });
      }
      res.status(500).json({ error: (error && error.message) || 'Failed to list directory' });
    }
  });

  app.get('/api/fs/search', async (req, res) => {
    const rawRoot = typeof req.query.root === 'string' && req.query.root.trim().length > 0
      ? req.query.root.trim()
      : typeof req.query.directory === 'string' && req.query.directory.trim().length > 0
        ? req.query.directory.trim()
        : os.homedir();
  const rawQuery = typeof req.query.q === 'string' ? req.query.q : '';
  const includeHidden = req.query.includeHidden === 'true';
  const respectGitignore = req.query.respectGitignore !== 'false';
  const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
    const parsedLimit = Number.isFinite(limitParam) ? Number(limitParam) : DEFAULT_FILE_SEARCH_LIMIT;
    const limit = Math.max(1, Math.min(parsedLimit, MAX_FILE_SEARCH_LIMIT));

    try {
      const resolvedRoot = path.resolve(normalizeDirectoryPath(rawRoot));
      const stats = await fsPromises.stat(resolvedRoot);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Specified root is not a directory' });
      }

      const files = await searchFilesystemFiles(resolvedRoot, {
        limit,
        query: rawQuery || '',
        includeHidden,
        respectGitignore,
      });
      res.json({
        root: resolvedRoot,
        count: files.length,
        files
      });
    } catch (error) {
      console.error('Failed to search filesystem:', error);
      const err = error;
      if (err && typeof err === 'object' && 'code' in err) {
        const code = err.code;
        if (code === 'ENOENT') {
          return res.status(404).json({ error: 'Directory not found' });
        }
        if (code === 'EACCES') {
          return res.status(403).json({ error: 'Access to directory denied' });
        }
      }
      res.status(500).json({ error: (error && error.message) || 'Failed to search files' });
    }
  });

  let ptyProviderPromise = null;
  const getPtyProvider = async () => {
    if (ptyProviderPromise) {
      return ptyProviderPromise;
    }

    ptyProviderPromise = (async () => {
      const isBunRuntime = typeof globalThis.Bun !== 'undefined';

      if (isBunRuntime) {
        try {
          const bunPty = await import('bun-pty');
          console.log('Using bun-pty for terminal sessions');
          return { spawn: bunPty.spawn, backend: 'bun-pty' };
        } catch (error) {
          console.warn('bun-pty unavailable, falling back to node-pty');
        }
      }

      try {
        const nodePty = await import('node-pty');
        console.log('Using node-pty for terminal sessions');
        return { spawn: nodePty.spawn, backend: 'node-pty' };
      } catch (error) {
        console.error('Failed to load node-pty:', error && error.message ? error.message : error);
        if (isBunRuntime) {
          throw new Error('No PTY backend available. Install bun-pty or node-pty.');
        }
        throw new Error('node-pty is not available. Run: npm rebuild node-pty (or install Bun for bun-pty)');
      }
    })();

    return ptyProviderPromise;
  };

  const terminalSessions = new Map();
  const MAX_TERMINAL_SESSIONS = 20;
  const TERMINAL_IDLE_TIMEOUT = 30 * 60 * 1000;
  const terminalInputCapabilities = {
    input: {
      preferred: 'ws',
      transports: ['http', 'ws'],
      ws: {
        path: TERMINAL_INPUT_WS_PATH,
        v: 1,
        enc: 'text+json-bin-control',
      },
    },
  };

  const sendTerminalInputWsControl = (socket, payload) => {
    if (!socket || socket.readyState !== 1) {
      return;
    }

    try {
      socket.send(createTerminalInputWsControlFrame(payload), { binary: true });
    } catch {
    }
  };

  terminalInputWsServer = new WebSocketServer({
    noServer: true,
    maxPayload: TERMINAL_INPUT_WS_MAX_PAYLOAD_BYTES,
  });

  terminalInputWsServer.on('connection', (socket) => {
    const connectionState = {
      boundSessionId: null,
      invalidFrames: 0,
      rebindTimestamps: [],
      lastActivityAt: Date.now(),
    };

    sendTerminalInputWsControl(socket, { t: 'ok', v: 1 });

    const heartbeatInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
      }
    }, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS);

    socket.on('pong', () => {
      connectionState.lastActivityAt = Date.now();
    });

    socket.on('message', (message, isBinary) => {
      connectionState.lastActivityAt = Date.now();

      if (isBinary) {
        const controlMessage = readTerminalInputWsControlFrame(message);
        if (!controlMessage || typeof controlMessage.t !== 'string') {
          connectionState.invalidFrames += 1;
          sendTerminalInputWsControl(socket, {
            t: 'e',
            c: 'BAD_FRAME',
            f: connectionState.invalidFrames >= 10,
          });
          if (connectionState.invalidFrames >= 10) {
            socket.close(1008, 'protocol violation');
          }
          return;
        }

        if (controlMessage.t === 'p') {
          sendTerminalInputWsControl(socket, { t: 'po', v: 1 });
          return;
        }

        if (controlMessage.t !== 'b' || typeof controlMessage.s !== 'string') {
          connectionState.invalidFrames += 1;
          sendTerminalInputWsControl(socket, {
            t: 'e',
            c: 'BAD_FRAME',
            f: connectionState.invalidFrames >= 10,
          });
          if (connectionState.invalidFrames >= 10) {
            socket.close(1008, 'protocol violation');
          }
          return;
        }

        const now = Date.now();
        connectionState.rebindTimestamps = pruneRebindTimestamps(
          connectionState.rebindTimestamps,
          now,
          TERMINAL_INPUT_WS_REBIND_WINDOW_MS
        );

        if (isRebindRateLimited(connectionState.rebindTimestamps, TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW)) {
          sendTerminalInputWsControl(socket, { t: 'e', c: 'RATE_LIMIT', f: false });
          return;
        }

        const nextSessionId = controlMessage.s.trim();
        const targetSession = terminalSessions.get(nextSessionId);
        if (!targetSession) {
          connectionState.boundSessionId = null;
          sendTerminalInputWsControl(socket, { t: 'e', c: 'SESSION_NOT_FOUND', f: false });
          return;
        }

        connectionState.rebindTimestamps.push(now);
        connectionState.boundSessionId = nextSessionId;
        sendTerminalInputWsControl(socket, { t: 'bok', v: 1 });
        return;
      }

      const payload = normalizeTerminalInputWsMessageToText(message);
      if (payload.length === 0) {
        return;
      }

      if (!connectionState.boundSessionId) {
        sendTerminalInputWsControl(socket, { t: 'e', c: 'NOT_BOUND', f: false });
        return;
      }

      const session = terminalSessions.get(connectionState.boundSessionId);
      if (!session) {
        connectionState.boundSessionId = null;
        sendTerminalInputWsControl(socket, { t: 'e', c: 'SESSION_NOT_FOUND', f: false });
        return;
      }

      try {
        session.ptyProcess.write(payload);
        session.lastActivity = Date.now();
      } catch {
        sendTerminalInputWsControl(socket, { t: 'e', c: 'WRITE_FAIL', f: false });
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeatInterval);
    });

    socket.on('error', (error) => {
      void error;
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== TERMINAL_INPUT_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
        if (uiAuthController?.enabled) {
          const sessionToken = uiAuthController?.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }

        if (!terminalInputWsServer) {
          rejectWebSocketUpgrade(socket, 500, 'Terminal WebSocket unavailable');
          return;
        }

        terminalInputWsServer.handleUpgrade(req, socket, head, (ws) => {
          terminalInputWsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };

    void handleUpgrade();
  });

  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of terminalSessions.entries()) {
      if (now - session.lastActivity > TERMINAL_IDLE_TIMEOUT) {
        console.log(`Cleaning up idle terminal session: ${sessionId}`);
        try {
          session.ptyProcess.kill();
        } catch (error) {

        }
        terminalSessions.delete(sessionId);
      }
    }
  }, 5 * 60 * 1000);

  app.post('/api/terminal/create', async (req, res) => {
    try {
      if (terminalSessions.size >= MAX_TERMINAL_SESSIONS) {
        return res.status(429).json({ error: 'Maximum terminal sessions reached' });
      }

      const { cwd, cols, rows } = req.body;
      if (!cwd) {
        return res.status(400).json({ error: 'cwd is required' });
      }

      try {
        await fs.promises.access(cwd);
      } catch {
        return res.status(400).json({ error: 'Invalid working directory' });
      }

      const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

      const sessionId = Math.random().toString(36).substring(2, 15) +
                        Math.random().toString(36).substring(2, 15);

      const envPath = buildAugmentedPath();
      const resolvedEnv = { ...process.env, PATH: envPath };

      const pty = await getPtyProvider();
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: cwd,
        env: {
          ...resolvedEnv,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      });

      const session = {
        ptyProcess,
        ptyBackend: pty.backend,
        cwd,
        lastActivity: Date.now(),
        clients: new Set(),
      };

      terminalSessions.set(sessionId, session);

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
        terminalSessions.delete(sessionId);
      });

      console.log(`Created terminal session: ${sessionId} in ${cwd}`);
      res.json({ sessionId, cols: cols || 80, rows: rows || 24, capabilities: terminalInputCapabilities });
    } catch (error) {
      console.error('Failed to create terminal session:', error);
      res.status(500).json({ error: error.message || 'Failed to create terminal session' });
    }
  });

  app.get('/api/terminal/:sessionId/stream', (req, res) => {
    const { sessionId } = req.params;
    const session = terminalSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const clientId = Math.random().toString(36).substring(7);
    session.clients.add(clientId);
    session.lastActivity = Date.now();

    const runtime = typeof globalThis.Bun === 'undefined' ? 'node' : 'bun';
    const ptyBackend = session.ptyBackend || 'unknown';
    res.write(`data: ${JSON.stringify({ type: 'connected', runtime, ptyBackend })}\n\n`);

    const heartbeatInterval = setInterval(() => {
      try {

        res.write(': heartbeat\n\n');
      } catch (error) {
        console.error(`Heartbeat failed for client ${clientId}:`, error);
        clearInterval(heartbeatInterval);
      }
    }, 15000);

    const dataHandler = (data) => {
      try {
        session.lastActivity = Date.now();
        const ok = res.write(`data: ${JSON.stringify({ type: 'data', data })}\n\n`);
        if (!ok && session.ptyProcess && typeof session.ptyProcess.pause === 'function') {
          session.ptyProcess.pause();
          res.once('drain', () => {
            if (session.ptyProcess && typeof session.ptyProcess.resume === 'function') {
              session.ptyProcess.resume();
            }
          });
        }
      } catch (error) {
        console.error(`Error sending data to client ${clientId}:`, error);
        cleanup();
      }
    };

    const exitHandler = ({ exitCode, signal }) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'exit', exitCode, signal })}\n\n`);
        res.end();
      } catch (error) {

      }
      cleanup();
    };

    const dataDisposable = session.ptyProcess.onData(dataHandler);
    const exitDisposable = session.ptyProcess.onExit(exitHandler);

    const cleanup = () => {
      clearInterval(heartbeatInterval);
      session.clients.delete(clientId);

      if (dataDisposable && typeof dataDisposable.dispose === 'function') {
        dataDisposable.dispose();
      }
      if (exitDisposable && typeof exitDisposable.dispose === 'function') {
        exitDisposable.dispose();
      }

      try {
        res.end();
      } catch (error) {

      }

      console.log(`Client ${clientId} disconnected from terminal session ${sessionId}`);
    };

    req.on('close', cleanup);
    req.on('error', cleanup);

    console.log(`Terminal connected: session=${sessionId} client=${clientId} runtime=${runtime} pty=${ptyBackend}`);
  });

  app.post('/api/terminal/:sessionId/input', express.text({ type: '*/*' }), (req, res) => {
    const { sessionId } = req.params;
    const session = terminalSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    const data = typeof req.body === 'string' ? req.body : '';

    try {
      session.ptyProcess.write(data);
      session.lastActivity = Date.now();
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to write to terminal:', error);
      res.status(500).json({ error: error.message || 'Failed to write to terminal' });
    }
  });

  app.post('/api/terminal/:sessionId/resize', (req, res) => {
    const { sessionId } = req.params;
    const session = terminalSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    const { cols, rows } = req.body;
    if (!cols || !rows) {
      return res.status(400).json({ error: 'cols and rows are required' });
    }

    try {
      session.ptyProcess.resize(cols, rows);
      session.lastActivity = Date.now();
      res.json({ success: true, cols, rows });
    } catch (error) {
      console.error('Failed to resize terminal:', error);
      res.status(500).json({ error: error.message || 'Failed to resize terminal' });
    }
  });

  app.delete('/api/terminal/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = terminalSessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }

    try {
      session.ptyProcess.kill();
      terminalSessions.delete(sessionId);
      console.log(`Closed terminal session: ${sessionId}`);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to close terminal:', error);
      res.status(500).json({ error: error.message || 'Failed to close terminal' });
    }
  });

  app.post('/api/terminal/:sessionId/restart', async (req, res) => {
    const { sessionId } = req.params;
    const { cwd, cols, rows } = req.body;

    if (!cwd) {
      return res.status(400).json({ error: 'cwd is required' });
    }

    const existingSession = terminalSessions.get(sessionId);
    if (existingSession) {
      try {
        existingSession.ptyProcess.kill();
      } catch (error) {
      }
      terminalSessions.delete(sessionId);
    }

    try {
      try {
        const stats = await fs.promises.stat(cwd);
        if (!stats.isDirectory()) {
          return res.status(400).json({ error: 'Invalid working directory: not a directory' });
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid working directory: not accessible' });
      }

      const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

      const newSessionId = Math.random().toString(36).substring(2, 15) +
                          Math.random().toString(36).substring(2, 15);

      const envPath = buildAugmentedPath();
      const resolvedEnv = { ...process.env, PATH: envPath };

      const pty = await getPtyProvider();
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: cwd,
        env: {
          ...resolvedEnv,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        },
      });

      const session = {
        ptyProcess,
        ptyBackend: pty.backend,
        cwd,
        lastActivity: Date.now(),
        clients: new Set(),
      };

      terminalSessions.set(newSessionId, session);

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`Terminal session ${newSessionId} exited with code ${exitCode}, signal ${signal}`);
        terminalSessions.delete(newSessionId);
      });

      console.log(`Restarted terminal session: ${sessionId} -> ${newSessionId} in ${cwd}`);
      res.json({ sessionId: newSessionId, cols: cols || 80, rows: rows || 24, capabilities: terminalInputCapabilities });
    } catch (error) {
      console.error('Failed to restart terminal session:', error);
      res.status(500).json({ error: error.message || 'Failed to restart terminal session' });
    }
  });

  app.post('/api/terminal/force-kill', (req, res) => {
    const { sessionId, cwd } = req.body;
    let killedCount = 0;

    if (sessionId) {
      const session = terminalSessions.get(sessionId);
      if (session) {
        try {
          session.ptyProcess.kill();
        } catch (error) {
        }
        terminalSessions.delete(sessionId);
        killedCount++;
      }
    } else if (cwd) {
      for (const [id, session] of terminalSessions) {
        if (session.cwd === cwd) {
          try {
            session.ptyProcess.kill();
          } catch (error) {
          }
          terminalSessions.delete(id);
          killedCount++;
        }
      }
    } else {
      for (const [id, session] of terminalSessions) {
        try {
          session.ptyProcess.kill();
        } catch (error) {
        }
        terminalSessions.delete(id);
        killedCount++;
      }
    }

    console.log(`Force killed ${killedCount} terminal session(s)`);
    res.json({ success: true, killedCount });
  });

  try {
    syncFromHmrState();
    if (await isOpenCodeProcessHealthy()) {
      console.log(`[HMR] Reusing existing OpenCode process on port ${openCodePort}`);
    } else if (ENV_SKIP_OPENCODE_START && ENV_CONFIGURED_OPENCODE_PORT) {
      console.log(`Using external OpenCode server on port ${ENV_CONFIGURED_OPENCODE_PORT} (skip-start mode)`);
      setOpenCodePort(ENV_CONFIGURED_OPENCODE_PORT);
      isOpenCodeReady = true;
      isExternalOpenCode = true;
      lastOpenCodeError = null;
      openCodeNotReadySince = 0;
      syncToHmrState();
    } else if (ENV_CONFIGURED_OPENCODE_PORT && await probeExternalOpenCode(ENV_CONFIGURED_OPENCODE_PORT)) {
      console.log(`Auto-detected existing OpenCode server on port ${ENV_CONFIGURED_OPENCODE_PORT}`);
      setOpenCodePort(ENV_CONFIGURED_OPENCODE_PORT);
      isOpenCodeReady = true;
      isExternalOpenCode = true;
      lastOpenCodeError = null;
      openCodeNotReadySince = 0;
      syncToHmrState();
    } else if (!ENV_CONFIGURED_OPENCODE_PORT && await probeExternalOpenCode(4096)) {
      console.log('Auto-detected existing OpenCode server on default port 4096');
      setOpenCodePort(4096);
      isOpenCodeReady = true;
      isExternalOpenCode = true;
      lastOpenCodeError = null;
      openCodeNotReadySince = 0;
      syncToHmrState();
    } else {
      if (ENV_CONFIGURED_OPENCODE_PORT) {
        console.log(`Using OpenCode port from environment: ${ENV_CONFIGURED_OPENCODE_PORT}`);
        setOpenCodePort(ENV_CONFIGURED_OPENCODE_PORT);
      } else {
        openCodePort = null;
        syncToHmrState();
      }

      lastOpenCodeError = null;
      openCodeProcess = await startOpenCode();
      syncToHmrState();
    }
    await waitForOpenCodePort();
    try {
      await waitForOpenCodeReady();
    } catch (error) {
      console.error(`OpenCode readiness check failed: ${error.message}`);
      scheduleOpenCodeApiDetection();
    }
    setupProxy(app);
    scheduleOpenCodeApiDetection();
    startHealthMonitoring();
    void startGlobalEventWatcher();
  } catch (error) {
    console.error(`Failed to start OpenCode: ${error.message}`);
    console.log('Continuing without OpenCode integration...');
    lastOpenCodeError = error.message;
    setupProxy(app);
    scheduleOpenCodeApiDetection();
  }

  const distPath = (() => {
    const env = typeof process.env.OPENCHAMBER_DIST_DIR === 'string' ? process.env.OPENCHAMBER_DIST_DIR.trim() : '';
    if (env) {
      return path.resolve(env);
    }
    return path.join(__dirname, '..', 'dist');
  })();

    if (fs.existsSync(distPath)) {
      console.log(`Serving static files from ${distPath}`);
      app.use(express.static(distPath, {
        setHeaders(res, filePath) {
          // Service workers should never be long-cached; iOS is especially sensitive.
          if (typeof filePath === 'string' && filePath.endsWith(`${path.sep}sw.js`)) {
            res.setHeader('Cache-Control', 'no-store');
          }
        },
      }));

      // Alias for PWA manifest (.webmanifest redirect → /site.webmanifest)
      app.get('/manifest.webmanifest', (req, res) => {
        res.redirect(301, '/site.webmanifest');
      });

    app.get(/^(?!\/api|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    console.warn(`Warning: ${distPath} not found, static files will not be served`);
    app.get(/^(?!\/api|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (req, res) => {
      res.status(404).send('Static files not found. Please build the application first.');
    });
  }

  let activePort = port;

  const bindHost = typeof process.env.OPENCHAMBER_HOST === 'string' && process.env.OPENCHAMBER_HOST.trim().length > 0
    ? process.env.OPENCHAMBER_HOST.trim()
    : null;

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    const onListening = async () => {
      server.off('error', onError);
      const addressInfo = server.address();
      activePort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;

      try {
        process.send?.({ type: 'openchamber:ready', port: activePort });
      } catch {
        // ignore
      }

      console.log(`OpenChamber server running on port ${activePort}`);
      console.log(`Health check: http://localhost:${activePort}/health`);
      console.log(`Web interface: http://localhost:${activePort}`);

      if (tryCfTunnel) {
        console.log('\nInitializing Cloudflare Quick Tunnel...');
        const cfCheck = await checkCloudflaredAvailable();
        if (cfCheck.available) {
          try {
            const originUrl = `http://localhost:${activePort}`;
            cloudflareTunnelController = await startCloudflareTunnel({ originUrl, port: activePort });
            printTunnelWarning();
            if (onTunnelReady) {
              const tunnelUrl = cloudflareTunnelController.getPublicUrl();
              if (tunnelUrl) {
                onTunnelReady(tunnelUrl);
              }
            }
          } catch (error) {
            console.error(`Failed to start Cloudflare tunnel: ${error.message}`);
            console.log('Continuing without tunnel...');
          }
        }
      }

      resolve();
    };

    if (bindHost) {
      server.listen(port, bindHost, onListening);
    } else {
      server.listen(port, onListening);
    }
  });

  if (attachSignals && !signalsAttached) {
    const handleSignal = async () => {
      await gracefulShutdown();
    };
    process.on('SIGTERM', handleSignal);
    process.on('SIGINT', handleSignal);
    process.on('SIGQUIT', handleSignal);
    signalsAttached = true;
    syncToHmrState();
  }

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown();
  });

  return {
    expressApp: app,
    httpServer: server,
    getPort: () => activePort,
    getOpenCodePort: () => openCodePort,
    getTunnelUrl: () => cloudflareTunnelController?.getPublicUrl() ?? null,
    isReady: () => isOpenCodeReady,
    restartOpenCode: () => restartOpenCode(),
    stop: (shutdownOptions = {}) =>
      gracefulShutdown({ exitProcess: shutdownOptions.exitProcess ?? false })
  };
}

const isCliExecution = process.argv[1] === __filename;

if (isCliExecution) {
  const cliOptions = parseArgs();
  exitOnShutdown = true;
  main({
    port: cliOptions.port,
    tryCfTunnel: cliOptions.tryCfTunnel,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword
  }).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

export { gracefulShutdown, setupProxy, restartOpenCode, main as startWebUiServer, parseArgs };
