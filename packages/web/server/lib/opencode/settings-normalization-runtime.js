export const createSettingsNormalizationRuntime = (dependencies) => {
  const {
    os,
    path,
    processLike,
    tunnelBootstrapTtlDefaultMs,
    tunnelBootstrapTtlMinMs,
    tunnelBootstrapTtlMaxMs,
    tunnelSessionTtlDefaultMs,
    tunnelSessionTtlMinMs,
    tunnelSessionTtlMaxMs,
  } = dependencies;

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

    if (processLike.platform !== 'win32') {
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

  const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));

  const normalizeTunnelBootstrapTtlMs = (value) => {
    if (value === null) {
      return null;
    }
    if (!Number.isFinite(value)) {
      return tunnelBootstrapTtlDefaultMs;
    }
    return clampNumber(Math.round(value), tunnelBootstrapTtlMinMs, tunnelBootstrapTtlMaxMs);
  };

  const normalizeTunnelSessionTtlMs = (value) => {
    if (!Number.isFinite(value)) {
      return tunnelSessionTtlDefaultMs;
    }
    return clampNumber(Math.round(value), tunnelSessionTtlMinMs, tunnelSessionTtlMaxMs);
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
