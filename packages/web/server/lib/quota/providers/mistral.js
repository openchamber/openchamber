import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { buildResult, getAuthEntry, normalizeAuthEntry } from '../utils/index.js';
import { fetchMistralUsage } from './mistral-billing.js';

export const providerId = 'mistral';
export const providerName = 'Mistral';
const aliases = ['mistral'];

const apiKeyOf = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return entry?.key ?? entry?.token ?? null;
};

export const isConfigured = (auth) => Boolean(apiKeyOf(auth));

export const fetchQuota = async () => {
  const apiKey = apiKeyOf(await readOpenCodeCredentials());
  if (!apiKey) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  }

  try {
    const { windows, planLabel } = await fetchMistralUsage(apiKey);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows }, planLabel });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
