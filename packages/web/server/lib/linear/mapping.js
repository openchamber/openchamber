import fs from 'fs';
import path from 'path';
import { getLinearAuth, getLinearAuthFilePath } from './auth.js';
import { isPlainObject, readTrimmedString } from './parse.js';

export class LinearMappingError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LinearMappingError';
    this.code = code;
  }
}

function mappingFile() {
  return path.join(path.dirname(getLinearAuthFilePath()), 'linear-mapping.json');
}

const UNSCOPED_MAPPING_KEY = '__unscoped__';

function mappingOrgKey() {
  const auth = getLinearAuth();
  return readTrimmedString(auth?.workspaceId) || UNSCOPED_MAPPING_KEY;
}

function emptyMapping() {
  return {
    defaultProjectPath: null,
    teamProjectPaths: {},
  };
}

function readTeamProjectPaths(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const next = {};
  for (const key of Object.keys(value)) {
    const teamId = readTrimmedString(key);
    const projectPath = readTrimmedString(value[key]);
    if (teamId && projectPath) {
      next[teamId] = projectPath;
    }
  }
  return next;
}

function normalizeMappingSlice(raw) {
  if (!isPlainObject(raw)) {
    return emptyMapping();
  }
  return {
    defaultProjectPath: readTrimmedString(raw.defaultProjectPath) || null,
    teamProjectPaths: readTeamProjectPaths(raw.teamProjectPaths),
  };
}

function readMappingDocument(raw) {
  if (!isPlainObject(raw)) {
    return { workspaces: {} };
  }
  if (isPlainObject(raw.workspaces)) {
    const workspaces = {};
    for (const key of Object.keys(raw.workspaces)) {
      const orgKey = readTrimmedString(key);
      if (!orgKey) continue;
      workspaces[orgKey] = normalizeMappingSlice(raw.workspaces[key]);
    }
    return { workspaces };
  }
  return {
    workspaces: {
      [mappingOrgKey()]: normalizeMappingSlice(raw),
    },
  };
}

function writeJsonFile(filePath, payload) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

export function getLinearMappingFilePath() {
  return mappingFile();
}

export function readStoredLinearMapping() {
  const filePath = mappingFile();
  if (!fs.existsSync(filePath)) {
    return emptyMapping();
  }
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return emptyMapping();
    }
    parsed = JSON.parse(trimmed);
  } catch {
    throw new LinearMappingError('Linear mapping file is malformed', 'MALFORMED');
  }
  if (!isPlainObject(parsed)) {
    throw new LinearMappingError('Linear mapping file is malformed', 'MALFORMED');
  }
  const document = readMappingDocument(parsed);
  return document.workspaces[mappingOrgKey()] || emptyMapping();
}

export function setStoredLinearMapping(input) {
  if (!isPlainObject(input)) {
    throw new LinearMappingError('Mapping body must be an object', 'INVALID');
  }
  const filePath = mappingFile();
  let document = { workspaces: {} };
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const trimmed = raw.trim();
      if (trimmed) {
        const parsed = JSON.parse(trimmed);
        if (!isPlainObject(parsed)) {
          throw new LinearMappingError('Linear mapping file is malformed', 'MALFORMED');
        }
        document = readMappingDocument(parsed);
      }
    } catch (error) {
      if (error instanceof LinearMappingError) {
        throw error;
      }
      throw new LinearMappingError('Linear mapping file is malformed', 'MALFORMED');
    }
  }
  const next = {
    defaultProjectPath: readTrimmedString(input.defaultProjectPath) || null,
    teamProjectPaths: readTeamProjectPaths(input.teamProjectPaths),
  };
  document.workspaces[mappingOrgKey()] = next;
  writeJsonFile(filePath, document);
  return next;
}

export function mergeLinearMappingView(stored, teams) {
  const mapping = stored || emptyMapping();
  const nodes = Array.isArray(teams) ? teams : [];
  return {
    defaultProjectPath: mapping.defaultProjectPath,
    teams: nodes.map((team) => ({
      id: team.id,
      key: team.key,
      name: team.name,
      projectPath: mapping.teamProjectPaths[team.id] || null,
    })),
  };
}

export function resolveMappedProjectPath(view, team) {
  const teams = Array.isArray(view?.teams) ? view.teams : [];
  const teamId = team ? readTrimmedString(team.id) : '';
  if (teamId) {
    const row = teams.find((entry) => entry.id === teamId);
    if (row?.projectPath) {
      return row.projectPath;
    }
  }
  const teamKey = team ? readTrimmedString(team.key) : '';
  if (teamKey) {
    const row = teams.find((entry) => entry.key === teamKey);
    if (row?.projectPath) {
      return row.projectPath;
    }
  }
  return view?.defaultProjectPath || null;
}
