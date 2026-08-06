import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const LINEAR_DEFAULT_TRIGGER_LABEL = 'openchamber';

function resolveDefaultFilePath() {
  const root =
    typeof process.env.OPENCHAMBER_DATA_DIR === 'string' &&
    process.env.OPENCHAMBER_DATA_DIR.trim().length > 0
      ? path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim())
      : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(root, 'linear-integration.json');
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeViewer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asNonEmptyString(raw.id);
  if (!id) return null;
  return {
    id,
    name: asNonEmptyString(raw.name),
    email: asNonEmptyString(raw.email),
  };
}

function normalizeOrganization(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asNonEmptyString(raw.id);
  if (!id) return null;
  return {
    id,
    name: asNonEmptyString(raw.name),
    urlKey: asNonEmptyString(raw.urlKey),
  };
}

function normalizeTeamMapping(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const teamId = asNonEmptyString(raw.teamId);
  const projectId = asNonEmptyString(raw.projectId);
  if (!teamId || !projectId) return null;
  return {
    teamId,
    teamKey: asNonEmptyString(raw.teamKey),
    teamName: asNonEmptyString(raw.teamName),
    projectId,
  };
}

export function normalizeLinearSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const teamMappings = [];
  const seenTeams = new Set();
  for (const entry of Array.isArray(input.teamMappings) ? input.teamMappings : []) {
    const mapping = normalizeTeamMapping(entry);
    if (!mapping || seenTeams.has(mapping.teamId)) continue;
    seenTeams.add(mapping.teamId);
    teamMappings.push(mapping);
  }
  return {
    defaultProjectId: asNonEmptyString(input.defaultProjectId),
    teamMappings,
    triggerLabel: asNonEmptyString(input.triggerLabel) ?? LINEAR_DEFAULT_TRIGGER_LABEL,
    autoStartEnabled: input.autoStartEnabled === true,
    postStatusUpdates: input.postStatusUpdates !== false,
    linkBaseUrl: asNonEmptyString(input.linkBaseUrl),
  };
}

/**
 * Module-owned persistence for the Linear integration: the personal API key,
 * the connected workspace/viewer identity, and integration settings.
 *
 * Follows the GitHub auth-file precedent: one JSON file under the OpenChamber
 * config root, written atomically with mode 0600 because it carries a secret.
 * The API key must never leave this module through API responses — routes and
 * runtime expose `hasApiKey` only.
 */
export class LinearIntegrationStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : resolveDefaultFilePath();
  }

  _readRaw() {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, 'utf8').trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      console.error('[Linear] Failed to read integration file:', error?.message ?? error);
      return null;
    }
  }

  _writeRaw(payload) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpFile = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
    try {
      fs.chmodSync(tmpFile, 0o600);
    } catch {
      // best-effort
    }
    fs.renameSync(tmpFile, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // best-effort
    }
  }

  read() {
    const raw = this._readRaw();
    return {
      apiKey: asNonEmptyString(raw?.apiKey),
      viewer: normalizeViewer(raw?.viewer),
      organization: normalizeOrganization(raw?.organization),
      connectedAt: typeof raw?.connectedAt === 'number' ? raw.connectedAt : null,
      settings: normalizeLinearSettings(raw?.settings),
    };
  }

  getApiKey() {
    return this.read().apiKey;
  }

  isConnected() {
    return Boolean(this.read().apiKey);
  }

  setAuth({ apiKey, viewer, organization }) {
    const key = asNonEmptyString(apiKey);
    if (!key) throw new Error('apiKey is required');
    const current = this.read();
    this._writeRaw({
      apiKey: key,
      viewer: normalizeViewer(viewer),
      organization: normalizeOrganization(organization),
      connectedAt: Date.now(),
      settings: current.settings,
    });
  }

  clearAuth() {
    const current = this.read();
    this._writeRaw({
      apiKey: null,
      viewer: null,
      organization: null,
      connectedAt: null,
      settings: current.settings,
    });
  }

  getSettings() {
    return this.read().settings;
  }

  /**
   * Merge a partial settings update. Only known keys are applied; unknown
   * keys are dropped by normalization. Returns the persisted settings.
   */
  updateSettings(partial) {
    const current = this.read();
    const merged = normalizeLinearSettings({
      ...current.settings,
      ...(partial && typeof partial === 'object' ? partial : {}),
    });
    this._writeRaw({
      apiKey: current.apiKey,
      viewer: current.viewer,
      organization: current.organization,
      connectedAt: current.connectedAt,
      settings: merged,
    });
    return merged;
  }
}
