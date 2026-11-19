
import os from 'os';
import path from 'path';

import { asObject, asNonEmptyString, readJsonFile } from '../utils/index.js';

const codexHome = () => {
  const override = asNonEmptyString(process.env.CODEX_HOME);
  return override ? path.resolve(override) : path.join(os.homedir(), '.codex');
};

interface CodexCliLogin {
  accessToken: string;
  accountId: string | null;
}

const hasLoginFields = (value: unknown): value is { tokens?: unknown } => value != null;
const hasTokenFields = (value: unknown): value is { access_token?: unknown; account_id?: unknown } => asObject(value) !== null;
const hasProfileClaim = (value: unknown): value is { 'https://api.openai.com/profile'?: unknown } => value != null;
const hasProfileFields = (value: unknown): value is { email?: unknown } => asObject(value) !== null;

export const readCodexCliLogin = (): CodexCliLogin | null => {
  const login: unknown = readJsonFile(path.join(codexHome(), 'auth.json'));
  const tokens = hasLoginFields(login) ? login.tokens : undefined;
  if (!hasTokenFields(tokens)) return null;
  const accessToken = asNonEmptyString(tokens.access_token);
  if (!accessToken) return null;
  return { accessToken, accountId: asNonEmptyString(tokens.account_id) };
};

export const signInEmailOf = (accessToken: string) => {
  const part = accessToken.split('.')[1];
  if (!part) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const profile = hasProfileClaim(claims) ? claims['https://api.openai.com/profile'] : undefined;
    return asNonEmptyString(hasProfileFields(profile) ? profile.email : undefined);
  } catch {
    return null;
  }
};
