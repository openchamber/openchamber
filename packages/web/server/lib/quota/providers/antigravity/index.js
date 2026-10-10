/**
 * Antigravity Quota Provider
 *
 * Dedicated quota provider for Google Cloud Code Antigravity IDE and proxy tools.
 * Supports dual-layer quotas: 5-Hour rolling limits and 7-Day weekly limits.
 * @module quota/providers/antigravity
 */

import { buildResult } from '../../utils/index.js';
import { resolveAntigravityAuth, isConfigured, DEFAULT_PROJECT_ID } from './auth.js';
import {
  refreshAntigravityToken,
  fetchAntigravityModels,
  fetchAntigravityQuotaSummary
} from './api.js';
import { transformSummary, transformModels } from './transforms.js';

export { resolveAntigravityAuth, isConfigured } from './auth.js';

export const providerId = 'antigravity';
export const providerName = 'Antigravity';
export const aliases = ['antigravity', 'antigravity-manager'];

export const fetchQuota = async () => {
  const auth = resolveAntigravityAuth();
  if (!auth) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const accessToken = await refreshAntigravityToken(auth.refreshToken);
  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'Failed to refresh Antigravity token'
    });
  }

  const projectId = auth.projectId ?? DEFAULT_PROJECT_ID;

  const [summaryPayload, modelsPayload] = await Promise.all([
    fetchAntigravityQuotaSummary(accessToken, projectId),
    fetchAntigravityModels(accessToken, projectId)
  ]);

  const { modelGroupWindows } = transformSummary(summaryPayload);
  const models = transformModels(modelsPayload, modelGroupWindows);

  if (!Object.keys(models).length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'Failed to fetch Antigravity quota'
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: {
      windows: {},
      models: Object.keys(models).length ? models : undefined
    }
  });
};
