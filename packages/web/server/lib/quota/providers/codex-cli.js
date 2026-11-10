/**
 * The Codex CLI's own ChatGPT sign-in, read for the Codex usage provider of
 * both runtimes (web server and VS Code extension host).
 *
 * OpenCode's "Sign in with ChatGPT" token reaches only the Responses route,
 * so the usage endpoint refuses it. The Codex CLI signs in with OpenAI's own
 * app client and keeps a token the usage endpoint accepts, in
 * `$CODEX_HOME/auth.json` (`~/.codex` by default). That file is read fresh per
 * request and never written or refreshed: the CLI owns it, and a refresh from
 * here would race the CLI's own.
 *
 * @module quota/providers/codex-cli
 */

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

/**
 * The email OpenAI puts in an access token's profile claim, or null when the
 * token carries none. Decoded only, never verified: it names the account for
 * display and comparison, and nothing is granted on it.
 */
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
