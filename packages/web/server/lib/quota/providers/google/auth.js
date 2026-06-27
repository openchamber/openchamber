/**
 * Google Provider - Auth
 *
 * Authentication resolution logic for Google quota providers.
 * @module quota/providers/google/auth
 */

import {
  ANTIGRAVITY_ACCOUNTS_PATHS,
  readJsonFile,
  getAuthEntry,
  normalizeAuthEntry,
  asObject,
  asNonEmptyString,
  toTimestamp
} from '../../utils/index.js';
import { readAuthFile } from '../../../opencode/auth.js';
import { parseGoogleRefreshToken } from './transforms.js';

const ANTIGRAVITY_GOOGLE_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_GOOGLE_CLIENT_SECRET = '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';
const GEMINI_GOOGLE_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_GOOGLE_CLIENT_SECRET = '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';
export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const resolveGoogleOAuthClient = (sourceId) => {
  if (sourceId === 'gemini') {
    return {
      clientId: GEMINI_GOOGLE_CLIENT_ID,
      clientSecret: GEMINI_GOOGLE_CLIENT_SECRET
    };
  }

  return {
    clientId: ANTIGRAVITY_GOOGLE_CLIENT_ID,
    clientSecret: ANTIGRAVITY_GOOGLE_CLIENT_SECRET
  };
};

const resolveGeminiCliAuth = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['google', 'google.oauth']));
  const entryObject = asObject(entry);
  if (!entryObject) {
    return null;
  }

  const oauthObject = asObject(entryObject.oauth) ?? entryObject;
  const accessToken = asNonEmptyString(oauthObject.access) ?? asNonEmptyString(oauthObject.token);
  const refreshParts = parseGoogleRefreshToken(oauthObject.refresh);

  if (!accessToken && !refreshParts.refreshToken) {
    return null;
  }

  return {
    sourceId: 'gemini',
    sourceLabel: 'Gemini',
    accessToken,
    refreshToken: refreshParts.refreshToken,
    projectId: refreshParts.projectId ?? refreshParts.managedProjectId,
    expires: toTimestamp(oauthObject.expires)
  };
};

// Resolve ALL antigravity accounts across every candidate file, deduped by
// email (first-seen wins, matching canonical byEmail merge order) and filtered
// to enabled accounts with a refresh token. Canonical loadAntigravityAccountsMerged
// returns one entry per email; we preserve that contract here so the provider
// emits a card PER account.
const resolveAntigravityAuth = () => {
  const byEmail = new Map();

  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    const data = readJsonFile(filePath);
    const accounts = data?.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      continue;
    }
    for (const account of accounts) {
      if (!account || account.enabled === false) continue;
      const refreshTokenRaw = asNonEmptyString(account.refreshToken);
      if (!refreshTokenRaw) continue;
      const email = asNonEmptyString(account.email);
      if (!email) continue;
      const key = email.toLowerCase();
      if (byEmail.has(key)) continue;
      const refreshParts = parseGoogleRefreshToken(refreshTokenRaw);
      byEmail.set(key, {
        sourceId: 'antigravity',
        sourceLabel: 'Antigravity',
        refreshToken: refreshParts.refreshToken,
        projectId: asNonEmptyString(account.projectId)
          ?? asNonEmptyString(account.managedProjectId)
          ?? refreshParts.projectId
          ?? refreshParts.managedProjectId,
        email
      });
    }
  }

  return [...byEmail.values()];
};

export const resolveGoogleAuthSources = () => {
  const auth = readAuthFile();
  const sources = [];

  const geminiAuth = resolveGeminiCliAuth(auth);
  if (geminiAuth) {
    sources.push(geminiAuth);
  }

  for (const antigravityAuth of resolveAntigravityAuth()) {
    sources.push(antigravityAuth);
  }

  return sources;
};
