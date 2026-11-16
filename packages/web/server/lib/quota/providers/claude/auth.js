
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

import { readOpenCodeCredentials } from '../../../opencode/auth.js';
import { asObject, asNonEmptyString, normalizeTimestamp, getAuthEntry, normalizeAuthEntry, readJsonFile } from '../../utils/index.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OPENCODE_AUTH_ALIASES = ['anthropic', 'claude'];

/**
 * @typedef {object} ClaudeCredential
 * @property {string} accessToken
 * @property {string|null} refreshToken
 * @property {number|null} expiresAt Epoch milliseconds, when the source reports it.
 * @property {string|null} planLabel Subscription tier reported by Claude Code, e.g. `max`.
 * @property {'keychain'|'credentials-file'|'opencode-auth'|'env'} source
 */

const claudeConfigDirectory = () => {
  const override = asNonEmptyString(process.env.CLAUDE_CONFIG_DIR);
  return override ? path.resolve(override) : path.join(os.homedir(), '.claude');
};

const parseClaudeCodeBlob = (blob, source) => {
  const oauth = asObject(asObject(blob)?.claudeAiOauth);
  const accessToken = asNonEmptyString(oauth?.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: asNonEmptyString(oauth.refreshToken),
    expiresAt: normalizeTimestamp(oauth.expiresAt),
    planLabel: asNonEmptyString(oauth.subscriptionType),
    source
  };
};

const readKeychainCredential = () => {
  if (process.platform !== 'darwin') return null;
  let raw;
  try {
    raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
  try {
    return parseClaudeCodeBlob(JSON.parse(raw.trim()), 'keychain');
  } catch {
    console.warn('Claude quota: Keychain credentials are not valid JSON');
    return null;
  }
};

const readCredentialsFile = () =>
  parseClaudeCodeBlob(readJsonFile(path.join(claudeConfigDirectory(), '.credentials.json')), 'credentials-file');

const readOpenCodeCredential = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, OPENCODE_AUTH_ALIASES));
  const accessToken = asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: asNonEmptyString(entry.refresh),
    expiresAt: normalizeTimestamp(entry.expires),
    planLabel: null,
    source: 'opencode-auth'
  };
};

const readEnvCredential = () => {
  const accessToken = asNonEmptyString(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!accessToken) return null;
  return { accessToken, refreshToken: null, expiresAt: null, planLabel: null, source: 'env' };
};

/**
 * First credential a source can produce, in priority order, given the
 * credentials OpenCode stores (`auth`).
 *
 * The Keychain wins over the credentials file because on macOS the file is a
 * leftover that Claude Code no longer updates.
 *
 * @returns {ClaudeCredential|null}
 */
export const findClaudeCredential = (auth) =>
  readKeychainCredential()
  ?? readCredentialsFile()
  ?? readOpenCodeCredential(auth)
  ?? readEnvCredential();

/**
 * Same order as `findClaudeCredential`; OpenCode is asked only when the
 * local Claude Code sources have nothing.
 *
 * @returns {Promise<ClaudeCredential|null>}
 */
export const loadClaudeCredential = async () =>
  readKeychainCredential()
  ?? readCredentialsFile()
  ?? readOpenCodeCredential(await readOpenCodeCredentials())
  ?? readEnvCredential();
