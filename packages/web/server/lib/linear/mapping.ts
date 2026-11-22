import fs from 'fs';
import path from 'path';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import { getLinearAuth, getLinearAuthFilePath } from './auth.js';
import { isPlainObject, readTrimmedString } from './parse.js';
import type { LinearTeam } from './teams.js';

type ObjectPrototype = InstanceType<ObjectConstructor>;
type InheritedProjectPath = ObjectPrototype[keyof ObjectPrototype] | ObjectConstructor | ObjectPrototype;
type TeamProjectPaths = Record<string, string | InheritedProjectPath | undefined>;
interface StoredMapping {
  defaultProjectPath: string | null;
  teamProjectPaths: TeamProjectPaths;
}
interface MappingDocument {
  workspaces: Record<string, StoredMapping>;
}
interface MappingView {
  defaultProjectPath: string | null | undefined;
  teams: (LinearTeam & { projectPath: string | InheritedProjectPath | null })[];
}

export class LinearMappingError extends Error {
  declare code: 'INVALID' | 'MALFORMED';

  constructor(message: string, code: 'INVALID' | 'MALFORMED') {
    super(message);
    this.name = 'LinearMappingError';
    this.code = code;
  }
}

function mappingFile() {
  return path.join(path.dirname(getLinearAuthFilePath()), 'linear-mapping.json');
}

const UNSCOPED_MAPPING_KEY = '__unscoped__';

// Mapping values are filesystem paths keyed by workspace/team, so a
// legitimate linear-mapping.json is a few KiB. 1 MiB is generous headroom
// while refusing an oversized or non-regular file (e.g. a FIFO, which
// would otherwise block the synchronous read and freeze the server)
// instead of buffering it whole.
const MAX_LINEAR_MAPPING_BYTES = 1 * 1024 * 1024;

function mappingOrgKey() {
  const auth = getLinearAuth();
  return readTrimmedString(auth?.workspaceId) || UNSCOPED_MAPPING_KEY;
}

function emptyMapping(): StoredMapping {
  return {
    defaultProjectPath: null,
    teamProjectPaths: {},
  };
}

function readTeamProjectPaths(value: Parameters<typeof readTrimmedString>[0]) {
  if (!isPlainObject(value)) {
    return {};
  }
  const next: TeamProjectPaths = {};
  for (const key of Object.keys(value)) {
    const teamId = readTrimmedString(key);
    const projectPath = readTrimmedString(value[key]);
    if (teamId && projectPath) {
      next[teamId] = projectPath;
    }
  }
  return next;
}

function normalizeMappingSlice(raw: Parameters<typeof readTrimmedString>[0]): StoredMapping {
  if (!isPlainObject(raw)) {
    return emptyMapping();
  }
  return {
    defaultProjectPath: readTrimmedString(raw.defaultProjectPath) || null,
    teamProjectPaths: readTeamProjectPaths(raw.teamProjectPaths),
  };
}

function readMappingDocument(raw: Parameters<typeof readTrimmedString>[0]): MappingDocument {
  if (!isPlainObject(raw)) {
    return { workspaces: {} };
  }
  if (isPlainObject(raw.workspaces)) {
    const workspaces: MappingDocument['workspaces'] = {};
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

function chmodMappingFile(filePath: string) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    return;
  }
}

function writeJsonFile(filePath: string, payload: MappingDocument) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  chmodMappingFile(tmpFile);
  renameSyncWithRetry((from, to) => fs.renameSync(from, to), tmpFile, filePath);
  chmodMappingFile(filePath);
}

export function getLinearMappingFilePath() {
  return mappingFile();
}

// Bounded read of the mapping file: missing and empty files answer null
// (the empty-mapping case), malformed JSON, an over-cap file, and a
// non-regular file all throw the existing MALFORMED error, and unexpected
// I/O errors from the bounded reader propagate. Never answer null for a
// refused read: a write built on an empty base would silently discard
// the stored mapping.
function readMappingFile(filePath: string): Partial<StoredMapping> | null {
  const result = readBoundedFileSync(filePath, MAX_LINEAR_MAPPING_BYTES);
  if (!result.ok) {
    if (result.reason === 'missing') {
      return null;
    }
    throw new LinearMappingError('Linear mapping file is malformed', 'MALFORMED');
  }
  const trimmed = result.buffer.toString('utf8').trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new LinearMappingError('Linear mapping file is malformed', 'MALFORMED');
  }
  if (!isPlainObject(parsed)) {
    throw new LinearMappingError('Linear mapping file is malformed', 'MALFORMED');
  }
  return parsed;
}

export function readStoredLinearMapping() {
  const parsed = readMappingFile(mappingFile());
  if (!parsed) {
    return emptyMapping();
  }
  const document = readMappingDocument(parsed);
  return document.workspaces[mappingOrgKey()] || emptyMapping();
}

export function setStoredLinearMapping(input: Parameters<typeof readTrimmedString>[0]) {
  if (!isPlainObject(input)) {
    throw new LinearMappingError('Mapping body must be an object', 'INVALID');
  }
  const filePath = mappingFile();
  let document: MappingDocument = { workspaces: {} };
  const parsed = readMappingFile(filePath);
  if (parsed) {
    document = readMappingDocument(parsed);
  }
  const next = {
    defaultProjectPath: readTrimmedString(input.defaultProjectPath) || null,
    teamProjectPaths: readTeamProjectPaths(input.teamProjectPaths),
  };
  document.workspaces[mappingOrgKey()] = next;
  writeJsonFile(filePath, document);
  return next;
}

function teamProjectPath(mapping: Partial<StoredMapping>, team: LinearTeam): MappingView['teams'][number]['projectPath'] {
  const paths = mapping.teamProjectPaths;
  const id = team.id;
  if (paths == null) {
    throw new TypeError(process.versions.bun
      ? `${paths} is not an object (evaluating 'mapping.teamProjectPaths[team.id]')`
      : `Cannot read properties of ${paths} (reading '${id}')`);
  }
  return paths[id] || null;
}

export function mergeLinearMappingView(stored: Partial<StoredMapping> | null | undefined, teams: readonly LinearTeam[]): MappingView {
  const mapping = stored || emptyMapping();
  const nodes: readonly LinearTeam[] = Array.isArray(teams) ? teams : [];
  return {
    defaultProjectPath: mapping.defaultProjectPath,
    teams: nodes.map((team) => ({
      id: team.id,
      key: team.key,
      name: team.name,
      projectPath: teamProjectPath(mapping, team),
    })),
  };
}

export function resolveMappedProjectPath(view: MappingView | null | undefined, team: Partial<LinearTeam> | null | undefined) {
  const teams: readonly MappingView['teams'][number][] = Array.isArray(view?.teams) ? view.teams : [];
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
