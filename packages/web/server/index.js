import express from 'express';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import os from 'os';
import crypto from 'crypto';
import { createUiAuth } from './lib/opencode/ui-auth.js';
import { createTunnelAuth } from './lib/opencode/tunnel-auth.js';
import {
  printTunnelWarning,
} from './lib/cloudflare-tunnel.js';
import { createManagedTunnelConfigRuntime } from './lib/tunnels/managed-config.js';
import { createTunnelService } from './lib/tunnels/index.js';
import { createTunnelProviderRegistry } from './lib/tunnels/registry.js';
import { createCloudflareTunnelProvider } from './lib/tunnels/providers/cloudflare.js';
import { createTunnelRoutesRuntime } from './lib/tunnels/routes.js';
import { createRequestSecurityRuntime } from './lib/security/request-security.js';
import {
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  isSupportedTunnelMode,
  normalizeOptionalPath,
  normalizeTunnelStartRequest,
  normalizeTunnelMode,
  normalizeTunnelProvider,
} from './lib/tunnels/types.js';
import { prepareNotificationLastMessage } from './lib/notifications/index.js';
import { registerTtsRoutes } from './lib/tts/routes.js';
import { registerQuotaRoutes } from './lib/quota/routes.js';
import { registerGitHubRoutes } from './lib/github/routes.js';
import { registerGitRoutes } from './lib/git/routes.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import { registerFsRoutes } from './lib/fs/routes.js';
import { createFsSearchRuntime as createFsSearchRuntimeFactory } from './lib/fs/search.js';
import { createOpenCodeLifecycleRuntime } from './lib/opencode/lifecycle.js';
import { createOpenCodeEnvRuntime } from './lib/opencode/env-runtime.js';
import { createOpenCodeNetworkRuntime } from './lib/opencode/network-runtime.js';
import { createProjectDirectoryRuntime } from './lib/opencode/project-directory-runtime.js';
import { registerConfigEntityRoutes } from './lib/opencode/config-entity-routes.js';
import { registerProjectIconRoutes } from './lib/opencode/project-icon-routes.js';
import { registerSkillRoutes } from './lib/opencode/skill-routes.js';
import { registerOpenCodeProxy } from './lib/opencode/proxy.js';
import { registerOpenCodeRoutes } from './lib/opencode/routes.js';
import { createSettingsRuntime } from './lib/opencode/settings-runtime.js';
import { createSessionRuntime } from './lib/opencode/session-runtime.js';
import { createOpenCodeWatcherRuntime } from './lib/opencode/watcher.js';
import { registerNotificationRoutes } from './lib/notifications/routes.js';
import { createNotificationTriggerRuntime } from './lib/notifications/runtime.js';
import { createPushRuntime } from './lib/notifications/push-runtime.js';
import { createNotificationTemplateRuntime } from './lib/notifications/template-runtime.js';
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
const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const OPENCHAMBER_VERSION = (() => {
  try {
    const packagePath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(packagePath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
  }
  return 'unknown';
})();
const fsPromises = fs.promises;

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

const normalizePathForPersistence = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const normalized = normalizeDirectoryPath(value);
  if (typeof normalized !== 'string') {
    return normalized;
  }

  const trimmed = normalized.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (process.platform !== 'win32') {
    return trimmed;
  }

  return trimmed.replace(/\//g, '\\');
};

const areStringArraysEqual = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

const normalizeSettingsPaths = (input) => {
  const settings = input && typeof input === 'object' ? input : {};
  let next = settings;
  let changed = false;

  const ensureNext = () => {
    if (next === settings) {
      next = { ...settings };
    }
  };

  const normalizePathField = (key) => {
    if (typeof settings[key] !== 'string' || settings[key].length === 0) {
      return;
    }
    const normalized = normalizePathForPersistence(settings[key]);
    if (normalized !== settings[key]) {
      ensureNext();
      next[key] = normalized;
      changed = true;
    }
  };

  const normalizePathArrayField = (key) => {
    if (!Array.isArray(settings[key])) {
      return;
    }

    const normalized = normalizeStringArray(
      settings[key]
        .map((entry) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
        .filter((entry) => typeof entry === 'string' && entry.length > 0)
    );

    if (!areStringArraysEqual(normalized, settings[key])) {
      ensureNext();
      next[key] = normalized;
      changed = true;
    }
  };

  normalizePathField('lastDirectory');
  normalizePathField('homeDirectory');
  normalizePathArrayField('approvedDirectories');
  normalizePathArrayField('pinnedDirectories');

  if (Array.isArray(settings.projects)) {
    const normalizedProjects = sanitizeProjects(settings.projects) || [];
    if (JSON.stringify(normalizedProjects) !== JSON.stringify(settings.projects)) {
      ensureNext();
      next.projects = normalizedProjects;
      changed = true;
    }
  }

  return { settings: next, changed };
};

const OPENCHAMBER_USER_CONFIG_ROOT = path.join(os.homedir(), '.config', 'openchamber');
const OPENCHAMBER_USER_THEMES_DIR = path.join(OPENCHAMBER_USER_CONFIG_ROOT, 'themes');

const MAX_THEME_JSON_BYTES = 512 * 1024;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

const normalizeTunnelBootstrapTtlMs = (value) => {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS;
  }
  return clampNumber(Math.round(value), TUNNEL_BOOTSTRAP_TTL_MIN_MS, TUNNEL_BOOTSTRAP_TTL_MAX_MS);
};

const normalizeTunnelSessionTtlMs = (value) => {
  if (!Number.isFinite(value)) {
    return TUNNEL_SESSION_TTL_DEFAULT_MS;
  }
  return clampNumber(Math.round(value), TUNNEL_SESSION_TTL_MIN_MS, TUNNEL_SESSION_TTL_MAX_MS);
};

const normalizeManagedRemoteTunnelHostname = (value) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = (() => {
    try {
      if (trimmed.includes('://')) {
        return new URL(trimmed);
      }
      return new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  })();

  const hostname = parsed?.hostname?.trim().toLowerCase() || '';
  if (!hostname) {
    return undefined;
  }
  return hostname;
};

const normalizeManagedRemoteTunnelPresets = (value) => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result = [];
  const seenIds = new Set();
  const seenHostnames = new Set();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const hostname = normalizeManagedRemoteTunnelHostname(candidate.hostname);
    if (!id || !name || !hostname) continue;
    if (seenIds.has(id) || seenHostnames.has(hostname)) continue;
    seenIds.add(id);
    seenHostnames.add(hostname);
    result.push({ id, name, hostname });
  }

  return result;
};

const normalizeManagedRemoteTunnelPresetTokens = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const result = {};
  for (const [rawId, rawToken] of Object.entries(value)) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    const token = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!id || !token) {
      continue;
    }
    result[id] = token;
  }

  return Object.keys(result).length > 0 ? result : undefined;
};

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

let notificationTemplateRuntime = null;

const createTimeoutSignal = (...args) => notificationTemplateRuntime.createTimeoutSignal(...args);
const formatProjectLabel = (...args) => notificationTemplateRuntime.formatProjectLabel(...args);
const resolveNotificationTemplate = (...args) => notificationTemplateRuntime.resolveNotificationTemplate(...args);
const shouldApplyResolvedTemplateMessage = (...args) => notificationTemplateRuntime.shouldApplyResolvedTemplateMessage(...args);
const fetchFreeZenModels = (...args) => notificationTemplateRuntime.fetchFreeZenModels(...args);
const resolveZenModel = (...args) => notificationTemplateRuntime.resolveZenModel(...args);
const validateZenModelAtStartup = (...args) => notificationTemplateRuntime.validateZenModelAtStartup(...args);
const summarizeText = (...args) => notificationTemplateRuntime.summarizeText(...args);
const extractTextFromParts = (...args) => notificationTemplateRuntime.extractTextFromParts(...args);
const extractLastMessageText = (...args) => notificationTemplateRuntime.extractLastMessageText(...args);
const fetchLastAssistantMessageText = (...args) => notificationTemplateRuntime.fetchLastAssistantMessageText(...args);
const maybeCacheSessionInfoFromEvent = (...args) => notificationTemplateRuntime.maybeCacheSessionInfoFromEvent(...args);
const buildTemplateVariables = (...args) => notificationTemplateRuntime.buildTemplateVariables(...args);
const getCachedZenModels = (...args) => notificationTemplateRuntime.getCachedZenModels(...args);

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');
const SETTINGS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');
const PUSH_SUBSCRIPTIONS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'push-subscriptions.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-managed-remote-tunnels.json');
const CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH = path.join(OPENCHAMBER_DATA_DIR, 'cloudflare-named-tunnels.json');
const CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION = 1;

const managedTunnelConfigRuntime = createManagedTunnelConfigRuntime({
  fsPromises,
  path,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  constants: {
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_FILE_PATH,
    CLOUDFLARE_LEGACY_NAMED_TUNNELS_FILE_PATH,
    CLOUDFLARE_MANAGED_REMOTE_TUNNELS_VERSION,
  },
});

const readManagedRemoteTunnelConfigFromDisk = (...args) => managedTunnelConfigRuntime.readManagedRemoteTunnelConfigFromDisk(...args);
const syncManagedRemoteTunnelConfigWithPresets = (...args) => managedTunnelConfigRuntime.syncManagedRemoteTunnelConfigWithPresets(...args);
const upsertManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.upsertManagedRemoteTunnelToken(...args);
const resolveManagedRemoteTunnelToken = (...args) => managedTunnelConfigRuntime.resolveManagedRemoteTunnelToken(...args);

const isUnsafeSkillRelativePath = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return true;
  }

  const normalized = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized)) {
    return true;
  }

  return normalized.split('/').some((segment) => segment === '..');
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

  const hexColorPattern = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;
  const normalizeIconBackground = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return hexColorPattern.test(trimmed) ? trimmed.toLowerCase() : null;
  };

  const result = [];
  const seenIds = new Set();
  const seenPaths = new Set();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;

    const candidate = entry;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    const resolvedPath = rawPath ? path.resolve(normalizeDirectoryPath(rawPath)) : '';
    const normalizedPath = resolvedPath ? normalizePathForPersistence(resolvedPath) : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const icon = typeof candidate.icon === 'string' ? candidate.icon.trim() : '';
    const iconImage = candidate.iconImage && typeof candidate.iconImage === 'object'
      ? candidate.iconImage
      : null;
    const iconBackground = normalizeIconBackground(candidate.iconBackground);
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
      ...(iconBackground ? { iconBackground } : {}),
      ...(color ? { color } : {}),
      ...(Number.isFinite(addedAt) && addedAt >= 0 ? { addedAt } : {}),
      ...(Number.isFinite(lastOpenedAt) && lastOpenedAt >= 0 ? { lastOpenedAt } : {}),
    };

    if (candidate.iconImage === null) {
      project.iconImage = null;
    } else if (iconImage) {
      const mime = typeof iconImage.mime === 'string' ? iconImage.mime.trim() : '';
      const updatedAt = typeof iconImage.updatedAt === 'number' && Number.isFinite(iconImage.updatedAt)
        ? Math.max(0, Math.round(iconImage.updatedAt))
        : 0;
      const source = iconImage.source === 'custom' || iconImage.source === 'auto'
        ? iconImage.source
        : null;
      if (mime && updatedAt > 0 && source) {
        project.iconImage = { mime, updatedAt, source };
      }
    }

    if (candidate.iconBackground === null) {
      project.iconBackground = null;
    }

    if (typeof candidate.sidebarCollapsed === 'boolean') {
      project.sidebarCollapsed = candidate.sidebarCollapsed;
    }

    result.push(project);
  }

  return result;
};

const DEFAULT_PWA_APP_NAME = 'OpenChamber - AI Coding Assistant';
const PWA_APP_NAME_MAX_LENGTH = 64;

const normalizePwaAppName = (value, fallback = '') => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, PWA_APP_NAME_MAX_LENGTH);
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
  if (typeof candidate.splashBgLight === 'string' && candidate.splashBgLight.trim().length > 0) {
    result.splashBgLight = candidate.splashBgLight.trim();
  }
  if (typeof candidate.splashFgLight === 'string' && candidate.splashFgLight.trim().length > 0) {
    result.splashFgLight = candidate.splashFgLight.trim();
  }
  if (typeof candidate.splashBgDark === 'string' && candidate.splashBgDark.trim().length > 0) {
    result.splashBgDark = candidate.splashBgDark.trim();
  }
  if (typeof candidate.splashFgDark === 'string' && candidate.splashFgDark.trim().length > 0) {
    result.splashFgDark = candidate.splashFgDark.trim();
  }
  if (typeof candidate.lastDirectory === 'string' && candidate.lastDirectory.length > 0) {
    const normalized = normalizePathForPersistence(candidate.lastDirectory);
    if (typeof normalized === 'string' && normalized.length > 0) {
      result.lastDirectory = normalized;
    }
  }
  if (typeof candidate.homeDirectory === 'string' && candidate.homeDirectory.length > 0) {
    const normalized = normalizePathForPersistence(candidate.homeDirectory);
    if (typeof normalized === 'string' && normalized.length > 0) {
      result.homeDirectory = normalized;
    }
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
    result.approvedDirectories = normalizeStringArray(
      candidate.approvedDirectories
        .map((entry) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
        .filter((entry) => typeof entry === 'string' && entry.length > 0)
    );
  }
  if (Array.isArray(candidate.securityScopedBookmarks)) {
    result.securityScopedBookmarks = normalizeStringArray(candidate.securityScopedBookmarks);
  }
  if (Array.isArray(candidate.pinnedDirectories)) {
    result.pinnedDirectories = normalizeStringArray(
      candidate.pinnedDirectories
        .map((entry) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
        .filter((entry) => typeof entry === 'string' && entry.length > 0)
    );
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
  if (candidate.usageDisplayMode === 'usage' || candidate.usageDisplayMode === 'remaining') {
    result.usageDisplayMode = candidate.usageDisplayMode;
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
  if (candidate.tunnelBootstrapTtlMs === null) {
    result.tunnelBootstrapTtlMs = null;
  } else if (typeof candidate.tunnelBootstrapTtlMs === 'number' && Number.isFinite(candidate.tunnelBootstrapTtlMs)) {
    result.tunnelBootstrapTtlMs = normalizeTunnelBootstrapTtlMs(candidate.tunnelBootstrapTtlMs);
  }
  if (typeof candidate.tunnelSessionTtlMs === 'number' && Number.isFinite(candidate.tunnelSessionTtlMs)) {
    result.tunnelSessionTtlMs = normalizeTunnelSessionTtlMs(candidate.tunnelSessionTtlMs);
  }
  if (typeof candidate.tunnelProvider === 'string') {
    const provider = normalizeTunnelProvider(candidate.tunnelProvider);
    if (provider) {
      result.tunnelProvider = provider;
    }
  }
  if (typeof candidate.tunnelMode === 'string') {
    result.tunnelMode = normalizeTunnelMode(candidate.tunnelMode);
  }
  if (candidate.managedLocalTunnelConfigPath === null) {
    result.managedLocalTunnelConfigPath = null;
  } else if (typeof candidate.managedLocalTunnelConfigPath === 'string') {
    const trimmed = candidate.managedLocalTunnelConfigPath.trim();
    result.managedLocalTunnelConfigPath = trimmed.length > 0 ? normalizeOptionalPath(trimmed) : null;
  }
  if (typeof candidate.managedRemoteTunnelHostname === 'string') {
    const hostname = normalizeManagedRemoteTunnelHostname(candidate.managedRemoteTunnelHostname);
    result.managedRemoteTunnelHostname = hostname;
  }
  if (candidate.managedRemoteTunnelToken === null) {
    result.managedRemoteTunnelToken = null;
  } else if (typeof candidate.managedRemoteTunnelToken === 'string') {
    result.managedRemoteTunnelToken = candidate.managedRemoteTunnelToken.trim();
  }
  const managedRemoteTunnelPresets = normalizeManagedRemoteTunnelPresets(candidate.managedRemoteTunnelPresets);
  if (managedRemoteTunnelPresets) {
    result.managedRemoteTunnelPresets = managedRemoteTunnelPresets;
  }
  const managedRemoteTunnelPresetTokens = normalizeManagedRemoteTunnelPresetTokens(candidate.managedRemoteTunnelPresetTokens);
  if (managedRemoteTunnelPresetTokens) {
    result.managedRemoteTunnelPresetTokens = managedRemoteTunnelPresetTokens;
  }
  if (typeof candidate.managedRemoteTunnelSelectedPresetId === 'string') {
    const id = candidate.managedRemoteTunnelSelectedPresetId.trim();
    result.managedRemoteTunnelSelectedPresetId = id || undefined;
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
  if (typeof candidate.gitProviderId === 'string') {
    const trimmed = candidate.gitProviderId.trim();
    result.gitProviderId = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.gitModelId === 'string') {
    const trimmed = candidate.gitModelId.trim();
    result.gitModelId = trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof candidate.pwaAppName === 'string') {
    result.pwaAppName = normalizePwaAppName(candidate.pwaAppName, undefined);
  }
  if (typeof candidate.toolCallExpansion === 'string') {
    const mode = candidate.toolCallExpansion.trim();
    if (mode === 'collapsed' || mode === 'activity' || mode === 'detailed' || mode === 'changes') {
      result.toolCallExpansion = mode;
    }
  }
  if (typeof candidate.inputSpellcheckEnabled === 'boolean') {
    result.inputSpellcheckEnabled = candidate.inputSpellcheckEnabled;
  }
  if (typeof candidate.showToolFileIcons === 'boolean') {
    result.showToolFileIcons = candidate.showToolFileIcons;
  }
  if (typeof candidate.showExpandedBashTools === 'boolean') {
    result.showExpandedBashTools = candidate.showExpandedBashTools;
  }
  if (typeof candidate.showExpandedEditTools === 'boolean') {
    result.showExpandedEditTools = candidate.showExpandedEditTools;
  }
  if (typeof candidate.chatRenderMode === 'string') {
    const mode = candidate.chatRenderMode.trim();
    if (mode === 'sorted' || mode === 'live') {
      result.chatRenderMode = mode;
    }
  }
  if (typeof candidate.activityRenderMode === 'string') {
    const mode = candidate.activityRenderMode.trim();
    if (mode === 'collapsed' || mode === 'summary') {
      result.activityRenderMode = mode;
    }
  }
  if (typeof candidate.mermaidRenderingMode === 'string') {
    const mode = candidate.mermaidRenderingMode.trim();
    if (mode === 'svg' || mode === 'ascii') {
      result.mermaidRenderingMode = mode;
    }
  }
  if (typeof candidate.userMessageRenderingMode === 'string') {
    const mode = candidate.userMessageRenderingMode.trim();
    if (mode === 'markdown' || mode === 'plain') {
      result.userMessageRenderingMode = mode;
    }
  }
  if (typeof candidate.stickyUserHeader === 'boolean') {
    result.stickyUserHeader = candidate.stickyUserHeader;
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

  // Usage reporting opt-out (default: true/enabled)
  if (typeof candidate.reportUsage === 'boolean') {
    result.reportUsage = candidate.reportUsage;
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
  delete sanitized.managedRemoteTunnelToken;
  const approved = normalizeStringArray(settings.approvedDirectories);
  const bookmarks = normalizeStringArray(settings.securityScopedBookmarks);
  const hasManagedRemoteTunnelToken = typeof settings?.managedRemoteTunnelToken === 'string' && settings.managedRemoteTunnelToken.trim().length > 0;
  const pwaAppName = normalizePwaAppName(settings?.pwaAppName, '');

  return {
    ...sanitized,
    hasManagedRemoteTunnelToken,
    ...(pwaAppName ? { pwaAppName } : {}),
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

const projectDirectoryRuntime = createProjectDirectoryRuntime({
  fsPromises,
  path,
  normalizeDirectoryPath,
  getReadSettingsFromDiskMigrated: () => readSettingsFromDiskMigrated,
  sanitizeProjects,
});

const resolveDirectoryCandidate = (...args) => projectDirectoryRuntime.resolveDirectoryCandidate(...args);
const validateDirectoryPath = (...args) => projectDirectoryRuntime.validateDirectoryPath(...args);
const resolveProjectDirectory = (...args) => projectDirectoryRuntime.resolveProjectDirectory(...args);
const resolveOptionalProjectDirectory = (...args) => projectDirectoryRuntime.resolveOptionalProjectDirectory(...args);

const settingsRuntime = createSettingsRuntime({
  fsPromises,
  path,
  crypto,
  SETTINGS_FILE_PATH,
  sanitizeProjects,
  sanitizeSettingsUpdate,
  mergePersistedSettings,
  normalizeSettingsPaths,
  normalizeStringArray,
  formatSettingsResponse,
  resolveDirectoryCandidate,
  normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens,
  syncManagedRemoteTunnelConfigWithPresets,
  upsertManagedRemoteTunnelToken,
});

const readSettingsFromDiskMigrated = (...args) => settingsRuntime.readSettingsFromDiskMigrated(...args);
const readSettingsFromDisk = (...args) => settingsRuntime.readSettingsFromDisk(...args);
const writeSettingsToDisk = (...args) => settingsRuntime.writeSettingsToDisk(...args);
const persistSettings = (...args) => settingsRuntime.persistSettings(...args);

const requestSecurityRuntime = createRequestSecurityRuntime({
  readSettingsFromDiskMigrated,
});

const getUiSessionTokenFromRequest = (...args) => requestSecurityRuntime.getUiSessionTokenFromRequest(...args);

const pushRuntime = createPushRuntime({
  fsPromises,
  path,
  webPush,
  PUSH_SUBSCRIPTIONS_FILE_PATH,
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
});

const getOrCreateVapidKeys = (...args) => pushRuntime.getOrCreateVapidKeys(...args);
const addOrUpdatePushSubscription = (...args) => pushRuntime.addOrUpdatePushSubscription(...args);
const removePushSubscription = (...args) => pushRuntime.removePushSubscription(...args);
const sendPushToAllUiSessions = (...args) => pushRuntime.sendPushToAllUiSessions(...args);
const updateUiVisibility = (...args) => pushRuntime.updateUiVisibility(...args);
const isAnyUiVisible = (...args) => pushRuntime.isAnyUiVisible(...args);
const isUiVisible = (...args) => pushRuntime.isUiVisible(...args);
const ensurePushInitialized = (...args) => pushRuntime.ensurePushInitialized(...args);
const setPushInitialized = (...args) => pushRuntime.setPushInitialized(...args);

const TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW = 128;
const TERMINAL_INPUT_WS_REBIND_WINDOW_MS = 60 * 1000;
const TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const rejectWebSocketUpgrade = (...args) => requestSecurityRuntime.rejectWebSocketUpgrade(...args);


const isRequestOriginAllowed = (...args) => requestSecurityRuntime.isRequestOriginAllowed(...args);

const sessionRuntime = createSessionRuntime({
  writeSseEvent,
  getNotificationClients: () => uiNotificationClients,
});

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
let activeTunnelController = null;
const tunnelProviderRegistry = createTunnelProviderRegistry([
  createCloudflareTunnelProvider(),
]);
tunnelProviderRegistry.seal();
const tunnelAuthController = createTunnelAuth();
let runtimeManagedRemoteTunnelToken = '';
let runtimeManagedRemoteTunnelHostname = '';
let terminalRuntime = null;
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
  hmrState.openCodeBaseUrl = openCodeBaseUrl;
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
  openCodeBaseUrl = hmrState.openCodeBaseUrl ?? null;
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
let openCodeBaseUrl = hmrState.openCodeBaseUrl ?? null;
let isShuttingDown = hmrState.isShuttingDown;
let signalsAttached = hmrState.signalsAttached;
let openCodeWorkingDirectory = hmrState.openCodeWorkingDirectory;

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

const ENV_CONFIGURED_OPENCODE_HOST = (() => {
  const raw = process.env.OPENCODE_HOST?.trim();
  if (!raw) return null;

  const warnInvalidHost = (reason) => {
    console.warn(`[config] Ignoring OPENCODE_HOST=${JSON.stringify(raw)}: ${reason}`);
  };

  let url;
  try {
    url = new URL(raw);
  } catch {
    warnInvalidHost('not a valid URL');
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    warnInvalidHost(`must use http or https scheme (got ${JSON.stringify(url.protocol)})`);
    return null;
  }
  const port = parseInt(url.port, 10);
  if (!Number.isFinite(port) || port <= 0) {
    warnInvalidHost('must include an explicit port (example: http://hostname:4096)');
    return null;
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    warnInvalidHost('must not include path, query, or hash');
    return null;
  }
  return { origin: url.origin, port };
})();

// OPENCODE_HOST takes precedence over OPENCODE_PORT when both are set
const ENV_EFFECTIVE_PORT = ENV_CONFIGURED_OPENCODE_HOST?.port ?? ENV_CONFIGURED_OPENCODE_PORT;

const ENV_CONFIGURED_OPENCODE_HOSTNAME = (() => {
  const raw = process.env.OPENCHAMBER_OPENCODE_HOSTNAME;
  if (typeof raw !== 'string') {
    return '127.0.0.1';
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    console.warn(
      `[config] Ignoring OPENCHAMBER_OPENCODE_HOSTNAME=${JSON.stringify(raw)}: empty after trimming`,
    );
    return '127.0.0.1';
  }
  return trimmed;
})();

const ENV_SKIP_OPENCODE_START = process.env.OPENCODE_SKIP_START === 'true' ||
                                    process.env.OPENCHAMBER_SKIP_OPENCODE_START === 'true';
const ENV_DESKTOP_NOTIFY = process.env.OPENCHAMBER_DESKTOP_NOTIFY === 'true';
const ENV_CONFIGURED_OPENCODE_WSL_DISTRO =
  typeof process.env.OPENCODE_WSL_DISTRO === 'string' && process.env.OPENCODE_WSL_DISTRO.trim().length > 0
    ? process.env.OPENCODE_WSL_DISTRO.trim()
    : (
      typeof process.env.OPENCHAMBER_OPENCODE_WSL_DISTRO === 'string' &&
      process.env.OPENCHAMBER_OPENCODE_WSL_DISTRO.trim().length > 0
        ? process.env.OPENCHAMBER_OPENCODE_WSL_DISTRO.trim()
        : null
    );

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

const openCodeNetworkState = {};
Object.defineProperties(openCodeNetworkState, {
  openCodePort: { get: () => openCodePort, set: (value) => { openCodePort = value; } },
  openCodeBaseUrl: { get: () => openCodeBaseUrl, set: (value) => { openCodeBaseUrl = value; } },
  openCodeApiPrefix: { get: () => openCodeApiPrefix, set: (value) => { openCodeApiPrefix = value; } },
  openCodeApiPrefixDetected: { get: () => openCodeApiPrefixDetected, set: (value) => { openCodeApiPrefixDetected = value; } },
  openCodeApiDetectionTimer: { get: () => openCodeApiDetectionTimer, set: (value) => { openCodeApiDetectionTimer = value; } },
});

const openCodeNetworkRuntime = createOpenCodeNetworkRuntime({
  state: openCodeNetworkState,
  getOpenCodeAuthHeaders,
});

const waitForReady = (...args) => openCodeNetworkRuntime.waitForReady(...args);
const normalizeApiPrefix = (...args) => openCodeNetworkRuntime.normalizeApiPrefix(...args);
const setDetectedOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.setDetectedOpenCodeApiPrefix(...args);
const buildOpenCodeUrl = (...args) => openCodeNetworkRuntime.buildOpenCodeUrl(...args);
const ensureOpenCodeApiPrefix = (...args) => openCodeNetworkRuntime.ensureOpenCodeApiPrefix(...args);
const scheduleOpenCodeApiDetection = (...args) => openCodeNetworkRuntime.scheduleOpenCodeApiDetection(...args);

const ENV_CONFIGURED_API_PREFIX = normalizeApiPrefix(
  process.env.OPENCODE_API_PREFIX || process.env.OPENCHAMBER_API_PREFIX || ''
);

  if (ENV_CONFIGURED_API_PREFIX && ENV_CONFIGURED_API_PREFIX !== '') {
  console.warn('Ignoring configured OpenCode API prefix; API runs at root.');
}

let cachedLoginShellEnvSnapshot;
let resolvedOpencodeBinary = null;
let resolvedOpencodeBinarySource = null;
let resolvedNodeBinary = null;
let resolvedBunBinary = null;
let resolvedGitBinary = null;
let useWslForOpencode = false;
let resolvedWslBinary = null;
let resolvedWslOpencodePath = null;
let resolvedWslDistro = null;

const openCodeEnvState = {};
Object.defineProperties(openCodeEnvState, {
  cachedLoginShellEnvSnapshot: { get: () => cachedLoginShellEnvSnapshot, set: (value) => { cachedLoginShellEnvSnapshot = value; } },
  resolvedOpencodeBinary: { get: () => resolvedOpencodeBinary, set: (value) => { resolvedOpencodeBinary = value; } },
  resolvedOpencodeBinarySource: { get: () => resolvedOpencodeBinarySource, set: (value) => { resolvedOpencodeBinarySource = value; } },
  resolvedNodeBinary: { get: () => resolvedNodeBinary, set: (value) => { resolvedNodeBinary = value; } },
  resolvedBunBinary: { get: () => resolvedBunBinary, set: (value) => { resolvedBunBinary = value; } },
  resolvedGitBinary: { get: () => resolvedGitBinary, set: (value) => { resolvedGitBinary = value; } },
  useWslForOpencode: { get: () => useWslForOpencode, set: (value) => { useWslForOpencode = value; } },
  resolvedWslBinary: { get: () => resolvedWslBinary, set: (value) => { resolvedWslBinary = value; } },
  resolvedWslOpencodePath: { get: () => resolvedWslOpencodePath, set: (value) => { resolvedWslOpencodePath = value; } },
  resolvedWslDistro: { get: () => resolvedWslDistro, set: (value) => { resolvedWslDistro = value; } },
});

const openCodeEnvRuntime = createOpenCodeEnvRuntime({
  state: openCodeEnvState,
  normalizeDirectoryPath,
  readSettingsFromDiskMigrated,
  ENV_CONFIGURED_OPENCODE_WSL_DISTRO,
});

const applyLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.applyLoginShellEnvSnapshot(...args);
const getLoginShellEnvSnapshot = (...args) => openCodeEnvRuntime.getLoginShellEnvSnapshot(...args);
const ensureOpencodeCliEnv = (...args) => openCodeEnvRuntime.ensureOpencodeCliEnv(...args);
const applyOpencodeBinaryFromSettings = (...args) => openCodeEnvRuntime.applyOpencodeBinaryFromSettings(...args);
const resolveOpencodeCliPath = (...args) => openCodeEnvRuntime.resolveOpencodeCliPath(...args);
const isExecutable = (...args) => openCodeEnvRuntime.isExecutable(...args);
const searchPathFor = (...args) => openCodeEnvRuntime.searchPathFor(...args);
const resolveGitBinaryForSpawn = (...args) => openCodeEnvRuntime.resolveGitBinaryForSpawn(...args);
const resolveWslExecutablePath = (...args) => openCodeEnvRuntime.resolveWslExecutablePath(...args);
const buildWslExecArgs = (...args) => openCodeEnvRuntime.buildWslExecArgs(...args);
const opencodeShimInterpreter = (...args) => openCodeEnvRuntime.opencodeShimInterpreter(...args);
const clearResolvedOpenCodeBinary = (...args) => openCodeEnvRuntime.clearResolvedOpenCodeBinary(...args);

applyLoginShellEnvSnapshot();

notificationTemplateRuntime = createNotificationTemplateRuntime({
  readSettingsFromDisk,
  persistSettings,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  resolveGitBinaryForSpawn,
});

const notificationTriggerRuntime = createNotificationTriggerRuntime({
  readSettingsFromDisk,
  prepareNotificationLastMessage,
  summarizeText,
  resolveZenModel,
  buildTemplateVariables,
  extractLastMessageText,
  fetchLastAssistantMessageText,
  resolveNotificationTemplate,
  shouldApplyResolvedTemplateMessage,
  emitDesktopNotification,
  broadcastUiNotification,
  sendPushToAllUiSessions,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
});

const maybeSendPushForTrigger = (...args) => notificationTriggerRuntime.maybeSendPushForTrigger(...args);

const openCodeWatcherRuntime = createOpenCodeWatcherRuntime({
  waitForOpenCodePort,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  parseSseDataPayload,
  onPayload: (payload) => {
    maybeCacheSessionInfoFromEvent(payload);
    void maybeSendPushForTrigger(payload);
    sessionRuntime.processOpenCodeSsePayload(payload);
  },
});


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

const openCodeLifecycleState = {};
Object.defineProperties(openCodeLifecycleState, {
  openCodeProcess: { get: () => openCodeProcess, set: (value) => { openCodeProcess = value; } },
  openCodePort: { get: () => openCodePort, set: (value) => { openCodePort = value; } },
  openCodeBaseUrl: { get: () => openCodeBaseUrl, set: (value) => { openCodeBaseUrl = value; } },
  openCodeWorkingDirectory: { get: () => openCodeWorkingDirectory, set: (value) => { openCodeWorkingDirectory = value; } },
  currentRestartPromise: { get: () => currentRestartPromise, set: (value) => { currentRestartPromise = value; } },
  isRestartingOpenCode: { get: () => isRestartingOpenCode, set: (value) => { isRestartingOpenCode = value; } },
  openCodeApiPrefix: { get: () => openCodeApiPrefix, set: (value) => { openCodeApiPrefix = value; } },
  openCodeApiPrefixDetected: { get: () => openCodeApiPrefixDetected, set: (value) => { openCodeApiPrefixDetected = value; } },
  openCodeApiDetectionTimer: { get: () => openCodeApiDetectionTimer, set: (value) => { openCodeApiDetectionTimer = value; } },
  lastOpenCodeError: { get: () => lastOpenCodeError, set: (value) => { lastOpenCodeError = value; } },
  isOpenCodeReady: { get: () => isOpenCodeReady, set: (value) => { isOpenCodeReady = value; } },
  openCodeNotReadySince: { get: () => openCodeNotReadySince, set: (value) => { openCodeNotReadySince = value; } },
  isExternalOpenCode: { get: () => isExternalOpenCode, set: (value) => { isExternalOpenCode = value; } },
  isShuttingDown: { get: () => isShuttingDown, set: (value) => { isShuttingDown = value; } },
  healthCheckInterval: { get: () => healthCheckInterval, set: (value) => { healthCheckInterval = value; } },
  expressApp: { get: () => expressApp, set: (value) => { expressApp = value; } },
  useWslForOpencode: { get: () => useWslForOpencode, set: (value) => { useWslForOpencode = value; } },
  resolvedWslBinary: { get: () => resolvedWslBinary, set: (value) => { resolvedWslBinary = value; } },
  resolvedWslOpencodePath: { get: () => resolvedWslOpencodePath, set: (value) => { resolvedWslOpencodePath = value; } },
  resolvedWslDistro: { get: () => resolvedWslDistro, set: (value) => { resolvedWslDistro = value; } },
});

const openCodeLifecycleRuntime = createOpenCodeLifecycleRuntime({
  state: openCodeLifecycleState,
  env: {
    ENV_CONFIGURED_OPENCODE_PORT,
    ENV_CONFIGURED_OPENCODE_HOST,
    ENV_EFFECTIVE_PORT,
    ENV_CONFIGURED_OPENCODE_HOSTNAME,
    ENV_SKIP_OPENCODE_START,
  },
  syncToHmrState,
  syncFromHmrState,
  getOpenCodeAuthHeaders,
  buildOpenCodeUrl,
  waitForReady,
  normalizeApiPrefix,
  applyOpencodeBinaryFromSettings,
  ensureOpencodeCliEnv,
  ensureLocalOpenCodeServerPassword,
  buildWslExecArgs,
  resolveWslExecutablePath,
  opencodeShimInterpreter,
  setOpenCodePort,
  setDetectedOpenCodeApiPrefix,
  setupProxy,
  ensureOpenCodeApiPrefix,
  clearResolvedOpenCodeBinary,
});

const restartOpenCode = (...args) => openCodeLifecycleRuntime.restartOpenCode(...args);
const waitForOpenCodeReady = (...args) => openCodeLifecycleRuntime.waitForOpenCodeReady(...args);
const waitForAgentPresence = (...args) => openCodeLifecycleRuntime.waitForAgentPresence(...args);
const refreshOpenCodeAfterConfigChange = (...args) => openCodeLifecycleRuntime.refreshOpenCodeAfterConfigChange(...args);
const startHealthMonitoring = () => openCodeLifecycleRuntime.startHealthMonitoring(HEALTH_CHECK_INTERVAL);
const bootstrapOpenCodeAtStartup = async (...args) => {
  await openCodeLifecycleRuntime.bootstrapOpenCodeAtStartup(...args);
  scheduleOpenCodeApiDetection();
  startHealthMonitoring();
  void openCodeWatcherRuntime.start().catch((error) => {
    console.warn(`Global event watcher startup failed: ${error?.message || error}`);
  });
};
const killProcessOnPort = (...args) => openCodeLifecycleRuntime.killProcessOnPort(...args);

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

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const envPassword =
    process.env.OPENCHAMBER_UI_PASSWORD ||
    process.env.OPENCODE_UI_PASSWORD ||
    null;
  const envCfTunnel = process.env.OPENCHAMBER_TRY_CF_TUNNEL === 'true';
  const envTunnelProvider = process.env.OPENCHAMBER_TUNNEL_PROVIDER || undefined;
  const envTunnelMode = process.env.OPENCHAMBER_TUNNEL_MODE || undefined;
  const envTunnelConfigRaw = process.env.OPENCHAMBER_TUNNEL_CONFIG;
  const envTunnelConfig = typeof envTunnelConfigRaw === 'string'
    ? (envTunnelConfigRaw.trim().length > 0 ? envTunnelConfigRaw.trim() : null)
    : undefined;
  const envTunnelToken = process.env.OPENCHAMBER_TUNNEL_TOKEN || undefined;
  const envTunnelHostname = process.env.OPENCHAMBER_TUNNEL_HOSTNAME || undefined;

  const options = {
    port: DEFAULT_PORT,
    host: undefined,
    uiPassword: envPassword,
    tryCfTunnel: envCfTunnel,
    tunnelProvider: envTunnelProvider,
    tunnelMode: envTunnelMode,
    tunnelConfigPath: envTunnelConfig,
    tunnelToken: envTunnelToken,
    tunnelHostname: envTunnelHostname,
  };

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

    if (optionName === 'host') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.host = typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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

    if (optionName === 'tunnel-provider') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelProvider = typeof value === 'string' ? value : options.tunnelProvider;
      continue;
    }

    if (optionName === 'tunnel-mode') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelMode = typeof value === 'string' ? value : options.tunnelMode;
      continue;
    }

    if (optionName === 'tunnel-config') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelConfigPath = typeof value === 'string' ? value : null;
      continue;
    }

    if (optionName === 'tunnel-token') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelToken = typeof value === 'string' ? value : options.tunnelToken;
      continue;
    }

    if (optionName === 'tunnel-hostname') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelHostname = typeof value === 'string' ? value : options.tunnelHostname;
      continue;
    }

    if (optionName === 'tunnel') {
      const { value, nextIndex } = consumeValue(i, inlineValue);
      i = nextIndex;
      options.tunnelProvider = TUNNEL_PROVIDER_CLOUDFLARE;
      options.tunnelMode = TUNNEL_MODE_MANAGED_LOCAL;
      options.tunnelConfigPath = typeof value === 'string' ? value : null;
      continue;
    }
  }

  return options;
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


function setupProxy(app) {
  registerOpenCodeProxy(app, {
    fs,
    os,
    path,
    OPEN_CODE_READY_GRACE_MS,
    LONG_REQUEST_TIMEOUT_MS,
    getRuntime: () => ({
      openCodePort,
      openCodeNotReadySince,
      isOpenCodeReady,
      isRestartingOpenCode,
    }),
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    getUiNotificationClients: () => uiNotificationClients,
  });
}

async function gracefulShutdown(options = {}) {
  if (isShuttingDown) return;

  isShuttingDown = true;
  syncToHmrState();
  console.log('Starting graceful shutdown...');
  const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : exitOnShutdown;

  openCodeWatcherRuntime.stop();
  sessionRuntime.dispose();

  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }

  if (terminalRuntime) {
    try {
      await terminalRuntime.shutdown();
    } catch {
    } finally {
      terminalRuntime = null;
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

  if (activeTunnelController) {
    console.log('Stopping active tunnel...');
    activeTunnelController.stop();
    activeTunnelController = null;
    tunnelAuthController.clearActiveTunnel();
  }

  console.log('Graceful shutdown complete');
  if (exitProcess) {
    process.exit(0);
  }
}

async function main(options = {}) {
  const port = Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined;
  const tryCfTunnel = options.tryCfTunnel === true;
  const shouldUseCanonicalTunnelConfig = typeof options.tunnelMode === 'string'
    || typeof options.tunnelProvider === 'string'
    || options.tunnelConfigPath === null
    || typeof options.tunnelConfigPath === 'string'
    || typeof options.tunnelToken === 'string'
    || typeof options.tunnelHostname === 'string';
  const startupTunnelRequest = shouldUseCanonicalTunnelConfig
    ? normalizeTunnelStartRequest({
        provider: normalizeTunnelProvider(options.tunnelProvider),
        mode: options.tunnelMode,
        configPath: normalizeOptionalPath(options.tunnelConfigPath),
        token: typeof options.tunnelToken === 'string' ? options.tunnelToken.trim() : '',
        hostname: normalizeManagedRemoteTunnelHostname(options.tunnelHostname),
      })
    : (tryCfTunnel
      ? {
          provider: TUNNEL_PROVIDER_CLOUDFLARE,
          mode: TUNNEL_MODE_QUICK,
          configPath: undefined,
          token: '',
          hostname: undefined,
        }
      : null);
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

  // Startup model validation is best-effort and runs in background.
  void validateZenModelAtStartup();

  const app = express();
  const serverStartedAt = new Date().toISOString();
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
      opencodeViaWsl: useWslForOpencode,
      opencodeWslBinary: resolvedWslBinary || null,
      opencodeWslPath: resolvedWslOpencodePath || null,
      opencodeWslDistro: resolvedWslDistro || null,
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

  app.get('/api/system/info', (req, res) => {
    res.json({
      openchamberVersion: OPENCHAMBER_VERSION,
      runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
      pid: process.pid,
      startedAt: serverStartedAt,
    });
  });

  app.use((req, res, next) => {
    if (
      req.path.startsWith('/api/config/agents') ||
      req.path.startsWith('/api/config/commands') ||
      req.path.startsWith('/api/config/mcp') ||
      req.path.startsWith('/api/config/settings') ||
      req.path.startsWith('/api/config/skills') ||
      req.path.startsWith('/api/projects') ||
      req.path.startsWith('/api/fs') ||
      req.path.startsWith('/api/git') ||
      req.path.startsWith('/api/prompts') ||
      req.path.startsWith('/api/terminal') ||
      req.path.startsWith('/api/opencode') ||
      req.path.startsWith('/api/push') ||
      req.path.startsWith('/api/voice') ||
      req.path.startsWith('/api/tts') ||
      req.path.startsWith('/api/openchamber/tunnel')
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

  app.get('/auth/session', async (req, res) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      const tunnelSession = tunnelAuthController.getTunnelSessionFromRequest(req);
      if (tunnelSession) {
        return res.json({ authenticated: true, scope: 'tunnel' });
      }
      tunnelAuthController.clearTunnelSessionCookie(req, res);
      return res.status(401).json({ authenticated: false, locked: true, tunnelLocked: true });
    }

    try {
      await uiAuthController.handleSessionStatus(req, res);
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  app.post('/auth/session', (req, res) => {
    const requestScope = tunnelAuthController.classifyRequestScope(req);
    if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
      return res.status(403).json({ error: 'Password login is disabled for tunnel scope', tunnelLocked: true });
    }
    return uiAuthController.handleSessionCreate(req, res);
  });

  app.get('/connect', async (req, res) => {
    try {
      const token = typeof req.query?.t === 'string' ? req.query.t : '';
      const settings = await readSettingsFromDiskMigrated();
      const tunnelSessionTtlMs = normalizeTunnelSessionTtlMs(settings?.tunnelSessionTtlMs);

      const exchange = tunnelAuthController.exchangeBootstrapToken({
        req,
        res,
        token,
        sessionTtlMs: tunnelSessionTtlMs,
      });

      res.setHeader('Cache-Control', 'no-store');

      if (!exchange.ok) {
        if (exchange.reason === 'rate-limited') {
          res.setHeader('Retry-After', String(exchange.retryAfter || 60));
          return res.status(429).type('text/plain').send('Too many attempts. Please try again later.');
        }
        return res.status(401).type('text/plain').send('Connection link is invalid or expired.');
      }

      return res.redirect(302, '/');
    } catch (error) {
      return res.status(500).type('text/plain').send('Failed to process connect request.');
    }
  });

  app.use('/api', async (req, res, next) => {
    try {
      const requestScope = tunnelAuthController.classifyRequestScope(req);
      if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
        return tunnelAuthController.requireTunnelSession(req, res, next);
      }
      await uiAuthController.requireAuth(req, res, next);
    } catch (err) {
      next(err);
    }
  });

  // Voice token endpoint - returns OpenAI TTS availability status
  registerTtsRoutes(app, { resolveZenModel, sayTTSCapability });

  registerNotificationRoutes(app, {
    uiAuthController,
    ensurePushInitialized,
    getOrCreateVapidKeys,
    getUiSessionTokenFromRequest,
    readSettingsFromDiskMigrated,
    writeSettingsToDisk,
    addOrUpdatePushSubscription,
    removePushSubscription,
    updateUiVisibility,
    isUiVisible,
    getSessionActivitySnapshot: sessionRuntime.getSessionActivitySnapshot,
    getSessionStateSnapshot: sessionRuntime.getSessionStateSnapshot,
    getSessionAttentionSnapshot: sessionRuntime.getSessionAttentionSnapshot,
    getSessionState: sessionRuntime.getSessionState,
    getSessionAttentionState: sessionRuntime.getSessionAttentionState,
    markSessionViewed: sessionRuntime.markSessionViewed,
    markSessionUnviewed: sessionRuntime.markSessionUnviewed,
    markUserMessageSent: sessionRuntime.markUserMessageSent,
    setPushInitialized,
  });

  app.get('/api/openchamber/update-check', async (req, res) => {
    try {
      const { checkForUpdates } = await import('./lib/package-manager.js');
      const parseString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
      const parseReportUsage = (value) => {
        if (typeof value !== 'string') return true;
        const normalized = value.trim().toLowerCase();
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
        return true;
      };
      const inferDeviceClass = (ua) => {
        const value = (ua || '').toLowerCase();
        if (!value) return 'unknown';
        if (value.includes('ipad') || value.includes('tablet')) return 'tablet';
        if (value.includes('mobi') || value.includes('android') || value.includes('iphone')) return 'mobile';
        return 'desktop';
      };
      const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';

      const updateInfo = await checkForUpdates({
        appType: parseString(req.query.appType),
        deviceClass: parseString(req.query.deviceClass) || inferDeviceClass(userAgent),
        platform: parseString(req.query.platform),
        arch: parseString(req.query.arch),
        instanceMode: parseString(req.query.instanceMode),
        currentVersion: parseString(req.query.currentVersion),
        reportUsage: parseReportUsage(parseString(req.query.reportUsage)),
      });
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
      const isContainer =
        fs.existsSync('/.dockerenv') ||
        Boolean(process.env.CONTAINER) ||
        process.env.container === 'docker';

      if (isContainer) {
        res.json({
          success: true,
          message: 'Update starting, server will stay online',
          version: updateInfo.version,
          packageManager: pm,
          autoRestart: false,
        });

        setTimeout(() => {
          console.log(`\nInstalling update using ${pm} (container mode)...`);
          console.log(`Running: ${updateCmd}`);

          const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
          const shellFlag = process.platform === 'win32' ? '/c' : '-c';
          const child = spawnChild(shell, [shellFlag, updateCmd], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          child.unref();
        }, 500);

        return;
      }

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

      const quotePosix = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
      const quoteCmd = (value) => {
        const stringValue = String(value);
        return `"${stringValue.replace(/"/g, '""')}"`;
      };

      // Build restart command using explicit runtime + CLI path.
      // Avoids relying on `openchamber` being in PATH for service environments.
      const cliPath = path.resolve(__dirname, '..', 'bin', 'cli.js');
      const restartParts = [
        isWindows ? quoteCmd(process.execPath) : quotePosix(process.execPath),
        isWindows ? quoteCmd(cliPath) : quotePosix(cliPath),
        'serve',
        '--port',
        String(storedOptions.port),
        '--daemon',
      ];
      let restartCmdPrimary = restartParts.join(' ');
      let restartCmdFallback = `openchamber serve --port ${storedOptions.port} --daemon`;
      if (storedOptions.uiPassword) {
        if (isWindows) {
          // Escape for cmd.exe quoted argument
          const escapedPw = storedOptions.uiPassword.replace(/"/g, '""');
          restartCmdPrimary += ` --ui-password "${escapedPw}"`;
          restartCmdFallback += ` --ui-password "${escapedPw}"`;
        } else {
          // Escape for POSIX single-quoted argument
          const escapedPw = storedOptions.uiPassword.replace(/'/g, "'\\''");
          restartCmdPrimary += ` --ui-password '${escapedPw}'`;
          restartCmdFallback += ` --ui-password '${escapedPw}'`;
        }
      }
      const restartCmd = `(${restartCmdPrimary}) || (${restartCmdFallback})`;

      // Respond immediately - update will happen after response
      res.json({
        success: true,
        message: 'Update starting, server will restart shortly',
        version: updateInfo.version,
        packageManager: pm,
        autoRestart: true,
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

        // Spawn detached shell to run update after we exit.
        // Capture output to disk so restart failures are diagnosable.
        const updateLogPath = path.join(OPENCHAMBER_DATA_DIR, 'update-install.log');
        let logFd = null;
        try {
          fs.mkdirSync(path.dirname(updateLogPath), { recursive: true });
          logFd = fs.openSync(updateLogPath, 'a');
        } catch (logError) {
          console.warn('Failed to open update log file, continuing without log capture:', logError);
        }

        const child = spawnChild(shell, [shellFlag, script], {
          detached: true,
          stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
          env: process.env,
        });
        child.unref();

        if (logFd !== null) {
          try {
            fs.closeSync(logFd);
          } catch {
            // ignore
          }
        }

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
      const cachedZenModels = getCachedZenModels();
      if (cachedZenModels) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedZenModels);
      } else {
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });

  const tunnelService = createTunnelService({
    registry: tunnelProviderRegistry,
    getController: () => activeTunnelController,
    setController: (controller) => {
      activeTunnelController = controller;
    },
    getActivePort: () => activePort,
    onQuickTunnelWarning: () => {
      printTunnelWarning();
    },
  });

  const tunnelRoutesRuntime = createTunnelRoutesRuntime({
    crypto,
    URL,
    tunnelService,
    tunnelProviderRegistry,
    tunnelAuthController,
    readSettingsFromDiskMigrated,
    readManagedRemoteTunnelConfigFromDisk,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TunnelServiceError,
    getActivePort: () => activePort,
    getRuntimeManagedRemoteTunnelHostname: () => runtimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelHostname: (value) => {
      runtimeManagedRemoteTunnelHostname = value;
    },
    getRuntimeManagedRemoteTunnelToken: () => runtimeManagedRemoteTunnelToken,
    setRuntimeManagedRemoteTunnelToken: (value) => {
      runtimeManagedRemoteTunnelToken = value;
    },
    getActiveTunnelController: () => activeTunnelController,
    setActiveTunnelController: (value) => {
      activeTunnelController = value;
    },
  });

  tunnelRoutesRuntime.registerRoutes(app);
  const startTunnelWithNormalizedRequest = (...args) => tunnelRoutesRuntime.startTunnelWithNormalizedRequest(...args);

  const getOpenCodeResolutionSnapshot = async (settings) => {
    const configured = typeof settings?.opencodeBinary === 'string' ? settings.opencodeBinary : null;

    const previousSource = resolvedOpencodeBinarySource;
    const detectedNow = resolveOpencodeCliPath();
    const rawDetectedSourceNow = resolvedOpencodeBinarySource;
    resolvedOpencodeBinarySource = previousSource;

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

    return {
      configured,
      resolved,
      resolvedDir: resolved ? path.dirname(resolved) : null,
      source,
      detectedNow,
      detectedSourceNow,
      shim,
      viaWsl: useWslForOpencode,
      wslBinary: resolvedWslBinary || null,
      wslPath: resolvedWslOpencodePath || null,
      wslDistro: resolvedWslDistro || null,
      node: resolvedNodeBinary || null,
      bun: resolvedBunBinary || null,
    };
  };

  app.get('/api/config/themes', async (_req, res) => {
    try {
      const customThemes = await readCustomThemesFromDisk();
      res.json({ themes: customThemes });
    } catch (error) {
      console.error('Failed to load custom themes:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to load custom themes' });
    }
  });

  registerOpenCodeRoutes(app, {
    crypto,
    clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
    getOpenCodeResolutionSnapshot,
    formatSettingsResponse,
    readSettingsFromDisk,
    readSettingsFromDiskMigrated,
    persistSettings,
    sanitizeProjects,
    validateDirectoryPath,
    resolveProjectDirectory,
    getProviderSources,
    removeProviderConfig,
    refreshOpenCodeAfterConfigChange,
  });

  registerProjectIconRoutes(app, {
    fsPromises,
    path,
    crypto,
    openchamberDataDir: OPENCHAMBER_DATA_DIR,
    sanitizeProjects,
    readSettingsFromDiskMigrated,
    persistSettings,
    createFsSearchRuntime: createFsSearchRuntimeFactory,
    spawn,
    resolveGitBinaryForSpawn,
  });

  const {
    getAgentSources,
    getAgentConfig,
    createAgent,
    updateAgent,
    deleteAgent,
    getCommandSources,
    createCommand,
    updateCommand,
    deleteCommand,
    getProviderSources,
    removeProviderConfig,
    listMcpConfigs,
    getMcpConfig,
    createMcpConfig,
    updateMcpConfig,
    deleteMcpConfig,
  } = await import('./lib/opencode/index.js');

  registerConfigEntityRoutes(app, {
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    refreshOpenCodeAfterConfigChange,
    clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
    getAgentSources,
    getAgentConfig,
    createAgent,
    updateAgent,
    deleteAgent,
    getCommandSources,
    createCommand,
    updateCommand,
    deleteCommand,
    listMcpConfigs,
    getMcpConfig,
    createMcpConfig,
    updateMcpConfig,
    deleteMcpConfig,
  });

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

  const {
    getCuratedSkillsSources,
    getCacheKey,
    getCachedScan,
    setCachedScan,
    parseSkillRepoSource,
    scanSkillsRepository,
    installSkillsFromRepository,
    scanClawdHubPage,
    installSkillsFromClawdHub,
    isClawdHubSource,
  } = await import('./lib/skills-catalog/index.js');
  const { getProfiles, getProfile } = await import('./lib/git/index.js');

  registerSkillRoutes(app, {
    fs,
    path,
    os,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    readSettingsFromDisk,
    sanitizeSkillCatalogs,
    isUnsafeSkillRelativePath,
    refreshOpenCodeAfterConfigChange,
    clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getOpenCodePort: () => openCodePort,
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
    getCuratedSkillsSources,
    getCacheKey,
    getCachedScan,
    setCachedScan,
    parseSkillRepoSource,
    scanSkillsRepository,
    installSkillsFromRepository,
    scanClawdHubPage,
    installSkillsFromClawdHub,
    isClawdHubSource,
    getProfiles,
    getProfile,
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

  let quotaProviders = null;
  const getQuotaProviders = async () => {
    if (!quotaProviders) {
      quotaProviders = await import('./lib/quota/index.js');
    }
    return quotaProviders;
  };

  registerQuotaRoutes(app, { getQuotaProviders });

  registerGitHubRoutes(app);

  registerGitRoutes(app);
  registerFsRoutes(app, {
    os,
    path,
    fsPromises,
    spawn,
    crypto,
    normalizeDirectoryPath,
    resolveProjectDirectory,
    buildAugmentedPath,
    resolveGitBinaryForSpawn,
    openchamberUserConfigRoot: OPENCHAMBER_USER_CONFIG_ROOT,
  });

  terminalRuntime = createTerminalRuntime({
    app,
    server,
    express,
    fs,
    path,
    uiAuthController,
    buildAugmentedPath,
    searchPathFor,
    isExecutable,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
    TERMINAL_INPUT_WS_REBIND_WINDOW_MS,
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW,
  });

  setupProxy(app);
  scheduleOpenCodeApiDetection();
  void bootstrapOpenCodeAtStartup();

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

      const recentPwaSessionsCache = new Map();

      const getRecentPwaSessionShortcuts = async (req) => {
        const now = Date.now();

        const resolvedDirectoryResult = await resolveProjectDirectory(req).catch(() => ({ directory: null }));
        const preferredDirectory = typeof resolvedDirectoryResult?.directory === 'string'
          ? resolvedDirectoryResult.directory
          : null;

        const cacheKey = preferredDirectory ? `dir:${preferredDirectory}` : 'global';
        const cached = recentPwaSessionsCache.get(cacheKey);
        if (cached && now - cached.at < 5000) {
          return cached.data;
        }

        const normalizeShortcutTitle = (value, fallback) => {
          const normalized = normalizePwaAppName(value, fallback);
          return normalized.length > 48 ? normalized.slice(0, 48) : normalized;
        };

        const toFiniteNumber = (value) => {
          if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
          }
          if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
              return parsed;
            }
          }
          return null;
        };

        const normalizeDirectory = (value) => {
          if (typeof value !== 'string') {
            return '';
          }
          const trimmed = value.trim();
          if (!trimmed) {
            return '';
          }
          const normalized = trimmed.replace(/\\/g, '/');
          if (normalized === '/') {
            return '/';
          }
          return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
        };

        const sessionUpdatedAt = (session) => {
          const time = session && typeof session.time === 'object' ? session.time : null;
          return toFiniteNumber(time?.updated) ?? toFiniteNumber(time?.created) ?? 0;
        };

        const filterSessionsByDirectory = (sessions, directory) => {
          const normalizedDirectory = normalizeDirectory(directory);
          if (!normalizedDirectory) {
            return sessions;
          }

          const prefix = normalizedDirectory === '/' ? '/' : `${normalizedDirectory}/`;
          return sessions.filter((session) => {
            const sessionDirectory = normalizeDirectory(session?.directory);
            if (!sessionDirectory) {
              return false;
            }
            return sessionDirectory === normalizedDirectory || (prefix !== '/' && sessionDirectory.startsWith(prefix));
          });
        };

        const listSessions = async (directory) => {
          const query = (() => {
            if (typeof directory !== 'string' || directory.length === 0) {
              return '';
            }
            const preparedDirectory = process.platform === 'win32'
              ? directory.replace(/\//g, '\\')
              : directory;
            return `?directory=${encodeURIComponent(preparedDirectory)}`;
          })();

          const response = await fetch(buildOpenCodeUrl(`/session${query}`, ''), {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              ...getOpenCodeAuthHeaders(),
            },
            signal: AbortSignal.timeout(2500),
          });

          if (!response.ok) {
            return [];
          }

          const payload = await response.json().catch(() => null);
          return Array.isArray(payload) ? payload : [];
        };

        try {
          let payload = [];

          if (preferredDirectory) {
            const scopedPayload = await listSessions(preferredDirectory);
            const filteredScopedPayload = filterSessionsByDirectory(scopedPayload, preferredDirectory);

            if (filteredScopedPayload.length > 0) {
              payload = filteredScopedPayload;
            } else {
              const globalPayload = await listSessions(null);
              const filteredGlobalPayload = filterSessionsByDirectory(globalPayload, preferredDirectory);
              payload = filteredGlobalPayload.length > 0 ? filteredGlobalPayload : globalPayload;
            }
          } else {
            payload = await listSessions(null);
          }

          const seen = new Set();
          const rows = [];

          for (const item of payload) {
            if (!item || typeof item !== 'object') {
              continue;
            }

            const id = typeof item.id === 'string' ? item.id.trim().slice(0, 160) : '';
            if (!id || seen.has(id)) {
              continue;
            }

            seen.add(id);
            const title = normalizeShortcutTitle(item.title, `Session ${rows.length + 1}`);
            const updatedAt = sessionUpdatedAt(item);

            rows.push({ id, title, updatedAt });
          }

          rows.sort((a, b) => b.updatedAt - a.updatedAt);

          const shortcuts = rows.slice(0, 3).map((session) => ({
            name: session.title,
            short_name: session.title.length > 32 ? session.title.slice(0, 32) : session.title,
            description: 'Open recent session',
            url: `/?session=${encodeURIComponent(session.id)}`,
            icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
          }));

          recentPwaSessionsCache.set(cacheKey, { at: now, data: shortcuts });
          return shortcuts;
        } catch {
          recentPwaSessionsCache.set(cacheKey, { at: now, data: [] });
          return [];
        }
      };

      app.get('/manifest.webmanifest', async (req, res) => {
        const hasQueryOverride =
          typeof req.query?.pwa_name === 'string'
          || typeof req.query?.app_name === 'string'
          || typeof req.query?.appName === 'string';

        let queryValueRaw = '';
        if (typeof req.query?.pwa_name === 'string') {
          queryValueRaw = req.query.pwa_name;
        } else if (typeof req.query?.app_name === 'string') {
          queryValueRaw = req.query.app_name;
        } else if (typeof req.query?.appName === 'string') {
          queryValueRaw = req.query.appName;
        }

        const queryOverrideName = normalizePwaAppName(queryValueRaw, '');

        let storedName = '';
        try {
          const settings = await readSettingsFromDiskMigrated();
          storedName = normalizePwaAppName(settings?.pwaAppName, '');
        } catch {
          storedName = '';
        }

        const appName = hasQueryOverride
          ? (queryOverrideName || DEFAULT_PWA_APP_NAME)
          : (storedName || DEFAULT_PWA_APP_NAME);

        const shortName = appName.length > 30 ? appName.slice(0, 30) : appName;
        const recentSessionShortcuts = await getRecentPwaSessionShortcuts(req);

        const manifest = {
          name: appName,
          short_name: shortName,
          description: 'Web interface companion for OpenCode AI coding agent',
          id: '/',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#151313',
          theme_color: '#edb449',
          orientation: 'any',
          icons: [
            { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/pwa-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
            { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            { src: '/apple-touch-icon-180x180.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
            { src: '/apple-touch-icon-152x152.png', sizes: '152x152', type: 'image/png', purpose: 'any' },
            { src: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
            { src: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
          ],
          shortcuts: [
            {
              name: 'Appearance Settings',
              short_name: 'Settings',
              description: 'Open appearance settings',
              url: '/?settings=appearance',
              icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
            },
            ...recentSessionShortcuts,
          ],
          categories: ['developer', 'tools', 'productivity'],
          lang: 'en',
        };

        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        res.type('application/manifest+json');
        res.send(JSON.stringify(manifest));
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

  const bindHost = host
    || (typeof process.env.OPENCHAMBER_HOST === 'string' && process.env.OPENCHAMBER_HOST.trim().length > 0
      ? process.env.OPENCHAMBER_HOST.trim()
      : '127.0.0.1');

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

      const displayHost = (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]')
        ? 'localhost'
        : (bindHost.includes(':') ? `[${bindHost}]` : bindHost);
      console.log(`OpenChamber server listening on ${bindHost}:${activePort}`);
      console.log(`Health check: http://${displayHost}:${activePort}/health`);
      console.log(`Web interface: http://${displayHost}:${activePort}`);

      if (startupTunnelRequest) {
        const startupModeLabel = startupTunnelRequest.mode === TUNNEL_MODE_QUICK
          ? 'Quick Tunnel'
          : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_LOCAL
            ? 'Managed Local Tunnel'
            : (startupTunnelRequest.mode === TUNNEL_MODE_MANAGED_REMOTE ? 'Managed Remote Tunnel' : 'Tunnel'));
        console.log(`\nInitializing ${startupModeLabel} for provider '${startupTunnelRequest.provider}'...`);
        try {
          const { publicUrl, mode } = await startTunnelWithNormalizedRequest({
            provider: startupTunnelRequest.provider,
            mode: startupTunnelRequest.mode,
            intent: startupTunnelRequest.intent,
            hostname: startupTunnelRequest.hostname,
            token: startupTunnelRequest.token,
            configPath: startupTunnelRequest.configPath,
            selectedPresetId: '',
            selectedPresetName: '',
          });
          if (publicUrl) {
            tunnelAuthController.setActiveTunnel({
              tunnelId: crypto.randomUUID(),
              publicUrl,
              mode,
            });
            const settings = await readSettingsFromDiskMigrated();
            const bootstrapTtlMs = settings?.tunnelBootstrapTtlMs === null
              ? null
              : normalizeTunnelBootstrapTtlMs(settings?.tunnelBootstrapTtlMs);
            const bootstrapToken = tunnelAuthController.issueBootstrapToken({ ttlMs: bootstrapTtlMs });
            const connectUrl = `${publicUrl.replace(/\/$/, '')}/connect?t=${encodeURIComponent(bootstrapToken.token)}`;
            if (onTunnelReady) {
              onTunnelReady(publicUrl, connectUrl);
            } else {
              console.log(`\n🌐 Tunnel URL: ${connectUrl}`);
              console.log('🔑 One-time connect link (expires after first use)\n');
            }
          } else if (onTunnelReady) {
            onTunnelReady(publicUrl, null);
          }
        } catch (error) {
          console.error(`Failed to start tunnel: ${error.message}`);
          console.log('Continuing without tunnel...');
        }
      }

      resolve();
    };

    server.listen(port, bindHost, onListening);
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
    getTunnelUrl: () => tunnelService.getPublicUrl(),
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
    host: cliOptions.host,
    tryCfTunnel: cliOptions.tryCfTunnel,
    tunnelProvider: cliOptions.tunnelProvider,
    tunnelMode: cliOptions.tunnelMode,
    tunnelConfigPath: cliOptions.tunnelConfigPath,
    tunnelToken: cliOptions.tunnelToken,
    tunnelHostname: cliOptions.tunnelHostname,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword
  }).catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

export { gracefulShutdown, setupProxy, restartOpenCode, main as startWebUiServer, parseArgs };
