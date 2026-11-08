import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  asNonEmptyString,
  buildResult,
  getAuthEntry,
  normalizeAuthEntry,
} from '../utils/index.js';
import { fetchOpenCodeZenUsage } from './opencode-zen.js';
export { parseConsoleSummary, parseConsoleBudget, parseConsoleModelUsage } from './opencode-zen.js';

export const providerId = 'opencode';
export const providerName = 'OpenCode Zen';

const CONSOLE_SERVER = 'https://opencode.ai/console';
const CONSOLE_INTEGRATION_ID = 'opencode';
const ORGANIZATION_ID_PATTERN = /^(?:org|wrk)_[A-Za-z0-9]+$/;

const readKey = (entry) => asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, [CONSOLE_INTEGRATION_ID]));
  if (!entry || entry.type === 'oauth') return null;
  const key = readKey(entry);
  return key ? { apiKey: key } : null;
};

const getConsoleCredential = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, [CONSOLE_INTEGRATION_ID]));
  if (!entry || entry.type !== 'oauth') return null;
  const access = asNonEmptyString(entry.access);
  const orgID = asNonEmptyString(entry.orgID);
  if (!access || entry.server !== CONSOLE_SERVER || !orgID || !ORGANIZATION_ID_PATTERN.test(orgID)) return null;
  return { accessToken: access, orgID };
};

export const isConfigured = (auth) => Boolean(getConsoleCredential(auth) || getApiKey(auth));

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch } = {}) => {
  try {
    const auth = await readAuth();
    const credential = getConsoleCredential(auth) ?? getApiKey(auth);
    if (!credential) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
    }

    const { windows, models } = await fetchOpenCodeZenUsage(credential, fetchImpl);

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows, models: Object.keys(models).length ? models : undefined },
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};
