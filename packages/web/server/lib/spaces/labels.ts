import crypto from 'node:crypto';

import { SpaceError } from './errors.js';

export const LABEL_MARKER = 'openchamber.space';
const LABEL_ID = 'openchamber.space.id';
const LABEL_ROLE = 'openchamber.space.role';
export const LABEL_OWNER = 'openchamber.space.owner';
const LABEL_PROJECT = 'openchamber.space.project';
const LABEL_NAME = 'openchamber.space.name';
const LABEL_CREATED = 'openchamber.space.created';

const MARKER_VALUE = 'true';

export const ROLE_SPACE = 'space';
export const ROLE_SETUP = 'setup';
export const ROLE_NETWORK = 'network';
export const ROLE_VOLUME = 'volume';
export const ROLE_GATEKEEPER = 'gatekeeper';
export const ROLE_OUTER_NETWORK = 'outer-network';
const ROLES = new Set([ROLE_SPACE, ROLE_SETUP, ROLE_NETWORK, ROLE_VOLUME, ROLE_GATEKEEPER, ROLE_OUTER_NETWORK]);

const LABEL_TOOLS_KEY = 'openchamber.space.tools.key';
const LABEL_TOOLS_DESCRIPTION = 'openchamber.space.tools.description';
export const ROLE_TOOLS = 'tools';
export const ROLE_TOOLS_FILL = 'tools-fill';
export const ROLE_TOOLS_CHECK = 'tools-check';
const TOOLS_ROLES = new Set([ROLE_TOOLS, ROLE_TOOLS_FILL, ROLE_TOOLS_CHECK]);
const TOOLS_KEY_PATTERN = /^[0-9a-f]{16}$/;

const SPACE_ID_PATTERN = /^[0-9a-f]{12}$/;
const OWNER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PROJECT_PATTERN = /^[0-9a-f]{16}$/;
const SUFFIX_PATTERN = /^[a-z0-9]{1,16}$/;
const hasControlCharacters = (text: string) => Array.from(text, (character) => character.codePointAt(0)).some((code) => code !== undefined && (code <= 31 || code === 127 || code === 133 || code === 8232 || code === 8233));
const MAX_NAME_LENGTH = 100;

export const createSpaceId = () => crypto.randomBytes(6).toString('hex');

export const isSpaceId = (value: string) => SPACE_ID_PATTERN.test(value);

export function requireSpaceId(value: string) {
  if (!isSpaceId(value)) {
    throw new SpaceError('invalid_space_id', 'A space id is 12 lowercase hex characters');
  }
  return value;
}

const isOwner = (value: string | null | undefined) => OWNER_PATTERN.test(value ?? '');

export function requireOwner(value: string) {
  if (!isOwner(value)) {
    throw new SpaceError('invalid_owner', 'The installation id may hold only letters, digits, dots, dashes and underscores, 64 at most');
  }
  return value;
}

export function normalizeSpaceName(value: string | null | undefined) {
  const name = String(value ?? '').trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || hasControlCharacters(name)) {
    throw new SpaceError('invalid_space_name', `A space name is 1 to ${MAX_NAME_LENGTH} characters on one line`);
  }
  return name;
}

export function hashProjectDirectory(directory: string | null | undefined) {
  const text = String(directory ?? '');
  if (text.trim().length === 0) {
    throw new SpaceError('invalid_project_directory', 'A space needs the project directory it was created for');
  }
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function spaceResourcePrefix(spaceId: string) {
  return `openchamber-space-${requireSpaceId(spaceId)}-`;
}

export function spaceResourceName(spaceId: string, role: string, suffix = '') {
  if (!ROLES.has(role)) {
    throw new SpaceError('invalid_role', `Unknown space resource role '${role}'`);
  }
  if (suffix === '') {
    return `${spaceResourcePrefix(spaceId)}${role}`;
  }
  if (!SUFFIX_PATTERN.test(suffix)) {
    throw new SpaceError('invalid_resource_suffix', 'A resource suffix is 1 to 16 lowercase letters or digits');
  }
  return `${spaceResourcePrefix(spaceId)}${role}-${suffix}`;
}

export function buildSpaceLabels({ id, role, owner, project, name, created }: { id: string; role: string; owner: string; project: string; name: string; created: string }) {
  if (!ROLES.has(role)) {
    throw new SpaceError('invalid_role', `Unknown space resource role '${role}'`);
  }
  if (!PROJECT_PATTERN.test(project)) {
    throw new SpaceError('invalid_project', 'A project label is the 16 character hash from hashProjectDirectory');
  }
  if (Number.isNaN(Date.parse(created))) {
    throw new SpaceError('invalid_created', 'A creation time is an ISO date string');
  }
  return {
    [LABEL_MARKER]: MARKER_VALUE,
    [LABEL_ID]: requireSpaceId(id),
    [LABEL_ROLE]: role,
    [LABEL_OWNER]: requireOwner(owner),
    [LABEL_PROJECT]: project,
    [LABEL_NAME]: normalizeSpaceName(name),
    [LABEL_CREATED]: created,
  };
}

export const labelArgs = (labels: Record<string, string>) => Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);

export function labelFilterArgs({ owner, spaceId = null }: { owner: string; spaceId?: string | null }) {
  const filters = ['--filter', `label=${LABEL_MARKER}=${MARKER_VALUE}`, '--filter', `label=${LABEL_OWNER}=${requireOwner(owner)}`];
  if (spaceId !== null) {
    filters.push('--filter', `label=${LABEL_ID}=${requireSpaceId(spaceId)}`);
  }
  return filters;
}

export interface InspectLabels {
  'openchamber.space'?: unknown;
  'openchamber.space.id'?: unknown;
  'openchamber.space.role'?: unknown;
  'openchamber.space.owner'?: unknown;
  'openchamber.space.project'?: unknown;
  'openchamber.space.name'?: unknown;
  'openchamber.space.created'?: unknown;
  'openchamber.space.tools.key'?: unknown;
  'openchamber.space.tools.description'?: unknown;
}

export function parseSpaceLabels(labels: InspectLabels | null | undefined) {
  if (!labels || labels[LABEL_MARKER] !== MARKER_VALUE) {
    return null;
  }
  const id = labels[LABEL_ID];
  const role = labels[LABEL_ROLE];
  const owner = labels[LABEL_OWNER];
  if (!SPACE_ID_PATTERN.test(`${id}`) || !isSpaceRole(role) || !OWNER_PATTERN.test(`${owner ?? ''}`)) {
    return null;
  }
  return {
    id,
    role,
    owner,
    project: labels[LABEL_PROJECT] ?? '',
    name: labels[LABEL_NAME] ?? '',
    created: labels[LABEL_CREATED] ?? '',
  };
}

const isSpaceRole = (value: unknown): value is string => typeof value === 'string' && ROLES.has(value);
const isToolsRole = (value: unknown): value is string => typeof value === 'string' && TOOLS_ROLES.has(value);
const isToolsKey = (value: string | null | undefined) => TOOLS_KEY_PATTERN.test(value ?? '');

export function requireToolsKey(value: string) {
  if (!isToolsKey(value)) {
    throw new SpaceError('invalid_tools_key', 'A tools key is 16 lowercase hex characters');
  }
  return value;
}

export function toolsResourceName(owner: string, key: string, role = ROLE_TOOLS) {
  if (!TOOLS_ROLES.has(role)) {
    throw new SpaceError('invalid_role', `Unknown tools resource role '${role}'`);
  }
  const volume = `openchamber-tools-${requireOwner(owner)}-${requireToolsKey(key)}`;
  return role === ROLE_TOOLS ? volume : `${volume}-${role.slice(ROLE_TOOLS.length + 1)}`;
}

export function toolsKeyFromVolumeName(name: string | null | undefined, owner: string) {
  const prefix = `openchamber-tools-${requireOwner(owner)}-`;
  const text = String(name ?? '');
  const key = text.slice(prefix.length);
  return text.startsWith(prefix) && isToolsKey(key) ? key : null;
}

export function buildToolsLabels({ role, owner, key, description, created }: { role: string; owner: string; key: string; description: string; created: string }) {
  if (!TOOLS_ROLES.has(role)) {
    throw new SpaceError('invalid_role', `Unknown tools resource role '${role}'`);
  }
  if (Number.isNaN(Date.parse(created))) {
    throw new SpaceError('invalid_created', 'A creation time is an ISO date string');
  }
  const text = String(description ?? '').trim();
  if (text.length === 0 || text.length > MAX_NAME_LENGTH || hasControlCharacters(text)) {
    throw new SpaceError('invalid_tools_description', `A tools description is 1 to ${MAX_NAME_LENGTH} characters on one line`);
  }
  return {
    [LABEL_MARKER]: MARKER_VALUE,
    [LABEL_ROLE]: role,
    [LABEL_OWNER]: requireOwner(owner),
    [LABEL_TOOLS_KEY]: requireToolsKey(key),
    [LABEL_TOOLS_DESCRIPTION]: text,
    [LABEL_CREATED]: created,
  };
}

export function toolsLabelFilterArgs({ owner, role = null, key = null }: { owner: string; role?: string | null; key?: string | null }) {
  const filters = labelFilterArgs({ owner });
  if (role !== null) {
    filters.push('--filter', `label=${LABEL_ROLE}=${role}`);
  }
  if (key !== null) {
    filters.push('--filter', `label=${LABEL_TOOLS_KEY}=${requireToolsKey(key)}`);
  }
  return filters;
}

export function parseToolsLabels(labels: InspectLabels | null | undefined) {
  if (!labels || labels[LABEL_MARKER] !== MARKER_VALUE) {
    return null;
  }
  const role = labels[LABEL_ROLE];
  const owner = labels[LABEL_OWNER];
  const key = labels[LABEL_TOOLS_KEY];
  if (!isToolsRole(role) || !OWNER_PATTERN.test(`${owner ?? ''}`) || !TOOLS_KEY_PATTERN.test(`${key ?? ''}`)) {
    return null;
  }
  return {
    role,
    owner,
    key,
    description: labels[LABEL_TOOLS_DESCRIPTION] ?? '',
    created: labels[LABEL_CREATED] ?? '',
  };
}
