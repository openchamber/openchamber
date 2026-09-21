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
const ROLES = new Set([ROLE_SPACE, ROLE_SETUP, ROLE_NETWORK, ROLE_VOLUME]);

// The tools volume and its two one-shot containers belong to an owner, not to a space.
// They carry no space id, so parseSpaceLabels returns null for them and `list` and `remove` pass them by.
const LABEL_TOOLS_KEY = 'openchamber.space.tools.key';
const LABEL_TOOLS_DESCRIPTION = 'openchamber.space.tools.description';
export const ROLE_TOOLS = 'tools';
export const ROLE_TOOLS_FILL = 'tools-fill';
export const ROLE_TOOLS_CHECK = 'tools-check';
const TOOLS_ROLES = new Set([ROLE_TOOLS, ROLE_TOOLS_FILL, ROLE_TOOLS_CHECK]);
const TOOLS_KEY_PATTERN = /^[0-9a-f]{16}$/;

const SPACE_ID_PATTERN = /^[0-9a-f]{12}$/;
// The owner travels inside `--filter label=key=value`, so it stays a plain token.
const OWNER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PROJECT_PATTERN = /^[0-9a-f]{16}$/;
const SUFFIX_PATTERN = /^[a-z0-9]{1,16}$/;
// C0 controls, DEL, NEL, and the Unicode line and paragraph separators.
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f\x85\u2028\u2029]/;
const MAX_NAME_LENGTH = 100;

export const createSpaceId = () => crypto.randomBytes(6).toString('hex');

export const isSpaceId = (value) => SPACE_ID_PATTERN.test(value);

export function requireSpaceId(value) {
  if (!isSpaceId(value)) {
    throw new SpaceError('invalid_space_id', 'A space id is 12 lowercase hex characters');
  }
  return value;
}

const isOwner = (value) => OWNER_PATTERN.test(value ?? '');

export function requireOwner(value) {
  if (!isOwner(value)) {
    throw new SpaceError('invalid_owner', 'The installation id may hold only letters, digits, dots, dashes and underscores, 64 at most');
  }
  return value;
}

export function normalizeSpaceName(value) {
  const name = String(value ?? '').trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(name)) {
    throw new SpaceError('invalid_space_name', `A space name is 1 to ${MAX_NAME_LENGTH} characters on one line`);
  }
  return name;
}

export function hashProjectDirectory(directory) {
  const text = String(directory ?? '');
  if (text.trim().length === 0) {
    throw new SpaceError('invalid_project_directory', 'A space needs the project directory it was created for');
  }
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function spaceResourcePrefix(spaceId) {
  return `openchamber-space-${requireSpaceId(spaceId)}-`;
}

export function spaceResourceName(spaceId, role, suffix = '') {
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

export function buildSpaceLabels({ id, role, owner, project, name, created }) {
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

export const labelArgs = (labels) => Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);

/** `--filter` arguments that select this owner's resources, optionally one space. */
export function labelFilterArgs({ owner, spaceId = null }) {
  const filters = ['--filter', `label=${LABEL_MARKER}=${MARKER_VALUE}`, '--filter', `label=${LABEL_OWNER}=${requireOwner(owner)}`];
  if (spaceId !== null) {
    filters.push('--filter', `label=${LABEL_ID}=${requireSpaceId(spaceId)}`);
  }
  return filters;
}

/**
 * Reads our labels from the label object of a `docker inspect` entry.
 * Returns null for anything that is not a well-formed resource of ours.
 */
export function parseSpaceLabels(labels) {
  if (!labels || labels[LABEL_MARKER] !== MARKER_VALUE) {
    return null;
  }
  const id = labels[LABEL_ID];
  const role = labels[LABEL_ROLE];
  const owner = labels[LABEL_OWNER];
  if (!isSpaceId(id) || !ROLES.has(role) || !isOwner(owner)) {
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

const isToolsKey = (value) => TOOLS_KEY_PATTERN.test(value ?? '');

export function requireToolsKey(value) {
  if (!isToolsKey(value)) {
    throw new SpaceError('invalid_tools_key', 'A tools key is 16 lowercase hex characters');
  }
  return value;
}

/** One volume per owner and per tools content. A one-shot container adds its role as a suffix. */
export function toolsResourceName(owner, key, role = ROLE_TOOLS) {
  if (!TOOLS_ROLES.has(role)) {
    throw new SpaceError('invalid_role', `Unknown tools resource role '${role}'`);
  }
  const volume = `openchamber-tools-${requireOwner(owner)}-${requireToolsKey(key)}`;
  return role === ROLE_TOOLS ? volume : `${volume}-${role.slice(ROLE_TOOLS.length + 1)}`;
}

/** The key inside a tools volume name of this owner, or null for any other name. */
export function toolsKeyFromVolumeName(name, owner) {
  const prefix = `openchamber-tools-${requireOwner(owner)}-`;
  const text = String(name ?? '');
  const key = text.slice(prefix.length);
  return text.startsWith(prefix) && isToolsKey(key) ? key : null;
}

export function buildToolsLabels({ role, owner, key, description, created }) {
  if (!TOOLS_ROLES.has(role)) {
    throw new SpaceError('invalid_role', `Unknown tools resource role '${role}'`);
  }
  if (Number.isNaN(Date.parse(created))) {
    throw new SpaceError('invalid_created', 'A creation time is an ISO date string');
  }
  // Same rule as a space name: one line, so it survives as a label value.
  const text = String(description ?? '').trim();
  if (text.length === 0 || text.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(text)) {
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

/** `--filter` arguments that select this owner's tools resources, optionally of one role and of one key. */
export function toolsLabelFilterArgs({ owner, role = null, key = null }) {
  const filters = labelFilterArgs({ owner });
  if (role !== null) {
    filters.push('--filter', `label=${LABEL_ROLE}=${role}`);
  }
  if (key !== null) {
    filters.push('--filter', `label=${LABEL_TOOLS_KEY}=${requireToolsKey(key)}`);
  }
  return filters;
}

/**
 * Reads the tools labels from the label object of a `docker inspect` entry.
 * Returns null for anything that is not a well-formed tools resource of ours.
 */
export function parseToolsLabels(labels) {
  if (!labels || labels[LABEL_MARKER] !== MARKER_VALUE) {
    return null;
  }
  const role = labels[LABEL_ROLE];
  const owner = labels[LABEL_OWNER];
  const key = labels[LABEL_TOOLS_KEY];
  if (!TOOLS_ROLES.has(role) || !isOwner(owner) || !isToolsKey(key)) {
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
