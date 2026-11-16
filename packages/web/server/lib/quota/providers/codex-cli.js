
import os from 'os';
import path from 'path';

import { asObject, asNonEmptyString, readJsonFile } from '../utils/index.js';

const codexHome = () => {
  const override = asNonEmptyString(process.env.CODEX_HOME);
  return override ? path.resolve(override) : path.join(os.homedir(), '.codex');
};

/**
 * The CLI's ChatGPT sign-in, or null when the CLI is signed out or uses an API
 * key (`auth.json` then carries `OPENAI_API_KEY` and no `tokens`).
 *
 * @returns {{ accessToken: string, accountId: string|null }|null}
 */
export const readCodexCliLogin = () => {
  const tokens = asObject(readJsonFile(path.join(codexHome(), 'auth.json'))?.tokens);
  const accessToken = asNonEmptyString(tokens?.access_token);
  if (!accessToken) return null;
  return { accessToken, accountId: asNonEmptyString(tokens.account_id) };
};

export const signInEmailOf = (accessToken) => {
  const part = accessToken.split('.')[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return asNonEmptyString(asObject(claims?.['https://api.openai.com/profile'])?.email);
  } catch {
    return null;
  }
};
