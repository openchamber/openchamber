/**
 * Google Provider - Auth
 *
 * Authentication resolution logic for Google quota providers.
 * @module quota/providers/google/auth
 */

import {
  getAuthEntry,
  normalizeAuthEntry,
  asObject,
  asNonEmptyString,
  toTimestamp
} from '../../utils/index.js';
import { parseGoogleRefreshToken } from './transforms.js';

const GEMINI_GOOGLE_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_GOOGLE_CLIENT_SECRET = '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';
export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const resolveGoogleOAuthClient = () => ({
  clientId: GEMINI_GOOGLE_CLIENT_ID,
  clientSecret: GEMINI_GOOGLE_CLIENT_SECRET
});

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

export const resolveGoogleAuthSources = (auth) => {
  const sources = [];

  const geminiAuth = resolveGeminiCliAuth(auth);
  if (geminiAuth) {
    sources.push(geminiAuth);
  }

  return sources;
};
