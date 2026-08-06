import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const CONFIG_FILE = path.join(OPENCHAMBER_DATA_DIR, 'jira-integration.json');

export const JIRA_LISTENER_MIN_INTERVAL_MS = 15_000;
export const JIRA_LISTENER_DEFAULT_INTERVAL_MS = 60_000;
export const JIRA_DEFAULT_TRIGGER_LABEL = 'openchamber';

const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function ensureStorageDir() {
  if (!fs.existsSync(OPENCHAMBER_DATA_DIR)) {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  }
}

function writeJsonFile(payload) {
  ensureStorageDir();
  const tmpFile = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, CONFIG_FILE);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // best-effort
  }
}

export function normalizeJiraProjectKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toUpperCase();
  return PROJECT_KEY_PATTERN.test(key) ? key : null;
}

function normalizeMappings(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const mappings = [];
  for (const entry of raw) {
    const projectKey = normalizeJiraProjectKey(entry?.projectKey);
    const directory = typeof entry?.directory === 'string' ? entry.directory.trim() : '';
    if (!projectKey || !directory || seen.has(projectKey)) continue;
    seen.add(projectKey);
    mappings.push({ projectKey, directory });
  }
  return mappings;
}

function normalizeAppBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function normalizeIntervalMs(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return JIRA_LISTENER_DEFAULT_INTERVAL_MS;
  return Math.max(JIRA_LISTENER_MIN_INTERVAL_MS, Math.floor(value));
}

function normalizeTriggerLabel(raw) {
  if (typeof raw !== 'string') return JIRA_DEFAULT_TRIGGER_LABEL;
  const label = raw.trim();
  // Jira labels cannot contain spaces; quotes would break the JQL clause the
  // listener builds from this value.
  if (!label || /[\s"'\\]/.test(label)) return JIRA_DEFAULT_TRIGGER_LABEL;
  return label;
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const updates = source.updates && typeof source.updates === 'object' ? source.updates : {};
  const listener = source.issueListener && typeof source.issueListener === 'object' ? source.issueListener : {};
  return {
    projectMappings: normalizeMappings(source.projectMappings),
    defaultDirectory: typeof source.defaultDirectory === 'string' && source.defaultDirectory.trim()
      ? source.defaultDirectory.trim()
      : null,
    appBaseUrl: normalizeAppBaseUrl(source.appBaseUrl),
    updates: {
      started: updates.started !== false,
      completed: updates.completed !== false,
      failed: updates.failed !== false,
      attention: updates.attention !== false,
    },
    issueListener: {
      enabled: listener.enabled === true,
      triggerLabel: normalizeTriggerLabel(listener.triggerLabel),
      removeTriggerLabel: listener.removeTriggerLabel !== false,
      intervalMs: normalizeIntervalMs(listener.intervalMs),
    },
  };
}

export function getJiraIntegrationConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return normalizeConfig(null);
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').trim();
    if (!raw) return normalizeConfig(null);
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    console.error('Failed to read Jira integration config:', error);
    return normalizeConfig(null);
  }
}

/**
 * Merge a partial update into the stored config. Only known keys are applied;
 * the merged result is re-normalized before persisting.
 */
export function updateJiraIntegrationConfig(patch) {
  const current = getJiraIntegrationConfig();
  const source = patch && typeof patch === 'object' ? patch : {};
  const merged = {
    ...current,
    ...(source.projectMappings !== undefined ? { projectMappings: source.projectMappings } : {}),
    ...(source.defaultDirectory !== undefined ? { defaultDirectory: source.defaultDirectory } : {}),
    ...(source.appBaseUrl !== undefined ? { appBaseUrl: source.appBaseUrl } : {}),
    updates: { ...current.updates, ...(source.updates && typeof source.updates === 'object' ? source.updates : {}) },
    issueListener: {
      ...current.issueListener,
      ...(source.issueListener && typeof source.issueListener === 'object' ? source.issueListener : {}),
    },
  };
  const normalized = normalizeConfig(merged);
  writeJsonFile(normalized);
  return normalized;
}

/**
 * Resolve the OpenChamber project directory for a Jira project key.
 * Returns null when no explicit mapping or default directory applies —
 * callers must fail explicitly rather than guessing a directory.
 */
export function resolveDirectoryForJiraProject(config, projectKey) {
  const normalizedKey = normalizeJiraProjectKey(projectKey);
  if (normalizedKey) {
    const mapping = config.projectMappings.find((entry) => entry.projectKey === normalizedKey);
    if (mapping) return mapping.directory;
  }
  return config.defaultDirectory;
}

export const JIRA_CONFIG_FILE = CONFIG_FILE;
