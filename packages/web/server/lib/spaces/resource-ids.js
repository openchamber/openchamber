// Dependency-free identifiers shared with the privileged host daemon.
import { SpaceError } from './errors.js';

export const isSpaceId = (value) => /^[0-9a-f]{12}$/.test(value);
export const isToolsKey = (value) => /^[0-9a-f]{16}$/.test(value ?? '');

export function requireSpaceId(value) {
  if (!isSpaceId(value)) throw new SpaceError('invalid_space_id', 'A space id is 12 lowercase hex characters');
  return value;
}

export function requireToolsKey(value) {
  if (!isToolsKey(value)) throw new SpaceError('invalid_tools_key', 'A tools key is 16 lowercase hex characters');
  return value;
}
