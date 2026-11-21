
import {
  getAuthEntry,
  normalizeAuthEntry,
  asObject,
  asNonEmptyString,
  toTimestamp
} from '../../utils/index.js';
import { parseGoogleRefreshToken } from './transforms.js';
import type { JsonObject } from '../../utils/contracts.js';

const DIRECT_GOOGLE_LOGIN_METHODS = new Set(['oauth', 'gemini-cli']);

export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export interface GoogleAuthSource {
  sourceId: 'gemini';
  sourceLabel: 'Gemini';
  accessToken: string | null;
  refreshToken: string | null;
  projectId: string | null;
  expires: number | null;
}

const resolveGeminiCliAuth = (auth: JsonObject): GoogleAuthSource | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['google', 'google.oauth']));
  const entryObject = asObject(entry);
  if (!entryObject) {
    return null;
  }

  const oauthObject = asObject('oauth' in entryObject ? entryObject.oauth : undefined) ?? entryObject;
  if ('methodID' in oauthObject && oauthObject.methodID !== undefined && !DIRECT_GOOGLE_LOGIN_METHODS.has(String(oauthObject.methodID))) return null;
  const accessToken = asNonEmptyString('access' in oauthObject ? oauthObject.access : undefined)
    ?? asNonEmptyString('token' in oauthObject ? oauthObject.token : undefined);
  const refreshParts = parseGoogleRefreshToken('refresh' in oauthObject ? oauthObject.refresh : undefined);

  if (!accessToken && !refreshParts.refreshToken) {
    return null;
  }

  return {
    sourceId: 'gemini',
    sourceLabel: 'Gemini',
    accessToken,
    refreshToken: refreshParts.refreshToken,
    projectId: refreshParts.projectId ?? refreshParts.managedProjectId,
    expires: toTimestamp('expires' in oauthObject ? oauthObject.expires : undefined)
  };
};

export const resolveGoogleAuthSources = (auth: JsonObject) => {
  const sources: GoogleAuthSource[] = [];

  const geminiAuth = resolveGeminiCliAuth(auth);
  if (geminiAuth) {
    sources.push(geminiAuth);
  }

  return sources;
};
