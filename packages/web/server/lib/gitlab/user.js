import { isPlainObject, isString } from './validation.js';

export function parseGitLabUser(payload) {
  if (!isPlainObject(payload)) throw new Error('Invalid GitLab user response');
  const id = Number.isInteger(payload.id) && payload.id >= 0 ? payload.id : null;
  const username = isString(payload.username) ? payload.username.trim() : '';
  if (id === null || !username) throw new Error('Invalid GitLab user response');
  const user = { id, login: username };
  if (isString(payload.avatar_url)) user.avatarUrl = payload.avatar_url;
  if (isString(payload.name)) user.name = payload.name;
  if (isString(payload.email)) user.email = payload.email;
  return user;
}
