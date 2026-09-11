/**
 * Host<->remote path mapping for external OpenCode servers.
 *
 * When OpenChamber talks to an OpenCode server running in another filesystem
 * namespace (for example a Docker container), a project directory exists under
 * a different absolute path on each side: `C:\Users\me\my-project` on the Windows
 * host is mounted as `/workspace` inside the container. `OPENCODE_PATH_MAP`
 * declares that correspondence so requests sent to OpenCode carry remote
 * paths while values shown to the user keep host paths.
 *
 * Format: semicolon-separated `HOST=REMOTE` pairs.
 *   OPENCODE_PATH_MAP="C:\Users\me\my-project=/workspace;D:\code=/srv/code"
 *
 * `;` separates pairs because Windows host paths contain `:`; `=` pairs the
 * sides because Windows paths never contain `=`. Host prefixes must be
 * absolute on the host platform, remote prefixes must be POSIX absolute.
 * Matching uses the longest host prefix and is case-insensitive on Windows
 * hosts, case-sensitive elsewhere. Mapping is disabled when the variable is
 * unset or parses to zero rules; both directions then behave as identity.
 */

const WINDOWS = 'win32';

const stripTrailingSeparators = (value) => value.replace(/[\\/]+$/, '');

/**
 * True when `candidate` equals `prefix` or lies strictly inside it.
 * Segment-boundary aware, so `C:\a` does not claim `C:\ab`.
 */
const isInsideOrEqual = (candidate, prefix) => {
  if (candidate === prefix) return true;
  if (candidate.length < prefix.length) return false;
  if (!candidate.startsWith(prefix)) return false;
  const next = candidate[prefix.length];
  return next === '/';
};

const isAbsoluteHostPath = (value, platform) => {
  if (platform === WINDOWS) {
    return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
  }
  return value.startsWith('/');
};

/**
 * Parses the raw `OPENCODE_PATH_MAP` value into validated mapping rules.
 * Invalid pairs are skipped with a warning; a single bad pair never disables
 * the remaining ones. Returns `{ rules, warnings }` with rules sorted for
 * longest-prefix matching.
 */
export const parsePathMappingRules = (raw, options = {}) => {
  const platform = options.platform ?? process.platform;
  const logger = options.logger ?? console;
  const warnings = [];

  const rawText = String(raw ?? '').trim();
  if (!rawText) {
    return { rules: [], warnings };
  }

  const hostEntries = new Map();
  for (const pair of rawText.split(';')) {
    const entry = pair.trim();
    if (!entry) continue;

    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      warnings.push(`Ignoring OPENCODE_PATH_MAP entry ${JSON.stringify(entry)}: expected HOST=REMOTE`);
      continue;
    }

    const hostPrefix = stripTrailingSeparators(entry.slice(0, separatorIndex).trim());
    const remotePrefix = stripTrailingSeparators(entry.slice(separatorIndex + 1).trim());
    const label = JSON.stringify(entry);

    if (!hostPrefix || !remotePrefix) {
      warnings.push(`Ignoring OPENCODE_PATH_MAP entry ${label}: empty side`);
      continue;
    }
    if (!isAbsoluteHostPath(hostPrefix, platform)) {
      warnings.push(`Ignoring OPENCODE_PATH_MAP entry ${label}: host path must be absolute on this platform`);
      continue;
    }
    if (!remotePrefix.startsWith('/')) {
      warnings.push(`Ignoring OPENCODE_PATH_MAP entry ${label}: remote path must start with /`);
      continue;
    }

    const compareKey = platform === WINDOWS ? hostPrefix.toLowerCase() : hostPrefix;
    if (hostEntries.has(compareKey)) {
      warnings.push(`OPENCODE_PATH_MAP entry ${label}: duplicate host prefix overrides an earlier entry`);
    }
    hostEntries.set(compareKey, { hostPrefix, remotePrefix, compareKey });
  }

  const rules = [...hostEntries.values()].sort((a, b) => b.hostPrefix.length - a.hostPrefix.length);
  for (const warning of warnings) {
    logger.warn(`[path-mapping] ${warning}`);
  }
  return { rules, warnings };
};

/**
 * True when `suffix` carries a parent-directory segment. Mapped suffixes are
 * mechanical prefix rewrites; a `..` inside one would let a hint escape the
 * intended remote/host root after translation, so those values fail closed
 * (returned untranslated) instead of being rewritten.
 */
const hasParentSegment = (suffix) => suffix.split(/[\\/]/).includes('..');

/**
 * Creates the bidirectional translator used across the OpenCode integration.
 * `toRemote` maps a host path to its remote counterpart; `toHost` maps a
 * remote path back. Values outside every declared prefix pass through
 * untouched so callers never need to branch on `enabled`.
 */
export const createPathMapping = ({ rules, platform = process.platform } = {}) => {
  // Longest-prefix first, regardless of how the caller ordered the rules.
  const usableRules = (Array.isArray(rules) ? rules : [])
    .slice()
    .sort((a, b) => b.hostPrefix.length - a.hostPrefix.length);

  const normalizeHostPath = (value) => {
    const normalized = value.replaceAll('\\', '/');
    return platform === WINDOWS ? normalized.toLowerCase() : normalized;
  };

  const findRuleForHost = (value) => {
    const candidate = String(value ?? '');
    if (!candidate) return null;
    const comparable = normalizeHostPath(candidate);
    for (const rule of usableRules) {
      if (isInsideOrEqual(comparable, normalizeHostPath(rule.hostPrefix))) {
        return rule;
      }
    }
    return null;
  };

  const findRuleForRemote = (value) => {
    const candidate = String(value ?? '');
    if (!candidate) return null;
    for (const rule of usableRules) {
      if (isInsideOrEqual(candidate, rule.remotePrefix)) {
        return rule;
      }
    }
    return null;
  };

  return {
    enabled: usableRules.length > 0,
    ruleCount: usableRules.length,

    toRemote(value) {
      const rule = findRuleForHost(value);
      if (!rule) return value;
      const normalized = String(value).replaceAll('\\', '/');
      const suffix = normalized.slice(normalizeHostPath(rule.hostPrefix).length);
      if (hasParentSegment(suffix)) return value;
      return `${rule.remotePrefix}${suffix}`;
    },

    toHost(value) {
      const rule = findRuleForRemote(value);
      if (!rule) return value;
      const text = String(value);
      const suffix = text.slice(rule.remotePrefix.length);
      if (hasParentSegment(suffix)) return value;
      const restored = platform === WINDOWS
        ? suffix.replaceAll('/', '\\')
        : suffix;
      return `${rule.hostPrefix}${restored}`;
    },
  };
};

// Explicitly injected mapping (tests) wins for the rest of the process; the
// env-derived mapping is built once per environment value.
let explicitPathMapping = null;
let instancePathMapping = null;
let envPathMapping = null;
let envPathMappingSource;

const resolveMappingSource = () => {
  const text = String(process.env.OPENCODE_PATH_MAP ?? '').trim();
  return text || null;
};

/**
 * Process-wide mapping used by every OpenCode-bound directory hint. Resolution
 * order: explicit test injection (`setActivePathMapping`) → active Docker
 * instance mapping (`setActiveInstancePathMapping`, one per managed instance)
 * → `OPENCODE_PATH_MAP` env mapping → identity. Docker instance mapping is
 * additive: with no active instance the env/identity behavior is exactly the
 * pre-existing contract.
 */
export const getPathMapping = () => {
  if (explicitPathMapping) {
    return explicitPathMapping;
  }
  if (instancePathMapping) {
    return instancePathMapping;
  }
  const source = resolveMappingSource();
  if (source !== envPathMappingSource || !envPathMapping) {
    envPathMapping = createPathMapping({ rules: parsePathMappingRules(source).rules });
    envPathMappingSource = source;
  }
  return envPathMapping;
};

export const setActivePathMapping = (mapping) => {
  explicitPathMapping = mapping ?? null;
};

/**
 * Installs the mapping of the active Docker-backed instance (built from the
 * instance's own rules via `createPathMapping`). `null` deactivates and
 * falls back to the env/identity behavior.
 */
export const setActiveInstancePathMapping = (mapping) => {
  instancePathMapping = mapping ?? null;
};

/**
 * Mapping for an active Docker-backed instance: identical to
 * `createPathMapping` for paths under the declared rules, but unmapped values
 * no longer pass through to the container. A managed container only
 * meaningfully contains its workspace, so POSIX-absolute values (already
 * remote) pass through and everything else — typically OpenChamber's default
 * host project directory — lands at the workspace root. Without this, an
 * unmapped host path reaches the Linux container as a relative filename and
 * OpenCode fails with `realPath(/workspace/C:\...)`.
 *
 * `toHost` keeps the base contract: values under the workspace prefix map
 * back to the host spelling; everything else passes through.
 */
export const createInstancePathMapping = ({ rules, fallbackRemote, platform }) => {
  const base = createPathMapping({ rules, platform });
  const workspaceRoot = fallbackRemote ?? '/workspace';
  return {
    ...base,
    toRemote(value) {
      const mapped = base.toRemote(value);
      if (mapped !== value) {
        return mapped;
      }
      if (String(value ?? '').startsWith('/')) {
        return value;
      }
      return workspaceRoot;
    },
  };
};
