/**
 * Read/write Claude Code CLI subscription OAuth credentials for Usage probes.
 * Never log or return credential file contents beyond the token fields needed
 * for Anthropic usage / refresh requests.
 *
 * Resolution order:
 * 1. `CLAUDE_CODE_OAUTH_TOKEN` env (Cursor Use Environment / CI secrets)
 * 2. Credentials files under `CLAUDE_CONFIG_DIR` or `$HOME/.claude` / `.config/claude`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Non-empty `CLAUDE_CODE_OAUTH_TOKEN` from env (subscription OAuth for automated hosts).
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function readClaudeCodeOAuthTokenFromEnv(env = process.env) {
  const value = env?.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @param {string} [homeDir]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function listClaudeCredentialsCandidates(homeDir = os.homedir(), env = process.env) {
  const candidates = [];
  const configDir = typeof env?.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (configDir) {
    candidates.push(path.join(configDir, '.credentials.json'));
    candidates.push(path.join(configDir, 'credentials.json'));
  }
  candidates.push(
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json'),
    path.join(homeDir, '.config', 'claude', '.credentials.json'),
  );
  return candidates;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toExpiresAtMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

/**
 * Extract OAuth credential fields from a credentials JSON object.
 * Supports camelCase (current CLI) and snake_case variants.
 *
 * @param {unknown} parsed
 * @returns {{ accessToken: string, refreshToken: string | null, expiresAt: number | null } | null}
 */
export function extractClaudeOAuthCredentials(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const root = /** @type {Record<string, unknown>} */ (parsed);

  /** @type {Record<string, unknown> | null} */
  let block = null;
  if (root.claudeAiOauth && typeof root.claudeAiOauth === 'object') {
    block = /** @type {Record<string, unknown>} */ (root.claudeAiOauth);
  } else if (root.claude_ai_oauth && typeof root.claude_ai_oauth === 'object') {
    block = /** @type {Record<string, unknown>} */ (root.claude_ai_oauth);
  }
  if (!block) return null;

  const accessRaw = block.accessToken ?? block.access_token;
  if (typeof accessRaw !== 'string' || !accessRaw.trim()) return null;

  const refreshRaw = block.refreshToken ?? block.refresh_token;
  const refreshToken = typeof refreshRaw === 'string' && refreshRaw.trim()
    ? refreshRaw.trim()
    : null;
  const expiresAt = toExpiresAtMs(block.expiresAt ?? block.expires_at);

  return {
    accessToken: accessRaw.trim(),
    refreshToken,
    expiresAt,
  };
}

/**
 * Extract a non-empty OAuth access token from a credentials JSON object.
 *
 * @param {unknown} parsed
 * @returns {string | null}
 */
export function extractClaudeOAuthAccessToken(parsed) {
  return extractClaudeOAuthCredentials(parsed)?.accessToken ?? null;
}

/**
 * @param {{
 *   homeDir?: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 * }} [options]
 * @returns {{
 *   accessToken: string,
 *   refreshToken: string | null,
 *   expiresAt: number | null,
 *   source: 'env' | 'file',
 *   credentialsPath: string | null,
 * } | null}
 */
export function readClaudeCliOAuthCredentials(options = {}) {
  const env = options.env || process.env;
  const fromEnv = readClaudeCodeOAuthTokenFromEnv(env);
  if (fromEnv) {
    return {
      accessToken: fromEnv,
      refreshToken: null,
      expiresAt: null,
      source: 'env',
      credentialsPath: null,
    };
  }

  const homeDir = options.homeDir || os.homedir();
  const readFile = options.readFile || ((filePath, encoding) => fs.readFileSync(filePath, encoding));
  const existsSync = options.existsSync || ((filePath) => fs.existsSync(filePath));

  for (const candidate of listClaudeCredentialsCandidates(homeDir, env)) {
    try {
      if (!existsSync(candidate)) continue;
      const raw = readFile(candidate, 'utf8');
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const parsed = JSON.parse(raw);
      const creds = extractClaudeOAuthCredentials(parsed);
      if (!creds) continue;
      return {
        ...creds,
        source: 'file',
        credentialsPath: candidate,
      };
    } catch {
      // continue — malformed / unreadable files are not authoritative success
    }
  }

  return null;
}

/**
 * @param {{
 *   homeDir?: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 * }} [options]
 * @returns {string | null}
 */
export function readClaudeCliOAuthAccessToken(options = {}) {
  return readClaudeCliOAuthCredentials(options)?.accessToken ?? null;
}

/**
 * Persist refreshed Claude CLI OAuth tokens into an existing credentials file.
 * Preserves unrelated fields and the existing oauth block key style.
 *
 * @param {string} filePath
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} tokens
 * @param {{
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   writeFile?: (path: string, data: string, options?: fs.WriteFileOptions) => void,
 *   renameSync?: (from: string, to: string) => void,
 *   existsSync?: (path: string) => boolean,
 *   chmodSync?: (path: string, mode: number) => void,
 * }} [options]
 */
export function writeClaudeCliOAuthCredentials(filePath, tokens, options = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Claude credentials path is required');
  }
  if (!tokens?.accessToken || !tokens?.refreshToken || typeof tokens.expiresAt !== 'number') {
    throw new Error('Claude credentials update is incomplete');
  }

  const readFile = options.readFile || ((target, encoding) => fs.readFileSync(target, encoding));
  const writeFile = options.writeFile || ((target, data, writeOptions) => fs.writeFileSync(target, data, writeOptions));
  const renameSync = options.renameSync || ((from, to) => fs.renameSync(from, to));
  const existsSync = options.existsSync || ((target) => fs.existsSync(target));
  const chmodSync = options.chmodSync || ((target, mode) => fs.chmodSync(target, mode));

  /** @type {Record<string, unknown>} */
  let root = {};
  if (existsSync(filePath)) {
    try {
      const raw = readFile(filePath, 'utf8');
      if (typeof raw === 'string' && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          root = /** @type {Record<string, unknown>} */ (parsed);
        }
      }
    } catch {
      root = {};
    }
  }

  const useSnake = Boolean(root.claude_ai_oauth) && !root.claudeAiOauth;
  const previous = useSnake
    ? (root.claude_ai_oauth && typeof root.claude_ai_oauth === 'object'
      ? /** @type {Record<string, unknown>} */ (root.claude_ai_oauth)
      : {})
    : (root.claudeAiOauth && typeof root.claudeAiOauth === 'object'
      ? /** @type {Record<string, unknown>} */ (root.claudeAiOauth)
      : {});

  const nextBlock = useSnake
    ? {
        ...previous,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt,
      }
    : {
        ...previous,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      };

  const nextRoot = useSnake
    ? { ...root, claude_ai_oauth: nextBlock }
    : { ...root, claudeAiOauth: nextBlock };

  const tempPath = `${filePath}.openchamber.tmp`;
  writeFile(tempPath, `${JSON.stringify(nextRoot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tempPath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
  renameSync(tempPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * True when a Claude CLI credentials file or `CLAUDE_CODE_OAUTH_TOKEN` contains
 * a non-empty OAuth access token. Does not return or log the token.
 *
 * @param {{
 *   homeDir?: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 * }} [options]
 * @returns {boolean}
 */
export function hasClaudeCliOAuthCredentials(options = {}) {
  return Boolean(readClaudeCliOAuthAccessToken(options));
}
