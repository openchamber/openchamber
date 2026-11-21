
import { execFileSync } from 'child_process';
import { createHash } from 'node:crypto';
import os from 'os';
import path from 'path';

import { readOpenCodeCredentials } from '../../../opencode/auth.js';
import type { LegacyAuthFile } from '../../../opencode/auth.js';
import { asNonEmptyString, normalizeTimestamp, getAuthEntry, normalizeAuthEntry, readJsonFile } from '../../utils/index.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OPENCODE_AUTH_ALIASES = ['anthropic', 'claude'];

export interface ClaudeCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  planLabel: string | null;
  source: 'keychain' | 'credentials-file' | 'opencode-auth' | 'env';
}

interface ClaudeCodeBlob {
  claudeAiOauth?: unknown;
}

interface ClaudeOAuthFields {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  subscriptionType?: unknown;
}

interface OpenCodeAuthFields {
  access?: unknown;
  token?: unknown;
  refresh?: unknown;
  expires?: unknown;
}

const isCredentialBlob = (value: unknown): value is ClaudeCodeBlob =>
  value !== null && typeof value === 'object';

const isOAuthFields = (value: unknown): value is ClaudeOAuthFields =>
  value !== null && typeof value === 'object';

type ClaudeCredentialEnvironment = { CLAUDE_CONFIG_DIR?: string | undefined };
export type ClaudeCredentialContext =
  | { configDir: string | null; error: null }
  | { configDir: null; error: string };

let readEnvironment: () => ClaudeCredentialEnvironment = () => process.env;

export const configureClaudeCredentialEnvironment = (read: typeof readEnvironment) => {
  readEnvironment = read;
};

export const readClaudeCredentialContext = (): ClaudeCredentialContext => {
  try {
    return { configDir: readEnvironment().CLAUDE_CONFIG_DIR || null, error: null };
  } catch {
    return { configDir: null, error: 'Cannot read Claude usage environment settings.' };
  }
};

const parseClaudeCodeBlob = (blob: ClaudeCodeBlob | null, source: ClaudeCredential['source']): ClaudeCredential | null => {
  const oauth = isOAuthFields(blob?.claudeAiOauth) ? blob.claudeAiOauth : null;
  const accessToken = asNonEmptyString(oauth?.accessToken);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: asNonEmptyString(oauth?.refreshToken),
    expiresAt: normalizeTimestamp(oauth?.expiresAt),
    planLabel: asNonEmptyString(oauth?.subscriptionType),
    source
  };
};

const readKeychainCredential = (configDir: string | null) => {
  if (process.platform !== 'darwin') return null;
  let raw;
  try {
    const service = configDir
      ? `${KEYCHAIN_SERVICE}-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
      : KEYCHAIN_SERVICE;
    raw = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }
  try {
    const blob: unknown = JSON.parse(raw.trim());
    return parseClaudeCodeBlob(isCredentialBlob(blob) ? blob : null, 'keychain');
  } catch {
    console.warn('Claude quota: Keychain credentials are not valid JSON');
    return null;
  }
};

const readCredentialsFile = (configDir: string | null) => {
  const blob: unknown = readJsonFile(path.join(configDir ?? path.join(os.homedir(), '.claude'), '.credentials.json'));
  return parseClaudeCodeBlob(isCredentialBlob(blob) ? blob : null, 'credentials-file');
};

const readOpenCodeCredential = (auth: LegacyAuthFile): ClaudeCredential | null => {
  const entry: OpenCodeAuthFields | null = normalizeAuthEntry(getAuthEntry(auth, OPENCODE_AUTH_ALIASES));
  const accessToken = asNonEmptyString(entry?.access) ?? asNonEmptyString(entry?.token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: asNonEmptyString(entry?.refresh),
    expiresAt: normalizeTimestamp(entry?.expires),
    planLabel: null,
    source: 'opencode-auth'
  };
};

const readEnvCredential = (): ClaudeCredential | null => {
  const accessToken = asNonEmptyString(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!accessToken) return null;
  return { accessToken, refreshToken: null, expiresAt: null, planLabel: null, source: 'env' };
};

export const findClaudeCredential = (auth: LegacyAuthFile, context = readClaudeCredentialContext()): ClaudeCredential | null => {
  if (context.error) return null;
  const local = readKeychainCredential(context.configDir) ?? readCredentialsFile(context.configDir);
  if (local || context.configDir) return local;
  return readOpenCodeCredential(auth) ?? readEnvCredential();
};

export const loadClaudeCredential = async (context = readClaudeCredentialContext()): Promise<ClaudeCredential | null> => {
  if (context.error) return null;
  const local = readKeychainCredential(context.configDir) ?? readCredentialsFile(context.configDir);
  if (local || context.configDir) return local;
  return readOpenCodeCredential(await readOpenCodeCredentials()) ?? readEnvCredential();
};
