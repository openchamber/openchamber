import { isPlainObject, isString } from './validation.js';
import type { SourceControlJson } from '@openchamber/sdk';

export interface GitLabUser {
  id: number;
  login: string;
  avatarUrl?: string;
  name?: string;
  email?: string;
}

const isInteger = (value: unknown): value is number => Number.isInteger(value);

export function parseGitLabUser(payload: SourceControlJson): GitLabUser {
  if (!isPlainObject(payload)) throw new Error('Invalid GitLab user response');
  const id = isInteger(payload.id) && payload.id >= 0 ? payload.id : null;
  const username = isString(payload.username) ? payload.username.trim() : '';
  if (id === null || !username) throw new Error('Invalid GitLab user response');
  const user: GitLabUser = { id, login: username };
  if (isString(payload.avatar_url)) user.avatarUrl = payload.avatar_url;
  if (isString(payload.name)) user.name = payload.name;
  if (isString(payload.email)) user.email = payload.email;
  return user;
}
