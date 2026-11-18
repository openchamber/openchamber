import type osModule from 'node:os';
import type pathModule from 'node:path';
import type { SettingsDocument } from './settings-helpers.js';
import type { ManagedRemoteTunnelPreset } from '../tunnels/managed-config.js';
import { isBoolean, isString } from '../shared/object-guards.js';

const hasFields = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const isNumber = (value: unknown): value is number => typeof value === 'number';

export interface SettingsNormalizationDependencies {
  os: Pick<typeof osModule, 'homedir'>;
  path: Pick<typeof pathModule, 'join' | 'resolve' | 'posix'>;
  processLike: { platform: string };
  realpathSync?: (value: string) => string;
  readdirSync?: (value: string) => string[];
  tunnelBootstrapTtlDefaultMs: number;
  tunnelBootstrapTtlMinMs: number;
  tunnelBootstrapTtlMaxMs: number;
  tunnelSessionTtlDefaultMs: number;
  tunnelSessionTtlMinMs: number;
  tunnelSessionTtlMaxMs: number;
}

export interface SettingsProject {
  id: string;
  path: string;
  label?: string;
  labelSource?: 'manual' | 'auto';
  icon?: string;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
  color?: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultVariant?: string;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
}

export interface SettingsModelRef {
  providerID: string;
  modelID: string;
}

export interface SettingsSkillCatalog {
  id: string;
  label: string;
  source: string;
  subpath?: string;
  gitIdentityId?: string;
}

type DirectoryListings = Map<string, string[] | null>;
type TypographyKey = 'markdown' | 'code' | 'uiHeader' | 'uiLabel' | 'meta' | 'micro';

export const createSettingsNormalizationRuntime = (dependencies: SettingsNormalizationDependencies) => {
  const {
    os,
    path,
    processLike,
    realpathSync,
    readdirSync,
    tunnelBootstrapTtlDefaultMs,
    tunnelBootstrapTtlMinMs,
    tunnelBootstrapTtlMaxMs,
    tunnelSessionTtlDefaultMs,
    tunnelSessionTtlMinMs,
    tunnelSessionTtlMaxMs,
  } = dependencies;

  function normalizeDirectoryPath<Value>(value: Value): Value extends string ? string : Value;
  function normalizeDirectoryPath(value: SettingsDocument[string]) {
    if (!isString(value)) {
      return value;
    }

    let trimmed = value.trim();
    if (trimmed.length >= 2
      && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
      trimmed = trimmed.slice(1, -1).trim();
    }
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
  }

  const CASE_INSENSITIVE_PLATFORMS = new Set(['win32', 'darwin']);

  const rootLengthOf = (value: string) => {
    const drive = /^[a-zA-Z]:[\\/]/.exec(value);
    if (drive) return 3;
    return value.startsWith('/') ? 1 : 0;
  };

  const canonicalizePathCase = (value: string, listings?: DirectoryListings) => {
    if (!readdirSync || !value) return value;
    if (!CASE_INSENSITIVE_PLATFORMS.has(processLike?.platform)) return value;

    let result = value;
    try {
      const rootLength = rootLengthOf(value);
      if (rootLength === 0) return value;
      const root = value.slice(0, rootLength);
      const separator = processLike.platform === 'win32' ? /[\\/]+/ : /\/+/;
      const segments = value.slice(rootLength).split(separator).filter(Boolean);
      let current = root;
      for (const segment of segments) {
        let entries = listings?.get(current);
        if (entries === undefined) {
          try {
            entries = readdirSync(current);
          } catch {
            entries = null;
          }
          listings?.set(current, entries);
        }
        if (!entries) return value;
        let next: string | undefined = segment;
        if (!entries.includes(segment)) {
          next = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
          if (!next) return value;
        }
        current = path.join(current, next);
      }
      result = current;
    } catch {
      return value;
    }
    return result;
  };

  const safeRealpathSync = (value: string, listings?: DirectoryListings) => {
    if (!value) {
      return value;
    }
    if (!realpathSync) {
      return canonicalizePathCase(value, listings);
    }
    let resolved;
    try {
      resolved = realpathSync(value);
    } catch {
      return value;
    }
    return canonicalizePathCase(resolved, listings);
  };

  function normalizePathForPersistence<Value>(value: Value, options?: { resolveRealpath?: boolean }): Value extends string ? string : Value;
  function normalizePathForPersistence(value: SettingsDocument[string], options: { resolveRealpath?: boolean } = {}) {
    if (!isString(value)) {
      return value;
    }

    const normalized = normalizeDirectoryPath(value);
    const trimmed = normalized.trim();
    if (!trimmed) {
      return trimmed;
    }

    const uppercaseDriveLetter = (p: string) =>
      p.replace(/^([a-z]):/, (_match: string, letter: string) => letter.toUpperCase() + ':');

    const isWindows = processLike.platform === 'win32';
    const caseNormalized = isWindows ? uppercaseDriveLetter(trimmed) : trimmed;
    const resolved = options.resolveRealpath === false ? caseNormalized : safeRealpathSync(caseNormalized);

    const finalResolved = isWindows
      ? uppercaseDriveLetter(resolved)
      : resolved;

    if (!isWindows) {
      return finalResolved;
    }

    return finalResolved.replace(/\//g, '\\');
  }

  const areStringArraysEqual = (a: SettingsDocument[string], b: SettingsDocument[string]) => {
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

  const normalizeStringArray = (input: SettingsDocument[string]) => {
    if (!Array.isArray(input)) {
      return [];
    }
    return Array.from(
      new Set(
        input.filter((entry): entry is string => isString(entry) && entry.length > 0)
      )
    );
  };

  const sanitizeProjects = (input: SettingsDocument[string]) => {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const hexColorPattern = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;
    const normalizeIconBackground = (value: SettingsDocument[string]) => {
      if (!isString(value)) {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      return hexColorPattern.test(trimmed) ? trimmed.toLowerCase() : null;
    };

    const result: SettingsProject[] = [];
    const seenIds = new Set();
    const seenPaths = new Set();
    const listings: DirectoryListings = new Map();

    for (const entry of input) {
      if (!hasFields(entry)) continue;

      const candidate = entry;
      const id = isString(candidate.id) ? candidate.id.trim() : '';
      const rawPath = isString(candidate.path) ? candidate.path.trim() : '';
      const resolvedPath = rawPath ? safeRealpathSync(path.resolve(normalizeDirectoryPath(rawPath)), listings) : '';
      const normalizedPath = resolvedPath ? normalizePathForPersistence(resolvedPath, { resolveRealpath: false }) : '';
      const label = isString(candidate.label) ? candidate.label.trim() : '';
      const labelSource = candidate.labelSource === 'manual' || candidate.labelSource === 'auto'
        ? candidate.labelSource
        : '';
      const icon = isString(candidate.icon) ? candidate.icon.trim() : '';
      const iconImage = hasFields(candidate.iconImage)
        ? candidate.iconImage
        : null;
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      const color = isString(candidate.color) ? candidate.color.trim() : '';
      const defaultAgent = isString(candidate.defaultAgent) ? candidate.defaultAgent.trim() : '';
      const defaultModel = isString(candidate.defaultModel) ? candidate.defaultModel.trim() : '';
      const defaultVariant = isString(candidate.defaultVariant) ? candidate.defaultVariant.trim() : '';
      const addedAt = Number.isFinite(candidate.addedAt) ? Number(candidate.addedAt) : null;
      const lastOpenedAt = Number.isFinite(candidate.lastOpenedAt)
        ? Number(candidate.lastOpenedAt)
        : null;

      if (!id || !normalizedPath) continue;
      if (seenIds.has(id)) continue;
      if (seenPaths.has(normalizedPath)) continue;

      seenIds.add(id);
      seenPaths.add(normalizedPath);

      const project: SettingsProject = {
        id,
        path: normalizedPath,
      };
      if (label) project.label = label;
      if (icon) project.icon = icon;
      if (iconBackground) project.iconBackground = iconBackground;
      if (color) project.color = color;
      if (defaultAgent) project.defaultAgent = defaultAgent;
      if (defaultModel && defaultModel.includes('/')) project.defaultModel = defaultModel;
      if (defaultModel && defaultModel.includes('/') && defaultVariant) project.defaultVariant = defaultVariant;
      if (isFiniteNumber(addedAt) && addedAt >= 0) project.addedAt = addedAt;
      if (isFiniteNumber(lastOpenedAt) && lastOpenedAt >= 0) project.lastOpenedAt = lastOpenedAt;

      if (label && labelSource) project.labelSource = labelSource;

      if (candidate.iconImage === null) {
        project.iconImage = null;
      } else if (iconImage) {
        const mime = isString(iconImage.mime) ? iconImage.mime.trim() : '';
        const updatedAt = isNumber(iconImage.updatedAt) && Number.isFinite(iconImage.updatedAt)
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

      if (isBoolean(candidate.sidebarCollapsed)) {
        project.sidebarCollapsed = candidate.sidebarCollapsed;
      }

      result.push(project);
    }

    return result;
  };

  const normalizeSettingsPaths = (input: SettingsDocument[string]) => {
    const settings = hasFields(input) ? input : {};
    let next = settings;
    let changed = false;

    const ensureNext = () => {
      if (next === settings) {
        next = { ...settings };
      }
    };

    const normalizePathField = (key: string) => {
      if (!isString(settings[key]) || settings[key].length === 0) {
        return;
      }
      const normalized = normalizePathForPersistence(settings[key]);
      if (normalized !== settings[key]) {
        ensureNext();
        next[key] = normalized;
        changed = true;
      }
    };

    const normalizePathArrayField = (key: string) => {
      if (!Array.isArray(settings[key])) {
        return;
      }

      const normalized = normalizeStringArray(
        settings[key]
          .map((entry) => (isString(entry) ? normalizePathForPersistence(entry) : entry))
          .filter((entry) => isString(entry) && entry.length > 0)
      );

      if (!areStringArraysEqual(normalized, settings[key])) {
        ensureNext();
        next[key] = normalized;
        changed = true;
      }
    };

    normalizePathField('lastDirectory');
    normalizePathField('homeDirectory');
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

  const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

  const normalizeTunnelBootstrapTtlMs = (value: SettingsDocument[string]) => {
    if (value === null) {
      return null;
    }
    if (!isFiniteNumber(value)) {
      return tunnelBootstrapTtlDefaultMs;
    }
    return clampNumber(Math.round(value), tunnelBootstrapTtlMinMs, tunnelBootstrapTtlMaxMs);
  };

  const normalizeTunnelSessionTtlMs = (value: SettingsDocument[string]) => {
    if (!isFiniteNumber(value)) {
      return tunnelSessionTtlDefaultMs;
    }
    return clampNumber(Math.round(value), tunnelSessionTtlMinMs, tunnelSessionTtlMaxMs);
  };

  const normalizeManagedRemoteTunnelHostname = (value: SettingsDocument[string]) => {
    if (!isString(value)) {
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

  const normalizeManagedRemoteTunnelPresets = (value: SettingsDocument[string]) => {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const result: ManagedRemoteTunnelPreset[] = [];
    const seenIds = new Set();
    const seenHostnames = new Set();

    for (const entry of value) {
      if (!hasFields(entry)) continue;
      const candidate = entry;
      const id = isString(candidate.id) ? candidate.id.trim() : '';
      const name = isString(candidate.name) ? candidate.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(candidate.hostname);
      if (!id || !name || !hostname) continue;
      if (seenIds.has(id) || seenHostnames.has(hostname)) continue;
      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname });
    }

    return result;
  };

  const normalizeManagedRemoteTunnelPresetTokens = (value: SettingsDocument[string]) => {
    if (!hasFields(value) || Array.isArray(value)) {
      return undefined;
    }

    const result: Record<string, string> = {};
    for (const [rawId, rawToken] of Object.entries(value)) {
      const id = rawId.trim();
      const token = isString(rawToken) ? rawToken.trim() : '';
      if (!id || !token) {
        continue;
      }
      result[id] = token;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  };

  const isUnsafeSkillRelativePath = (value: SettingsDocument[string]) => {
    if (!isString(value) || value.length === 0) {
      return true;
    }

    const normalized = value.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized)) {
      return true;
    }

    return normalized.split('/').some((segment) => segment === '..');
  };

  const sanitizeTypographySizesPartial = (input: SettingsDocument[string]) => {
    if (!hasFields(input)) {
      return undefined;
    }
    const candidate = input;
    const result: Partial<Record<TypographyKey, string>> = {};
    let populated = false;

    const assign = (key: TypographyKey) => {
      if (isString(candidate[key]) && candidate[key].length > 0) {
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

  const sanitizeModelRefs = (input: SettingsDocument[string], limit: number) => {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const result: SettingsModelRef[] = [];
    const seen = new Set();

    for (const entry of input) {
      if (!hasFields(entry)) continue;
      const providerID = isString(entry.providerID) ? entry.providerID.trim() : '';
      const modelID = isString(entry.modelID) ? entry.modelID.trim() : '';
      if (!providerID || !modelID) continue;
      const key = `${providerID}/${modelID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ providerID, modelID });
      if (result.length >= limit) break;
    }

    return result;
  };

  const sanitizeSkillCatalogs = (input: SettingsDocument[string]) => {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const result: SettingsSkillCatalog[] = [];
    const seen = new Set();

    for (const entry of input) {
      if (!hasFields(entry)) continue;

      const id = isString(entry.id) ? entry.id.trim() : '';
      const label = isString(entry.label) ? entry.label.trim() : '';
      const source = isString(entry.source) ? entry.source.trim() : '';
      const subpath = isString(entry.subpath) ? entry.subpath.trim() : '';
      const gitIdentityId = isString(entry.gitIdentityId) ? entry.gitIdentityId.trim() : '';

      if (!id || !label || !source) continue;
      if (seen.has(id)) continue;
      seen.add(id);

      const catalog: SettingsSkillCatalog = {
        id,
        label,
        source,
      };
      if (subpath) catalog.subpath = subpath;
      if (gitIdentityId) catalog.gitIdentityId = gitIdentityId;
      result.push(catalog);
    }

    return result;
  };

  return {
    normalizeDirectoryPath,
    normalizePathForPersistence,
    normalizeSettingsPaths,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeManagedRemoteTunnelPresetTokens,
    isUnsafeSkillRelativePath,
    sanitizeTypographySizesPartial,
    normalizeStringArray,
    sanitizeModelRefs,
    sanitizeSkillCatalogs,
    sanitizeProjects,
  };
};
