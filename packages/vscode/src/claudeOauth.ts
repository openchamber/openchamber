/**
 * Claude subscription OAuth access for VS Code Usage probes.
 * Mirrors packages/web/server/lib/quota/providers/claude-oauth.js + claude-cli-auth.js.
 * Never logs token values.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

/** Public Claude Code / OpenCode Anthropic OAuth client id (not a secret). */
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OPENCODE_CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CLI_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_SESSION_EXPIRED_ERROR = 'Session expired — please re-authenticate with Claude';

const AUTH_ALIASES = ['anthropic', 'claude'] as const;
const REFRESH_BUFFER_MS = 60_000;

type AuthFile = Record<string, Record<string, unknown>>;

export type ClaudeUsageCredential = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  source: 'env' | 'claude-cli' | 'opencode-auth';
  tokenUrl: string | null;
  authKey?: string;
  credentialsPath?: string;
};

export type ClaudeUsageAccess = {
  accessToken: string;
  source: ClaudeUsageCredential['source'];
  canRefresh: boolean;
};

let claudeRefreshPromise: Promise<ClaudeUsageAccess> | null = null;

const readAuthFile = (): AuthFile => {
  if (!fs.existsSync(AUTH_FILE)) return {};
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed) as AuthFile;
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
};

const writeAuthFile = (auth: AuthFile): void => {
  if (!fs.existsSync(OPENCODE_DATA_DIR)) {
    fs.mkdirSync(OPENCODE_DATA_DIR, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(OPENCODE_DATA_DIR, 0o700); } catch { /* best-effort */ }
  }
  if (fs.existsSync(AUTH_FILE)) {
    const backupFile = `${AUTH_FILE}.openchamber.backup`;
    fs.copyFileSync(AUTH_FILE, backupFile);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(backupFile, 0o600); } catch { /* best-effort */ }
    }
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(AUTH_FILE, 0o600); } catch { /* best-effort */ }
  }
};

const listClaudeCredentialsCandidates = (
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string[] => {
  const candidates: string[] = [];
  const configDir = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
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
};

const toExpiresAtMs = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const extractClaudeOAuthCredentials = (parsed: unknown): {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
} | null => {
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  const block = (root.claudeAiOauth && typeof root.claudeAiOauth === 'object'
    ? root.claudeAiOauth
    : root.claude_ai_oauth && typeof root.claude_ai_oauth === 'object'
      ? root.claude_ai_oauth
      : null) as Record<string, unknown> | null;
  if (!block) return null;

  const accessRaw = block.accessToken ?? block.access_token;
  if (typeof accessRaw !== 'string' || !accessRaw.trim()) return null;
  const refreshRaw = block.refreshToken ?? block.refresh_token;
  return {
    accessToken: accessRaw.trim(),
    refreshToken: typeof refreshRaw === 'string' && refreshRaw.trim() ? refreshRaw.trim() : null,
    expiresAt: toExpiresAtMs(block.expiresAt ?? block.expires_at),
  };
};

const writeClaudeCliOAuthCredentials = (
  filePath: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
): void => {
  let root: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') root = parsed as Record<string, unknown>;
      }
    } catch {
      root = {};
    }
  }

  const useSnake = Boolean(root.claude_ai_oauth) && !root.claudeAiOauth;
  const previous = (useSnake
    ? root.claude_ai_oauth
    : root.claudeAiOauth) as Record<string, unknown> | undefined;
  const base = previous && typeof previous === 'object' ? previous : {};
  const nextBlock = useSnake
    ? {
        ...base,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt,
      }
    : {
        ...base,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      };
  const nextRoot = useSnake
    ? { ...root, claude_ai_oauth: nextBlock }
    : { ...root, claudeAiOauth: nextBlock };

  const tempPath = `${filePath}.openchamber.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(nextRoot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(tempPath, 0o600); } catch { /* best-effort */ }
  }
  fs.renameSync(tempPath, filePath);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  }
};

const isClaudeAccessExpired = (expiresAt: number | null | undefined, now = Date.now()): boolean => {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return expiresAt - REFRESH_BUFFER_MS <= now;
};

const resolveClaudeUsageCredential = (): ClaudeUsageCredential | null => {
  const envToken = typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === 'string'
    ? process.env.CLAUDE_CODE_OAUTH_TOKEN.trim()
    : '';
  if (envToken) {
    return {
      accessToken: envToken,
      refreshToken: null,
      expiresAt: null,
      source: 'env',
      tokenUrl: null,
    };
  }

  for (const candidate of listClaudeCredentialsCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      if (!raw.trim()) continue;
      const creds = extractClaudeOAuthCredentials(JSON.parse(raw));
      if (!creds) continue;
      return {
        ...creds,
        source: 'claude-cli',
        tokenUrl: CLAUDE_CLI_TOKEN_URL,
        credentialsPath: candidate,
      };
    } catch {
      // continue
    }
  }

  const auth = readAuthFile();
  for (const alias of AUTH_ALIASES) {
    const entry = auth[alias];
    if (!entry || typeof entry !== 'object') continue;
    const access = typeof entry.access === 'string' && entry.access.trim()
      ? entry.access.trim()
      : typeof entry.token === 'string' && entry.token.trim()
        ? entry.token.trim()
        : null;
    if (!access) continue;
    const refresh = typeof entry.refresh === 'string' && entry.refresh.trim()
      ? entry.refresh.trim()
      : null;
    return {
      accessToken: access,
      refreshToken: refresh,
      expiresAt: toExpiresAtMs(entry.expires),
      source: 'opencode-auth',
      tokenUrl: OPENCODE_CLAUDE_TOKEN_URL,
      authKey: alias,
    };
  }

  return null;
};

const refreshClaudeOAuthToken = async (input: {
  refreshToken: string;
  tokenUrl: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> => {
  const response = await fetch(input.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'anthropic-beta': CLAUDE_OAUTH_BETA,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Claude token refresh failed: ${response.status}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('Claude token refresh returned no access token');
  }
  const refreshToken = typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : input.refreshToken;
  const expiresIn = Number(payload.expires_in);
  const expiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
  return { accessToken, refreshToken, expiresAt };
};

const persistRefreshedCredential = (
  credential: ClaudeUsageCredential,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
): void => {
  if (credential.source === 'claude-cli' && credential.credentialsPath) {
    writeClaudeCliOAuthCredentials(credential.credentialsPath, tokens);
    return;
  }
  if (credential.source === 'opencode-auth' && credential.authKey) {
    const auth = readAuthFile();
    const previous = auth[credential.authKey] || {};
    auth[credential.authKey] = {
      ...previous,
      type: 'oauth',
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: tokens.expiresAt,
    };
    writeAuthFile(auth);
  }
};

export const ensureClaudeUsageAccessToken = async (options: {
  forceRefresh?: boolean;
} = {}): Promise<ClaudeUsageAccess | null> => {
  const forceRefresh = Boolean(options.forceRefresh);
  const credential = resolveClaudeUsageCredential();
  if (!credential) return null;

  const canRefresh = Boolean(credential.refreshToken && credential.tokenUrl);
  const needsRefresh = forceRefresh
    || !credential.accessToken
    || isClaudeAccessExpired(credential.expiresAt);

  if (!needsRefresh) {
    return { accessToken: credential.accessToken, source: credential.source, canRefresh };
  }

  if (!canRefresh || !credential.refreshToken || !credential.tokenUrl) {
    return credential.accessToken
      ? { accessToken: credential.accessToken, source: credential.source, canRefresh: false }
      : null;
  }

  if (!claudeRefreshPromise) {
    claudeRefreshPromise = (async () => {
      const latest = resolveClaudeUsageCredential() || credential;
      if (!forceRefresh && latest.accessToken && !isClaudeAccessExpired(latest.expiresAt)) {
        return {
          accessToken: latest.accessToken,
          source: latest.source,
          canRefresh: Boolean(latest.refreshToken && latest.tokenUrl),
        };
      }

      const refreshToken = latest.refreshToken || credential.refreshToken;
      const tokenUrl = latest.tokenUrl || credential.tokenUrl;
      if (!refreshToken || !tokenUrl) {
        throw new Error('Claude OAuth entry has no refresh token');
      }

      const tokens = await refreshClaudeOAuthToken({ refreshToken, tokenUrl });
      persistRefreshedCredential({ ...latest, refreshToken, tokenUrl }, tokens);
      return {
        accessToken: tokens.accessToken,
        source: latest.source,
        canRefresh: true,
      };
    })().finally(() => {
      claudeRefreshPromise = null;
    });
  }

  return claudeRefreshPromise;
};

export const fetchClaudeUsagePayload = async (accessToken: string): Promise<Response> => {
  return fetch(CLAUDE_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': CLAUDE_OAUTH_BETA,
    },
    signal: AbortSignal.timeout(30_000),
  });
};
